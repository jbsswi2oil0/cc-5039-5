// The replay timeline.
//
// Three independent notions are tracked separately and never conflated:
//
//   sequence   - the upstream MEDIA-SEQUENCE number of a segment
//   playback   - position on the kernel's own axis of playable time
//   declaredAt - PROGRAM-DATE-TIME / source-declared wall-clock date
//
// Playback time is accumulated only from declared segment durations, and only
// forward: evicting the left edge never renumbers the segments that remain, so
// a replay position stays stable for as long as its segment is available.
// Sequence numbers never contribute to time, and declared dates are metadata
// only, so a stale PDT cannot fabricate absolute capture time.
//
// A discontinuity (or an upstream sequence reset) opens a new run: the run gets
// a new identity and starts `gapSeconds` after the previous run instead of
// inheriting a naive sum of everything seen before.
//
// The window only moves forward. Evicted sequences become tombstones; requests
// for them fail explicitly with a relocation hint rather than fetching a
// segment that no longer exists.

export class WindowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowError';
    this.code = code;
    Object.assign(this, details);
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export class ReplayTimeline {
  constructor({ gapSeconds = 0, retainSeconds = 60 } = {}) {
    this.gapSeconds = gapSeconds;
    this.retainSeconds = retainSeconds;
    this.reset();
  }

  reset() {
    this.epoch = 0;
    this.lastMediaSequence = -1;
    this.lastPlaylistSequence = -1;
    this.entryBySequence = new Map();
    this.live = [];
    this.evicted = new Map();
    this.tombstones = [];
    this.runs = [];
    this.playbackCursor = 0;
    this.expectedDiscontinuitySequence = null;
    this.pendingDiscontinuity = false;
    this.lastConfirmedAt = null;
    this.lastPlaylistFetchedAt = null;
    this.lastError = null;
    this.generation = 0;
  }

  // ---- ingest -------------------------------------------------------------

  applyPlaylist(playlist, { fetchedAt = Date.now() } = {}) {
    // A live origin advertises a sliding suffix: MEDIA-SEQUENCE advances as
    // old segments drop off the front. Only a *backwards* move is a reset.
    let reset = false;
    if (this.lastMediaSequence !== -1 && playlist.mediaSequence < this.lastMediaSequence) {
      this.handleSequenceReset(playlist, fetchedAt);
      reset = true;
    }

    // Sequence numbers are opaque and may jump forward. Within one playlist
    // the sequence of an entry is authoritative; when a number is reused by a
    // later playlist after having been assigned to different content, the
    // earlier mapping is retired rather than silently aliased.
    let added = 0;
    const seen = new Set();
    for (const seg of playlist.segments) {
      if (seen.has(seg.sequence)) {
        throw new WindowError('DUPLICATE_SEQUENCE', `playlist repeats sequence ${seg.sequence}`);
      }
      seen.add(seg.sequence);
      const existing = this.entryBySequence.get(seg.sequence);
      if (existing) {
        if (existing.uri === seg.uri) {
          this.reconcile(seg);
          continue;
        }
        this.evict(existing.sequence, 'sequence-reused');
        this.entryBySequence.delete(seg.sequence);
      }
      if (seg.sequence < playlist.mediaSequence) continue;
      const entry = this.materialize(seg);
      if (entry) added += 1;
    }

    // Segments that were live but are no longer advertised have rolled out of
    // the upstream window and must not be requested again.
    const present = new Set(playlist.segments.map((s) => s.sequence));
    let rolledOut = 0;
    for (const entry of [...this.live]) {
      if (!present.has(entry.sequence)) {
        this.evict(entry.sequence, reset ? 'upstream-reset' : 'upstream-rollout');
        rolledOut += 1;
      }
    }

    this.lastMediaSequence = playlist.mediaSequence;
    if (playlist.segments.length > 0) {
      this.lastPlaylistSequence = Math.max(
        this.lastPlaylistSequence,
        ...playlist.segments.map((s) => s.sequence),
      );
    }
    this.lastPlaylistFetchedAt = fetchedAt;
    this.lastConfirmedAt = fetchedAt;
    this.lastError = null;
    this.advanceLeftEdge();
    this.generation += 1;
    return { added, evicted: rolledOut, reset };
  }

  // A renumbered upstream cannot extend the old axis: every old segment is
  // retired and the next segment opens a new run. The playback cursor is kept
  // so the window continues forward instead of rewinding.
  handleSequenceReset(playlist, fetchedAt) {
    const oldEpoch = this.epoch;
    for (const entry of [...this.live]) {
      this.evict(entry.sequence, 'sequence-reset');
    }
    this.entryBySequence.clear();
    this.epoch = oldEpoch + 1;
    this.lastMediaSequence = -1;
    this.lastPlaylistSequence = -1;
    this.pendingDiscontinuity = true;
    this.resetBoundary = {
      epoch: this.epoch,
      at: fetchedAt,
      newMediaSequence: playlist.mediaSequence,
      playbackAtReset: this.playbackCursor,
    };
  }

  reconcile(seg) {
    const entry = this.entryBySequence.get(seg.sequence);
    if (!entry) return;
    entry.duration = seg.duration;
    entry.declaredPdt = seg.declaredPdt;
    entry.frameRange = seg.frameRange ?? entry.frameRange;
    if (seg.gap) entry.gap = true;
  }

  materialize(seg) {
    const opensRun =
      this.live.length === 0 ||
      seg.discontinuity ||
      this.pendingDiscontinuity ||
      seg.discontinuitySequence !== this.expectedDiscontinuitySequence;

    let run;
    if (opensRun) {
      const start = this.live.length === 0 && this.runs.length === 0
        ? 0
        : this.playbackCursor + this.gapSeconds;
      run = {
        runId: `r${this.epoch}.${this.runs.length}`,
        discontinuitySequence: seg.discontinuitySequence,
        epoch: this.epoch,
        playbackStart: round3(start),
        playbackEnd: round3(start),
        opensWithSequence: seg.sequence,
      };
      this.runs.push(run);
      this.playbackCursor = start;
      this.pendingDiscontinuity = false;
      this.expectedDiscontinuitySequence = seg.discontinuitySequence;
    } else {
      run = this.runs.at(-1);
    }

    const entry = {
      sequence: seg.sequence,
      epoch: this.epoch,
      discontinuitySequence: seg.discontinuitySequence,
      discontinuity: opensRun,
      duration: seg.duration,
      declaredPdt: seg.declaredPdt,
      frameRange: seg.frameRange ?? null,
      gap: seg.gap,
      uri: seg.uri,
      initUri: seg.init?.uri ?? null,
      runId: run.runId,
      playbackStart: round3(this.playbackCursor),
      playbackEnd: round3(this.playbackCursor + seg.duration),
      status: seg.gap ? 'gap' : 'available',
    };
    this.playbackCursor = entry.playbackEnd;
    this.expectedDiscontinuitySequence = seg.discontinuitySequence;
    if (run.opensWithSequence === seg.sequence) {
      run.playbackStart = entry.playbackStart;
    }
    run.playbackEnd = entry.playbackEnd;
    this.entryBySequence.set(seg.sequence, entry);
    this.live.push(entry);
    this.live.sort((a, b) => a.sequence - b.sequence);
    return entry;
  }

  advanceLeftEdge() {
    if (this.live.length <= 1) return;
    const rightmost = Math.max(...this.live.map((e) => e.playbackEnd));
    const cutoff = rightmost - this.retainSeconds;
    while (this.live.length > 1 && this.live[0].playbackEnd <= cutoff) {
      this.evict(this.live[0].sequence, 'window-rollout');
    }
  }

  evict(sequence, reason) {
    const index = this.live.findIndex((e) => e.sequence === sequence);
    if (index === -1) return;
    const [entry] = this.live.splice(index, 1);
    entry.status = 'evicted';
    const info = {
      epoch: entry.epoch,
      playbackStart: entry.playbackStart,
      playbackEnd: entry.playbackEnd,
      runId: entry.runId,
      reason,
    };
    this.evicted.set(`${entry.epoch}:${sequence}`, { sequence, ...info });
    this.tombstones.push({ sequence, ...info });
    this.generation += 1;
  }

  notePlaylistFailure(error, { at = Date.now() } = {}) {
    this.lastError = { message: String(error?.message ?? error), at };
    this.lastPlaylistFetchedAt = null;
  }

  // ---- queries ------------------------------------------------------------

  get window() {
    if (this.live.length === 0) {
      return { start: null, end: null, runs: [], segments: [] };
    }
    return {
      start: this.live[0].playbackStart,
      end: this.live.at(-1).playbackEnd,
      runs: this.runs
        .filter((r) => this.live.some((e) => e.runId === r.runId))
        .map((r) => ({ ...r })),
      segments: this.live.map((e) => this.describe(e)),
    };
  }

  get freshness() {
    if (this.lastPlaylistFetchedAt === null) {
      return {
        fresh: false,
        staleSeconds: null,
        lastConfirmedAt: this.lastConfirmedAt,
        lastError: this.lastError,
      };
    }
    return {
      fresh: true,
      staleSeconds: round3((Date.now() - this.lastPlaylistFetchedAt) / 1000),
      lastConfirmedAt: this.lastConfirmedAt,
      lastError: null,
    };
  }

  describe(entry) {
    return {
      sequence: entry.sequence,
      epoch: entry.epoch,
      runId: entry.runId,
      discontinuitySequence: entry.discontinuitySequence,
      discontinuity: entry.discontinuity,
      playbackStart: entry.playbackStart,
      playbackEnd: entry.playbackEnd,
      duration: entry.duration,
      declaredPdt: entry.declaredPdt,
      frameRange: entry.frameRange,
      status: entry.status,
      gap: entry.gap,
    };
  }

  resolveSequence(sequence) {
    const entry = this.entryBySequence.get(sequence);
    if (!entry) {
      throw new WindowError('UNKNOWN_SEQUENCE', `sequence ${sequence} is not in the current epoch`);
    }
    if (entry.status === 'evicted') {
      throw new WindowError('EVICTED', `sequence ${sequence} has been evicted`, {
        requestedSequence: sequence,
        evictedRange: { start: entry.playbackStart, end: entry.playbackEnd, runId: entry.runId },
        relocatedTo: this.live[0]?.playbackStart ?? null,
        relocatedSequence: this.live[0]?.sequence ?? null,
        available: this.windowRange(),
      });
    }
    return entry;
  }

  resolvePlayback(playbackSeconds) {
    if (!Number.isFinite(playbackSeconds)) {
      throw new WindowError('INVALID_TIME', 'playback time must be finite');
    }
    const available = this.windowRange();
    if (this.live.length === 0) {
      throw new WindowError('EMPTY_WINDOW', 'no playable segments are currently available');
    }
    const first = this.live[0];
    const last = this.live.at(-1);
    if (playbackSeconds < first.playbackStart) {
      const tomb = [...this.tombstones]
        .filter((t) => t.playbackEnd !== null && t.playbackEnd > playbackSeconds)
        .sort((a, b) => b.playbackEnd - a.playbackEnd)[0];
      throw new WindowError(
        'EVICTED',
        `requested time ${playbackSeconds}s is before the available window`,
        {
          requested: playbackSeconds,
          available,
          relocatedTo: first.playbackStart,
          evictedRange: tomb
            ? { start: tomb.playbackStart, end: tomb.playbackEnd, sequence: tomb.sequence }
            : null,
        },
      );
    }
    if (playbackSeconds >= last.playbackEnd) {
      throw new WindowError(
        'AHEAD_OF_WINDOW',
        `requested time ${playbackSeconds}s is not yet available`,
        {
          requested: playbackSeconds,
          available,
          relocatedTo: round3(last.playbackEnd - 0.001),
        },
      );
    }
    const segment = this.live.find(
      (e) => playbackSeconds >= e.playbackStart && playbackSeconds < e.playbackEnd,
    );
    if (!segment) {
      const next = this.live.find((e) => e.playbackStart > playbackSeconds);
      return {
        status: 'hole',
        requested: playbackSeconds,
        segment: null,
        relocatedTo: next ? next.playbackStart : null,
        available,
      };
    }
    if (segment.gap) {
      const next = this.live.find((e) => e.sequence > segment.sequence);
      return {
        status: 'gap',
        requested: playbackSeconds,
        segment: null,
        relocatedTo: next ? next.playbackStart : segment.playbackEnd,
        gapRange: { start: segment.playbackStart, end: segment.playbackEnd },
        available,
      };
    }
    return {
      status: 'ok',
      requested: playbackSeconds,
      segment,
      offsetInSegment: round3(playbackSeconds - segment.playbackStart),
      available,
    };
  }

  windowRange() {
    if (this.live.length === 0) return { start: null, end: null };
    return { start: this.live[0].playbackStart, end: this.live.at(-1).playbackEnd };
  }

  snapshot() {
    return {
      window: this.window,
      freshness: this.freshness,
      epoch: this.epoch,
      resetBoundary: this.resetBoundary ?? null,
      evictedRanges: [...this.evicted.values()],
      lastPlaylistSequence: this.lastPlaylistSequence,
    };
  }
}

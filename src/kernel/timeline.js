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
//
// Index efficiency: `live` is kept in playback order, so segment lookup is a
// binary search (O(log n)) instead of a scan, and insertion is one ordered
// splice rather than a full re-sort. Historical bookkeeping (tombstones,
// evicted records, closed runs) is bounded: a long-running process cannot
// accumulate an index whose scans grow with total segments ever seen.
//
// Viewer position protection: a registered hold pins the left edge. Segments a
// viewer is still decoding are never evicted merely because the retention
// cutoff passed; once the hold is released or goes stale (older than
// holdTtlMs) the window catches up on the next ingest.

export class WindowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowError';
    this.code = code;
    Object.assign(this, details);
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// How much history to keep for relocation hints and the UI's dead-band. These
// are deliberately bounded: only the most recent evictions can ever be queried
// (a request far behind the window only needs the nearest one).
const MAX_TOMBSTONES = 256;
const MAX_EVICTED_ENTRIES = 512;

// Binary search for the last entry whose playbackStart is <= time. Entries are
// contiguous and ordered on the playback axis (gaps still occupy declared
// time), so the returned index is the segment covering `time` when time is in
// range. Returns -1 when time precedes every entry.
function findEntryIndexAt(entries, time) {
  let lo = 0;
  let hi = entries.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].playbackStart <= time) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

// Binary search over tombstones ordered by playbackEnd for the first one that
// ends after `time`. Returns null when none exists.
function findTombstoneAfter(tombstones, time) {
  let lo = 0;
  let hi = tombstones.length - 1;
  let answer = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tombstones[mid].playbackEnd > time) {
      answer = tombstones[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

export class ReplayTimeline {
  constructor({ gapSeconds = 0, retainSeconds = 60, holdTtlMs = 30_000 } = {}) {
    this.gapSeconds = gapSeconds;
    this.retainSeconds = retainSeconds;
    this.holdTtlMs = holdTtlMs;
    this.reset();
  }

  reset() {
    this.epoch = 0;
    this.lastMediaSequence = -1;
    this.lastPlaylistSequence = -1;
    // Highest DISCONTINUITY-SEQUENCE value the origin has advertised. An encoder
    // restart bumps this even when a large upstream window keeps the advertised
    // MEDIA-SEQUENCE pinned at 0, so it is a second, independent reset signal.
    this.lastDiscontinuitySequence = null;
    // Playback-ordered live entries. Sequence numbers may jump, so materialize()
    // inserts at the binary-searched position instead of appending, keeping the
    // array sorted for O(log n) playback-time lookups.
    this.live = [];
    // O(1) sequence lookup. Entries are deleted on eviction, so its size stays
    // proportional to the live window rather than total segments ever seen.
    this.entryBySequence = new Map();
    // Bounded memory of what a recently evicted sequence pointed at. The
    // baseline kept evicted entries in entryBySequence forever so a re-advertised
    // number with the same URI was recognised as already-known and skipped. This
    // map reproduces that decision without letting the index grow without bound;
    // a number reused for different content (different URI) is still rematerialised.
    this.recentEvictedUri = new Map();
    // Bounded relocation bookkeeping.
    this.evicted = new Map();
    // Sequence -> latest eviction record in the current epoch, giving
    // resolveSequence an O(1) relocation lookup instead of scanning `evicted`.
    this.evictedBySequence = new Map();
    this.tombstones = [];
    // Runs that still have a live segment. Closed runs are pruned when their
    // last segment leaves the window.
    this.runs = [];
    this.playbackCursor = 0;
    this.expectedDiscontinuitySequence = null;
    this.pendingDiscontinuity = false;
    this.lastConfirmedAt = null;
    this.lastPlaylistFetchedAt = null;
    this.lastError = null;
    this.generation = 0;
    this.evictedTotal = 0;
    // A viewer position the left edge must not pass while the hold is fresh.
    this.hold = null;
    this.stats = {
      ingests: 0,
      materialized: 0,
      evictions: 0,
      holdBlockedEvictions: 0,
      prunedTombstones: 0,
      prunedEvictedRecords: 0,
      prunedRuns: 0,
      resolvePlayback: { calls: 0, binarySearchSteps: 0, fullScans: 0, evictedHits: 0 },
      resolveSequence: { calls: 0, mapHits: 0, evictedHits: 0, unknown: 0 },
    };
  }

  // ---- ingest -------------------------------------------------------------

  applyPlaylist(playlist, { fetchedAt = Date.now() } = {}) {
    // A live origin advertises a sliding suffix: MEDIA-SEQUENCE advances as
    // old segments drop off the front. Only a *backwards* move is a reset.
    //
    // A large upstream window can keep MEDIA-SEQUENCE pinned (e.g. the origin
    // has fewer segments than its window, so the manifest always starts at 0),
    // which hides a renumber that restarts at zero. In that case an encoder
    // restart is still announced by DISCONTINUITY-SEQUENCE increasing together
    // with the new first segment's number falling below the highest number seen
    // in the prior epoch. Both signals are required so an ordinary in-stream
    // discontinuity with monotonic numbering never opens a reset epoch.
    const firstSequence = playlist.segments[0]?.sequence ?? playlist.mediaSequence;
    const discontinuityIncreased =
      this.lastDiscontinuitySequence !== null &&
      playlist.discontinuitySequence > this.lastDiscontinuitySequence;
    const numberingRolledBack =
      this.lastPlaylistSequence !== -1 && firstSequence < this.lastPlaylistSequence;
    let reset = false;
    if (this.lastMediaSequence !== -1 && playlist.mediaSequence < this.lastMediaSequence) {
      this.handleSequenceReset(playlist, fetchedAt);
      reset = true;
    } else if (discontinuityIncreased && numberingRolledBack) {
      this.handleSequenceReset(playlist, fetchedAt);
      reset = true;
    }
    if (reset) {
      // The rebuilt epoch reads the restarted discontinuity numbering fresh.
      this.lastDiscontinuitySequence = playlist.discontinuitySequence;
    } else if (this.lastDiscontinuitySequence === null ||
      playlist.discontinuitySequence > this.lastDiscontinuitySequence) {
      this.lastDiscontinuitySequence = playlist.discontinuitySequence;
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
        const existingIndex = this.live.findIndex((e) => e.sequence === seg.sequence);
        this.evict(existing.sequence, 'sequence-reused', existingIndex);
        this.entryBySequence.delete(seg.sequence);
      } else if (this.recentEvictedUri.get(seg.sequence) === seg.uri) {
        // Same number, same content, already evicted: the origin is merely
        // re-advertising a segment the kernel rolled past. Skip it rather than
        // minting a second playback time for it.
        continue;
      }
      // Below the advertised MEDIA-SEQUENCE the origin has rolled past this
      // number; if it is also absent from the live map it must not be
      // rematerialised onto a fresh playback time.
      if (seg.sequence < playlist.mediaSequence) continue;
      const entry = this.materialize(seg);
      if (entry) added += 1;
    }

    // Segments that were live but are no longer advertised have rolled out of
    // the upstream window and must not be requested again. Sequence numbers can
    // jump, so a missing entry is not guaranteed to sit at the head: collect
    // every missing index, then splice from right to left so earlier indices
    // stay valid for the next removal.
    const present = new Set(playlist.segments.map((s) => s.sequence));
    let rolledOut = 0;
    const missingIndices = [];
    for (let i = 0; i < this.live.length; i += 1) {
      if (!present.has(this.live[i].sequence)) missingIndices.push(i);
    }
    for (let k = missingIndices.length - 1; k >= 0; k -= 1) {
      const index = missingIndices[k];
      this.evict(this.live[index].sequence, reset ? 'upstream-reset' : 'upstream-rollout', index);
      rolledOut += 1;
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
    this.advanceLeftEdge(fetchedAt);
    this.generation += 1;
    this.stats.ingests += 1;
    return { added, evicted: rolledOut, reset };
  }

  // A renumbered upstream cannot extend the old axis: every old segment is
  // retired and the next segment opens a new run. The playback cursor is kept
  // so the window continues forward instead of rewinding.
  handleSequenceReset(playlist, fetchedAt) {
    const oldEpoch = this.epoch;
    // Splice from right to left so every known index stays valid.
    for (let index = this.live.length - 1; index >= 0; index -= 1) {
      this.evict(this.live[index].sequence, 'sequence-reset', index);
    }
    this.entryBySequence.clear();
    // A reset starts a fresh numbering epoch: old sequence-to-URI memories must
    // not suppress the new epoch's segments that reuse the same numbers.
    this.recentEvictedUri.clear();
    this.evictedBySequence.clear();
    this.epoch = oldEpoch + 1;
    this.lastMediaSequence = -1;
    this.lastPlaylistSequence = -1;
    this.lastDiscontinuitySequence = null;
    this.pendingDiscontinuity = true;
    this.hold = null;
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
    // Normal monotonic ingest: playback time only accumulates forward, so the
    // new entry belongs at the tail and an append is enough — no scan, no sort.
    // A reissued sequence number (its old position was evicted and the origin
    // reuses the number) reopens an earlier time; detect that one case and
    // reorder just the affected window instead of sorting on every ingest.
    if (this.live.length === 0 || entry.playbackStart >= this.live.at(-1).playbackStart) {
      this.live.push(entry);
    } else {
      let lo = 0;
      let hi = this.live.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.live[mid].playbackStart < entry.playbackStart) lo = mid + 1;
        else hi = mid;
      }
      this.live.splice(lo, 0, entry);
      this.stats.reorderInsertions += 1;
    }
    this.stats.materialized += 1;
    return entry;
  }

  // ---- viewer hold --------------------------------------------------------

  // Register (or refresh) the position a viewer is currently using. While the
  // hold is fresh the segment covering it, and every segment after it, stay in
  // the window. Passing null clears the hold. `at` defaults to wall-clock time
  // so callers can inject deterministic clocks in tests.
  setHold({ position = null, at = Date.now() } = {}) {
    if (position === null || !Number.isFinite(position)) {
      this.hold = null;
      return;
    }
    this.hold = { position, registeredAt: at, lastSeenAt: at };
  }

  clearHold() {
    this.hold = null;
  }

  // Refresh liveness without moving the position. A viewer that keeps polling
  // while parked on old footage keeps its segments; a vanished viewer's hold
  // goes stale after holdTtlMs and the window resumes rolling.
  touchHold(at = Date.now()) {
    if (this.hold) this.hold.lastSeenAt = at;
  }

  holdIsFresh(at = Date.now()) {
    if (!this.hold) return false;
    return at - this.hold.lastSeenAt <= this.holdTtlMs;
  }

  // The playback time the left edge must not pass. Null when there is no fresh
  // hold or the hold points outside the current window.
  protectedTime(at = Date.now()) {
    if (!this.holdIsFresh(at)) return null;
    const range = this.windowRange();
    if (range.start === null) return null;
    if (this.hold.position < range.start || this.hold.position >= range.end) return null;
    return this.hold.position;
  }

  advanceLeftEdge(at = Date.now()) {
    if (this.live.length <= 1) return;
    const rightmost = this.live.at(-1).playbackEnd;
    const cutoff = rightmost - this.retainSeconds;
    const protectedAt = this.protectedTime(at);
    while (this.live.length > 1 && this.live[0].playbackEnd <= cutoff) {
      // A fresh hold pins the segment the viewer is on. Eviction proceeds in
      // playback order, so stopping here keeps every still-needed segment and
      // never removes one the decoder is about to request.
      if (protectedAt !== null && this.live[0].playbackEnd > protectedAt) {
        this.stats.holdBlockedEvictions += 1;
        break;
      }
      this.evict(this.live[0].sequence, 'window-rollout', 0);
    }
    this.pruneClosedRuns();
  }

  evict(sequence, reason, knownIndex = -1) {
    // Callers that already hold the entry's ordered position pass it in; the
    // fallback search only runs for one-off evictions (e.g. sequence reuse).
    let index = knownIndex;
    if (index < 0 || this.live[index]?.sequence !== sequence) {
      index = this.live.findIndex((e) => e.sequence === sequence);
    }
    if (index === -1) return;
    const [entry] = this.live.splice(index, 1);
    entry.status = 'evicted';
    this.entryBySequence.delete(sequence);
    this.recentEvictedUri.set(sequence, entry.uri);
    if (this.recentEvictedUri.size > MAX_EVICTED_ENTRIES) {
      const oldestSeq = this.recentEvictedUri.keys().next().value;
      this.recentEvictedUri.delete(oldestSeq);
    }
    const info = {
      epoch: entry.epoch,
      playbackStart: entry.playbackStart,
      playbackEnd: entry.playbackEnd,
      runId: entry.runId,
      reason,
    };
    const key = `${entry.epoch}:${sequence}`;
    const record = { sequence, ...info };
    this.evicted.set(key, record);
    // O(1) relocation index for resolveSequence. Bounded together with `evicted`:
    // when the oldest epoch:sequence record falls away, drop its sequence index
    // too unless a newer record reclaimed the same sequence number.
    this.evictedBySequence.set(sequence, record);
    if (this.evicted.size > MAX_EVICTED_ENTRIES) {
      const oldestKey = this.evicted.keys().next().value;
      const oldest = this.evicted.get(oldestKey);
      this.evicted.delete(oldestKey);
      if (this.evictedBySequence.get(oldest.sequence) === oldest) {
        this.evictedBySequence.delete(oldest.sequence);
      }
      this.stats.prunedEvictedRecords += 1;
    }
    // Tombstones arrive in playback order within an epoch; a reset starts a new
    // epoch whose positions are later on the same forward-moving axis, so the
    // array stays ordered and binary search applies.
    this.tombstones.push({ sequence, ...info });
    if (this.tombstones.length > MAX_TOMBSTONES) {
      this.tombstones.shift();
      this.stats.prunedTombstones += 1;
    }
    this.evictedTotal += 1;
    this.stats.evictions += 1;
    this.generation += 1;
  }

  pruneClosedRuns() {
    if (this.live.length === 0 || this.runs.length <= 1) return;
    const liveRunIds = new Set();
    for (const entry of this.live) liveRunIds.add(entry.runId);
    const before = this.runs.length;
    this.runs = this.runs.filter((run) => liveRunIds.has(run.runId));
    this.stats.prunedRuns += before - this.runs.length;
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
      // pruneClosedRuns already removed runs without live segments, so no
      // per-run scan of the segment array is needed here.
      runs: this.runs.map((r) => ({ ...r })),
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

  // Cost counters for the window-index benchmark and the /api/index-stats
  // surface. Returned as a plain copy so callers cannot mutate internals.
  get indexStats() {
    return {
      ...this.stats,
      resolvePlayback: { ...this.stats.resolvePlayback },
      resolveSequence: { ...this.stats.resolveSequence },
      liveSegments: this.live.length,
      tombstoneRecords: this.tombstones.length,
      evictedRecords: this.evicted.size,
      runRecords: this.runs.length,
      evictedTotal: this.evictedTotal,
      hold: this.hold
        ? {
            position: this.hold.position,
            ageMs: Date.now() - this.hold.lastSeenAt,
            fresh: this.holdIsFresh(),
          }
        : null,
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
    this.stats.resolveSequence.calls += 1;
    const entry = this.entryBySequence.get(sequence);
    if (entry) {
      this.stats.resolveSequence.mapHits += 1;
      return entry;
    }
    // The sequence map no longer carries evicted entries; the bounded
    // evictedBySequence index gives an O(1) relocation hint.
    const record = this.evictedBySequence.get(sequence);
    if (record && record.epoch === this.epoch) {
      this.stats.resolveSequence.evictedHits += 1;
      throw new WindowError('EVICTED', `sequence ${sequence} has been evicted`, {
        requestedSequence: sequence,
        evictedRange: { start: record.playbackStart, end: record.playbackEnd, runId: record.runId },
        relocatedTo: this.live[0]?.playbackStart ?? null,
        relocatedSequence: this.live[0]?.sequence ?? null,
        available: this.windowRange(),
      });
    }
    this.stats.resolveSequence.unknown += 1;
    throw new WindowError('UNKNOWN_SEQUENCE', `sequence ${sequence} is not in the current epoch`);
  }

  resolvePlayback(playbackSeconds) {
    this.stats.resolvePlayback.calls += 1;
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
      // Bounded, ordered tombstone ring: one binary search replaces the full
      // filter+sort over every segment ever evicted.
      const tomb = findTombstoneAfter(this.tombstones, playbackSeconds);
      if (tomb) this.stats.resolvePlayback.evictedHits += 1;
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
    const index = findEntryIndexAt(this.live, playbackSeconds);
    this.stats.resolvePlayback.binarySearchSteps += 1;
    const segment = index === -1 ? null : this.live[index];
    if (!segment || playbackSeconds >= segment.playbackEnd) {
      const nextIndex = segment ? index + 1 : 0;
      const next = this.live[nextIndex] ?? null;
      this.stats.resolvePlayback.fullScans += 1;
      return {
        status: 'hole',
        requested: playbackSeconds,
        segment: null,
        relocatedTo: next ? next.playbackStart : null,
        available,
      };
    }
    if (segment.gap) {
      const next = this.live[index + 1] ?? null;
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
      // Bounded: only the retained recent evictions, plus a total count so the
      // UI can still show how much history has left the window.
      evictedRanges: [...this.evicted.values()],
      evictedTotal: this.evictedTotal,
      lastPlaylistSequence: this.lastPlaylistSequence,
    };
  }
}

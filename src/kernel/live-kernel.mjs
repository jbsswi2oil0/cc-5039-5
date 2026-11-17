// Core live-replay model.
//
// Three independent clocks are kept apart per segment:
//   1. Media sequence number (msn): identity. A reset breaks the chain and
//      starts a new relation; a gap starts a new timeline epoch.
//   2. Media time (ms): a stable, relation-relative playback clock derived
//      only from declared EXTINF durations. It is never presented as an
//      absolute capture time.
//   3. Source-declared date (EXT-X-PROGRAM-DATE-TIME): stored verbatim per
//      segment. It is never synthesized by accumulating durations.
//
// The timeline is stable across manifest polls: a segment keeps the same media
// start time for as long as it is in the window. When the window rolls forward
// and drops a segment, any target in that dropped range becomes 'evicted' and
// must be explicitly relocated or refused. It can never be silently remapped
// onto a newer segment that happens to occupy the same offset in a fresh
// layout.

export class WindowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  // Polls failing for longer than this mark the retained window stale.
  staleAfterMs: 20_000,
  // The manifest content must advance within this budget or the source is
  // considered stalled, even if polls keep succeeding. A source that stopped
  // publishing must not be presented as an ongoing live edge.
  stallAfterMs: null, // resolved from target duration: max(3 * target, 10s)
  // How far before the window a requested target may be pulled forward to the
  // window start instead of being refused outright.
  relocationToleranceMs: 5_000,
  // Tolerance when checking declared date vs media-time drift.
  dateDriftToleranceMs: 750,
  maxSegments: 50_000,
});

function assertFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
}

function publicSegment(entry) {
  return {
    msn: entry.msn,
    uri: entry.uri,
    startMs: entry.startMs,
    endMs: entry.endMs,
    durationMs: entry.endMs - entry.startMs,
    epoch: entry.epoch,
    gap: entry.gap,
    discontinuityBefore: entry.discontinuityBefore,
    timelineBreakBefore: entry.timelineBreakBefore,
    missingBefore: entry.missingBefore ?? [],
    declaredStartMs: entry.declaredStartMs,
    declaredStartText: entry.declaredStartText ?? null,
    declaredEndMs: entry.declaredEndMs ?? null,
    frameStart: entry.frameStart ?? null,
    frameRate: entry.frameRate ?? null,
  };
}

// Immutable view of the kernel at one instant.
export class LiveView {
  constructor({
    relation,
    entries,
    window,
    source,
    freshness,
    issues,
    history,
    holes,
    receivedAtMs,
    relocationToleranceMs,
  }) {
    this.relation = relation;
    this.entries = Object.freeze(entries.map((e) => Object.freeze(publicSegment(e))));
    this.window = Object.freeze({ ...window });
    this.source = Object.freeze({ ...source });
    this.freshness = Object.freeze({ ...freshness });
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
    this.history = Object.freeze(history.map((h) => Object.freeze({ ...h })));
    this.holes = Object.freeze((holes ?? []).map((h) => Object.freeze({ ...h })));
    this.receivedAtMs = receivedAtMs;
    this.relocationToleranceMs = relocationToleranceMs;
    Object.freeze(this);
  }

  get startMs() {
    return this.window.startMs;
  }

  get endMs() {
    return this.window.endMs;
  }

  get durationMs() {
    return this.window.endMs - this.window.startMs;
  }

  get liveEdgeMs() {
    return this.window.endMs;
  }

  get isLive() {
    return this.freshness.state === 'live';
  }

  get isFresh() {
    return this.freshness.state !== 'stale';
  }

  segmentsInWindow() {
    return this.entries.filter(
      (e) => e.endMs > this.window.startMs && e.startMs < this.window.endMs,
    );
  }

  // All segments intersecting [fromMs, toMs), clipped to the window.
  segmentsBetween(fromMs, toMs) {
    const lo = Math.max(fromMs, this.window.startMs);
    const hi = Math.min(toMs, this.window.endMs);
    if (!(hi > lo)) return [];
    return this.entries.filter((e) => e.endMs > lo && e.startMs < hi);
  }

  segmentAt(mediaTimeMs) {
    return this.entries.find((e) => mediaTimeMs >= e.startMs && mediaTimeMs < e.endMs) ?? null;
  }

  locate(mediaTimeMs) {
    assertFinite('mediaTimeMs', mediaTimeMs);
    const t = mediaTimeMs;
    const segment = this.segmentAt(t);

    if (t >= this.window.endMs) {
      return {
        status: 'ahead',
        mediaTimeMs: t,
        reason: 'beyond-live-edge',
        behindLiveEdgeMs: t - this.window.endMs,
        liveEdgeMs: this.window.endMs,
        playing: false,
        window: this.window,
      };
    }

    if (segment) {
      if (segment.gap) {
        return {
          status: 'gap',
          mediaTimeMs: t,
          reason: 'declared-gap',
          segment,
          nearestMs: this.nearestPlayableMs(t),
          playing: false,
          window: this.window,
        };
      }
      if (t < this.window.startMs) {
        // Published, but separated from the live-adjacent run by a hole. It is
        // not part of the current playable window; it cannot be emitted as if
        // the timeline were continuous through the missing segment.
        const prior = this.history.find((h) => t >= h.startMs && t < h.endMs);
        return {
          status: 'evicted',
          mediaTimeMs: t,
          reason: prior?.reason ?? 'outside-window-run',
          segment,
          displacedByMs: this.window.startMs - t,
          nearestMs: this.window.startMs,
          playing: false,
          window: this.window,
        };
      }
      return {
        status: 'playable',
        mediaTimeMs: t,
        segment,
        offsetMs: t - segment.startMs,
        localMs: t - this.window.startMs,
        playing: true,
        window: this.window,
      };
    }

    // No segment covers t: either an explicit hole or the span before the
    // window. A hole is never bridged.
    const hole = this.holes.find((h) => t >= h.startMs && t < h.endMs);
    if (hole) {
      return {
        status: 'gap',
        mediaTimeMs: t,
        reason: hole.reason ?? 'missing-segment',
        missingMsn: hole.missingMsn ?? null,
        nearestMs: this.nearestPlayableMs(t),
        playing: false,
        window: this.window,
      };
    }
    if (t < this.window.startMs) {
      const prior = this.history.find((h) => t >= h.startMs && t < h.endMs);
      return {
        status: 'evicted',
        mediaTimeMs: t,
        reason: prior?.reason ?? 'window-rolled',
        displacedByMs: this.window.startMs - t,
        nearestMs: this.window.startMs,
        playing: false,
        window: this.window,
      };
    }
    return {
      status: 'gap',
      mediaTimeMs: t,
      reason: 'missing-segment',
      nearestMs: this.nearestPlayableMs(t),
      playing: false,
      window: this.window,
    };
  }

  nearestPlayableMs(mediaTimeMs) {
    const t = mediaTimeMs;
    let best = null;
    for (const entry of this.entries) {
      if (entry.gap) continue;
      if (entry.endMs <= this.window.startMs || entry.startMs >= this.window.endMs) continue;
      if (t >= entry.startMs && t < entry.endMs) return t;
      const candidate = t < entry.startMs ? entry.startMs : entry.endMs;
      if (best === null || Math.abs(candidate - t) < Math.abs(best - t)) best = candidate;
    }
    if (best === null) return null;
    return Math.min(Math.max(best, this.window.startMs), this.window.endMs);
  }

  // Resolve a requested start position into an explicit decision. Never
  // returns a path that silently points at different content.
  resolveStart(mediaTimeMs, options = {}) {
    const toleranceMs = options.toleranceMs ?? this.relocationToleranceMs ?? 0;
    const located = this.locate(mediaTimeMs);

    if (located.status === 'playable') {
      return { ok: true, action: 'play', ...located };
    }
    if (located.status === 'ahead') {
      return {
        ...located,
        ok: false,
        action: 'refuse',
        reason: 'ahead-of-live-edge',
        requestedMs: mediaTimeMs,
        relocatedMs: null,
        message: 'requested position is ahead of the live edge',
      };
    }
    if (located.status === 'evicted') {
      if (located.displacedByMs > toleranceMs) {
        return {
          ...located,
          ok: false,
          action: 'refuse',
          reason: located.reason,
          requestedMs: mediaTimeMs,
          relocatedMs: null,
          message:
            located.reason === 'relation-reset'
              ? 'requested position belongs to a previous sequence relation'
              : 'requested position has rolled out of the window',
        };
      }
      return {
        ...this.locate(this.window.startMs),
        ok: true,
        action: 'relocate',
        reason: located.reason,
        relocationReason: located.reason,
        requestedMs: mediaTimeMs,
        relocatedMs: this.window.startMs,
        message: 'requested position has rolled out; relocated to the window start',
      };
    }
    // gap: never jump over missing content as if it were continuous.
    return {
      ...located,
      ok: false,
      action: 'refuse',
      reason: 'gap',
      requestedMs: mediaTimeMs,
      relocatedMs: null,
      message: 'requested position falls in an unavailable hole and cannot be served',
    };
  }
}

export class LiveKernel {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = config.now ?? (() => Date.now());
    this.relation = null;
    this.startByMsn = new Map();
    this.knownMsn = new Set();
    this.entries = [];
    this.holes = [];
    this.evicted = [];
    this.issues = [];
    this.events = [];
    this.lastSuccessAtMs = null;
    this.lastConfirmedAtMs = null;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.view = null;
  }

  ingest(manifest, { receivedAtMs = this.now(), parse } = {}) {
    let parsed = manifest;
    try {
      if (typeof manifest === 'string') {
        if (!parse) throw new TypeError('raw manifest requires parse()');
        parsed = parse(manifest);
      }
      if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        throw new WindowError('empty-manifest', 'manifest contains no segments');
      }
      return this.accept(parsed, receivedAtMs);
    } catch (error) {
      return this.fail(error, receivedAtMs);
    }
  }

  fail(error, receivedAtMs) {
    this.consecutiveFailures += 1;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.issues = [
      {
        code: 'manifest-unavailable',
        message: this.lastError,
        receivedAtMs,
        consecutiveFailures: this.consecutiveFailures,
      },
    ];
    this.events.push({ atMs: receivedAtMs, type: 'poll-failed', message: this.lastError });
    if (!this.view) {
      return { ok: false, status: 'no-window', error: this.lastError, view: null };
    }
    // Retain the last confirmed range, but never label it as fresh live.
    this.view = this.buildView(receivedAtMs);
    return {
      ok: false,
      status: 'retained',
      error: this.lastError,
      view: this.view,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  accept(parsed, receivedAtMs) {
    if (parsed.segments.length > this.config.maxSegments) {
      throw new WindowError(
        'too-many-segments',
        `manifest has ${parsed.segments.length} segments (limit ${this.config.maxSegments})`,
      );
    }
    const previousView = this.view;
    const previousWindow = previousView?.window ?? null;
    const previousRelation = this.relation;
    const issues = [...(parsed.issues ?? [])];

    const segments = [...parsed.segments].sort((a, b) => a.msn - b.msn);
    for (let i = 1; i < segments.length; i += 1) {
      if (segments[i].msn === segments[i - 1].msn) {
        issues.push({ code: 'duplicate-media-sequence', msn: segments[i].msn });
      }
    }

    const firstMsn = segments[0].msn;
    const lastMsn = segments[segments.length - 1].msn;
    let resetReason = null;

    if (previousRelation) {
      let overlap = false;
      let conflictingIdentity = false;
      for (const s of segments) {
        const prior = this.startByMsn.get(s.msn);
        if (!prior) continue;
        overlap = true;
        // Same sequence number, different content: the source reset its
        // numbering without the numbers ever going backwards.
        if (prior.uri !== s.uri) conflictingIdentity = true;
      }
      if (conflictingIdentity) {
        resetReason = 'segment-identity-reset';
      } else if (!overlap && lastMsn < previousRelation.minMsn) {
        resetReason = 'media-sequence-reset';
      } else if (segments.some((s) => s.msn < previousRelation.minMsn) && !overlap) {
        resetReason = 'media-sequence-reset';
      }
      // Older content appearing alongside known content is a backfill
      // extension, not a reset.
    }

    if (!previousRelation || resetReason) {
      // A new relation continues on a monotone timeline. Restarting at 0 would
      // let a stale target silently point at different content, which is
      // exactly the failure this kernel exists to prevent.
      let timeBaseMs = 0;
      if (previousRelation) {
        const oldEnd = Math.max(
          0,
          ...this.entries.filter((e) => e.endMs != null).map((e) => e.endMs),
          previousWindow?.endMs ?? 0,
        );
        timeBaseMs = oldEnd;
      }
      this.relation = {
        id: `relation-${firstMsn}-${this.events.filter((e) => e.type === 'relation-reset').length + 1}`,
        resetCount: previousRelation ? previousRelation.resetCount + 1 : 0,
        minMsn: firstMsn,
        maxMsn: lastMsn,
        epoch: 0,
        timeBaseMs,
        startedAtMs: receivedAtMs,
        previousWindow: previousWindow ? { ...previousWindow } : null,
      };
      this.startByMsn = new Map();
      this.knownMsn = new Set();
      if (resetReason && previousWindow) {
        this.evicted.push({
          startMs: previousWindow.startMs,
          endMs: previousWindow.endMs,
          relationId: previousRelation.id,
          reason: 'relation-reset',
          atMs: receivedAtMs,
        });
        this.events.push({
          atMs: receivedAtMs,
          type: 'relation-reset',
          reason: resetReason,
          from: previousRelation.id,
          to: this.relation.id,
        });
      }
    } else {
      this.relation.minMsn = Math.min(this.relation.minMsn, firstMsn);
      this.relation.maxMsn = Math.max(this.relation.maxMsn, lastMsn);
    }

    const epochAtMsn = new Map();
    let epoch = this.relation.epoch;
    let previousSegment = null;
    for (const segment of segments) {
      if (segment.discontinuityBefore) {
        epoch += 1;
        this.events.push({
          atMs: receivedAtMs,
          type: 'discontinuity',
          msn: segment.msn,
          epoch,
        });
      }
      epochAtMsn.set(segment.msn, epoch);
      previousSegment = segment;
    }
    if (previousSegment) this.relation.epoch = epoch;

    // Detect msn gaps inside this manifest.
    const missingByMsn = new Map();
    for (let i = 1; i < segments.length; i += 1) {
      const a = segments[i - 1];
      const b = segments[i];
      if (b.msn > a.msn + 1) {
        const missing = [];
        for (let m = a.msn + 1; m < b.msn; m += 1) missing.push(m);
        missingByMsn.set(b.msn, missing);
        this.events.push({ atMs: receivedAtMs, type: 'segment-gap', beforeMsn: b.msn, missing });
        issues.push({ code: 'segment-gap', beforeMsn: b.msn, missing });
      }
    }
    // A declared EXT-X-GAP keeps its sequence slot but has no media. Report it
    // so the UI can show it; locate() refuses it rather than borrowing a
    // neighbour's bytes.
    for (const segment of segments) {
      if (!segment.gap) continue;
      this.events.push({ atMs: receivedAtMs, type: 'declared-gap', msn: segment.msn });
      issues.push({ code: 'declared-gap', msn: segment.msn });
    }

    // Establish stable starts.
    // 1. Keep already-laid-out times for known msns.
    for (const segment of segments) {
      const existing = this.startByMsn.get(segment.msn);
      if (existing) {
        if (existing.durationMs !== segment.durationMs) {
          issues.push({
            code: 'declared-duration-changed',
            msn: segment.msn,
            previousMs: existing.durationMs,
            currentMs: segment.durationMs,
          });
        }
        if (existing.uri !== segment.uri) {
          issues.push({ code: 'segment-uri-changed', msn: segment.msn });
        }
      }
    }

    // 2. Find an anchor from the known map; otherwise start at 0.
    const laidOut = new Map();
    // Holes are populated while laying out (sequence jumps) and completed
    // below for in-window missing msns.
    const holes = [];
    for (const segment of segments) {
      const existing = this.startByMsn.get(segment.msn);
      if (existing) laidOut.set(segment.msn, { ...existing });
    }

    // 3. Forward fill.
    let hasPlaced = laidOut.size > 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (laidOut.has(segment.msn)) continue;
      let startMs = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        const prev = laidOut.get(segments[j].msn);
        if (prev) {
          startMs = prev.endMs;
          break;
        }
      }
      if (startMs == null) continue;
      laidOut.set(segment.msn, {
        startMs,
        endMs: startMs + segment.durationMs,
        durationMs: segment.durationMs,
        epoch: epochAtMsn.get(segment.msn),
        uri: segment.uri,
      });
    }

    // 4. Backward fill for newly discovered older segments that are adjacent
    // to already-placed ones. Only msns known through a contiguous chain may
    // be joined; an unrelated island must not be glued onto this timeline.
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (laidOut.has(segment.msn)) continue;
      const next = segments[i + 1];
      if (!next || !laidOut.has(next.msn)) continue;
      const nextLayout = laidOut.get(next.msn);
      laidOut.set(segment.msn, {
        startMs: nextLayout.startMs - segment.durationMs,
        endMs: nextLayout.startMs,
        durationMs: segment.durationMs,
        epoch: epochAtMsn.get(segment.msn),
        uri: segment.uri,
      });
    }

    // 5. Segments with no overlap at all. Placement depends on direction:
    //   - entirely newer than everything known -> continue after the highest
    //     known end, leaving an explicit hole for the unseen msns;
    //   - entirely older -> place before the lowest known start (backfill);
    //   - the very first manifest -> start at the relation's time base.
    // Placing a forward-jumped island back at the time base would silently
    // remap new content onto old media time, so that is never done.
    const unplaced = segments.filter((s) => !laidOut.has(s.msn));
    if (unplaced.length) {
      const knownLayouts = [...this.startByMsn.values()];
      const lowestNew = Math.min(...unplaced.map((s) => s.msn));
      const highestNew = Math.max(...unplaced.map((s) => s.msn));
      const knownMinMsn = knownLayouts.length
        ? Math.min(...this.startByMsn.keys())
        : null;
      const knownMaxMsn = knownLayouts.length
        ? Math.max(...this.startByMsn.keys())
        : null;
      const knownMinStart = knownLayouts.length
        ? Math.min(...knownLayouts.map((v) => v.startMs))
        : null;
      const knownMaxEnd = knownLayouts.length
        ? Math.max(...knownLayouts.map((v) => v.endMs))
        : null;

      if (laidOut.size > 0) {
        let cursor = Math.max(...[...laidOut.values()].map((v) => v.endMs));
        for (const segment of unplaced) {
          laidOut.set(segment.msn, {
            startMs: cursor,
            endMs: cursor + segment.durationMs,
            durationMs: segment.durationMs,
            epoch: epochAtMsn.get(segment.msn),
            uri: segment.uri,
          });
          cursor += segment.durationMs;
        }
      } else if (knownMaxMsn != null && lowestNew > knownMaxMsn) {
        // Forward jump: the window rolled past everything previously known.
        // The jump is a real break with unknown duration, so it is zero-length
        // in media time. Continuity must not be invented to hide it.
        const jumpAt = knownMaxEnd;
        let cursor = jumpAt;
        for (const segment of unplaced) {
          laidOut.set(segment.msn, {
            startMs: cursor,
            endMs: cursor + segment.durationMs,
            durationMs: segment.durationMs,
            epoch: epochAtMsn.get(segment.msn),
            uri: segment.uri,
          });
          cursor += segment.durationMs;
        }
        const missing = [];
        const limit = Math.min(lowestNew, knownMaxMsn + 1 + 2000);
        for (let m = knownMaxMsn + 1; m < limit; m += 1) missing.push(m);
        holes.push({
          startMs: jumpAt,
          endMs: jumpAt,
          missingMsn: missing,
          reason: 'sequence-jump',
          truncated: limit < lowestNew,
        });
        if (missing.length) {
          issues.push({
            code: 'segment-gap',
            beforeMsn: lowestNew,
            missing,
            truncated: limit < lowestNew,
          });
          this.events.push({
            atMs: receivedAtMs,
            type: 'segment-gap',
            beforeMsn: lowestNew,
            missing,
          });
        }
        this.events.push({
          atMs: receivedAtMs,
          type: 'window-jump',
          fromMsn: knownMaxMsn,
          toMsn: lowestNew,
          atMediaMs: jumpAt,
        });
      } else if (knownMinMsn != null && highestNew < knownMinMsn) {
        // Backfill: older content appeared before everything known.
        let cursor = knownMinStart;
        for (let i = unplaced.length - 1; i >= 0; i -= 1) {
          const segment = unplaced[i];
          cursor -= segment.durationMs;
          laidOut.set(segment.msn, {
            startMs: cursor,
            endMs: cursor + segment.durationMs,
            durationMs: segment.durationMs,
            epoch: epochAtMsn.get(segment.msn),
            uri: segment.uri,
          });
        }
      } else {
        // First manifest (or an unreconcilable set): start fresh.
        let cursor = this.relation.timeBaseMs ?? 0;
        for (const segment of unplaced) {
          laidOut.set(segment.msn, {
            startMs: cursor,
            endMs: cursor + segment.durationMs,
            durationMs: segment.durationMs,
            epoch: epochAtMsn.get(segment.msn),
            uri: segment.uri,
          });
          cursor += segment.durationMs;
        }
      }
    }

    // Store stable layout.
    for (const [msn, value] of laidOut) this.startByMsn.set(msn, value);
    for (const segment of segments) this.knownMsn.add(segment.msn);

    // Bound the stable layout map: anything well behind the newest window can
    // no longer be played, and keeping it forever would leak memory.
    if (this.startByMsn.size > 4000) {
      const newestMsn = segments[segments.length - 1].msn;
      const cutoffMsn = newestMsn - 2000;
      for (const msn of [...this.startByMsn.keys()]) {
        if (msn < cutoffMsn) {
          this.startByMsn.delete(msn);
          this.knownMsn.delete(msn);
        }
      }
    }

    // Build the current entries.
    const entries = segments.map((segment) => {
      const layout = laidOut.get(segment.msn);
      const missing = missingByMsn.get(segment.msn) ?? [];
      return {
        msn: segment.msn,
        uri: segment.uri,
        startMs: layout.startMs,
        endMs: layout.endMs,
        epoch: epochAtMsn.get(segment.msn),
        gap: Boolean(segment.gap),
        discontinuityBefore: Boolean(segment.discontinuityBefore),
        timelineBreakBefore: missing.length > 0,
        missingBefore: missing,
        declaredStartMs: segment.programDateTimeMs ?? null,
        declaredStartText: segment.programDateTimeText ?? null,
        frameStart: segment.frameIndex ?? null,
        frameRate: parsed.frameRate ?? null,
        durationDeclaredMs: segment.durationMs,
        uriDeclared: segment.uri,
        lineNumber: segment.lineNumber,
      };
    });

    // Declared end dates are computed only for display when both ends are
    // explicitly declared. Never invented by accumulating durations.
    for (const entry of entries) {
      if (entry.declaredStartMs == null) {
        entry.declaredEndMs = null;
        continue;
      }
      const next = entries.find((e) => e.msn === entry.msn + 1);
      entry.declaredEndMs = next?.declaredStartMs ?? null;
    }

    const dateCheck = this.checkDeclaredDates(entries, issues);
    const window = this.computeWindow(entries);

    // A hole is the media-time span of an msn that is missing between two
    // published segments. It is playable by nothing: locate() reports a gap
    // and resolveStart() refuses rather than borrowing a neighbour's bytes.
    for (const [beforeMsn, missing] of missingByMsn) {
      const next = entries.find((e) => e.msn === beforeMsn);
      const prev = entries.find((e) => e.msn === beforeMsn - 1);
      if (!next || !prev) continue;
      holes.push({
        startMs: prev.endMs,
        endMs: next.startMs,
        missingMsn: missing,
        reason: 'missing-segment',
      });
    }
    // Holes for msns the source has never published but whose span is already
    // inside the window (e.g. after a forward jump).
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1];
      const next = entries[i];
      if (next.msn === prev.msn + 1) continue;
      if (holes.some((h) => h.startMs === prev.endMs && h.endMs === next.startMs)) continue;
      const missing = [];
      for (let m = prev.msn + 1; m < next.msn && missing.length < 2000; m += 1) missing.push(m);
      holes.push({
        startMs: prev.endMs,
        endMs: next.startMs,
        missingMsn: missing,
        reason: 'missing-segment',
      });
    }

    // Record anything the previous view had but this one no longer does.
    if (previousView && !resetReason) {
      const current = new Set(entries.map((e) => e.msn));
      const dropped = previousView.entries.filter((e) => !current.has(e.msn));
      const oldestCurrentStart = Math.min(...entries.map((e) => e.startMs));
      for (const e of dropped) {
        if (e.endMs <= oldestCurrentStart) {
          this.evicted.push({
            startMs: e.startMs,
            endMs: e.endMs,
            relationId: this.relation.id,
            reason: 'window-rolled',
            atMs: receivedAtMs,
          });
          this.events.push({
            atMs: receivedAtMs,
            type: 'window-eviction',
            msn: e.msn,
            startMs: e.startMs,
            endMs: e.endMs,
          });
        }
      }
    }
    // Keep eviction history bounded.
    if (this.evicted.length > 500) this.evicted.splice(0, this.evicted.length - 500);

    const source = {
      url: parsed.sourceUrl ?? previousView?.source.url ?? null,
      targetDurationSec: parsed.targetDuration ?? null,
      playlistType: parsed.playlistType ?? null,
      ended: Boolean(parsed.ended),
      frameRate: parsed.frameRate ?? null,
      initSegment: parsed.map?.uri ?? null,
      mediaSequence: parsed.mediaSequence,
      discontinuitySequenceBase: parsed.discontinuitySequenceBase ?? null,
      declaredDatesPresent: entries.some((e) => e.declaredStartMs != null),
    };

    this.issues = issues;
    this.dateCheck = dateCheck;
    this.lastSuccessAtMs = receivedAtMs;
    this.lastConfirmedAtMs = receivedAtMs;
    if (previousView == null || parsed.mediaSequence !== previousView.source.mediaSequence) {
      this.lastContentAdvanceAtMs = receivedAtMs;
    } else {
      const previousNewest = previousView.entries[previousView.entries.length - 1];
      const currentNewest = entries[entries.length - 1];
      if (
        !previousNewest ||
        currentNewest.msn !== previousNewest.msn ||
        currentNewest.endMs !== previousNewest.endMs
      ) {
        this.lastContentAdvanceAtMs = receivedAtMs;
      }
    }
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.holes = holes;
    this.view = this.buildView(receivedAtMs, { source, entries, window, holes });

    const windowMoved =
      previousWindow != null &&
      (previousWindow.startMs !== window.startMs || previousWindow.endMs !== window.endMs);

    return {
      ok: true,
      status: resetReason
        ? 'relation-reset'
        : windowMoved
          ? 'window-updated'
          : 'unchanged',
      reset: resetReason,
      view: this.view,
      windowMoved,
      evictedMs: previousWindow ? Math.max(0, window.startMs - previousWindow.startMs) : 0,
      issues,
    };
  }

  checkDeclaredDates(entries, issues) {
    // Compare declared date deltas against media-time deltas inside each
    // epoch. A mismatch means the declared clock and the duration clock
    // disagree; we surface it instead of blending the two.
    const result = { comparisons: 0, mismatches: [], epochs: [] };
    let reference = null;
    for (const entry of entries) {
      if (entry.declaredStartMs == null) continue;
      if (reference && reference.epoch === entry.epoch) {
        const declaredDelta = entry.declaredStartMs - reference.declaredStartMs;
        const mediaDelta = entry.startMs - reference.startMs;
        const drift = declaredDelta - mediaDelta;
        result.comparisons += 1;
        if (Math.abs(drift) > this.config.dateDriftToleranceMs) {
          result.mismatches.push({
            msn: entry.msn,
            driftMs: drift,
            declaredDeltaMs: declaredDelta,
            mediaDeltaMs: mediaDelta,
          });
          issues.push({
            code: 'declared-date-media-drift',
            msn: entry.msn,
            driftMs: drift,
          });
        }
      }
      reference = entry;
    }
    return result;
  }

  // The availability window is the contiguous run of segments ending at the
  // newest published one. A media-sequence hole (unseen or missing msns) is
  // not playable, so it must never be reported as part of the available range:
  // the window starts at the first segment of the unbroken tail run.
  computeWindow(entries) {
    if (entries.length === 0) return { startMs: 0, endMs: 0, durationMs: 0 };
    const ordered = [...entries].sort((a, b) => a.msn - b.msn);
    let contiguousStart = ordered.length - 1;
    for (let i = ordered.length - 2; i >= 0; i -= 1) {
      const current = ordered[i];
      const next = ordered[i + 1];
      if (next.msn !== current.msn + 1) break;
      if (current.endMs !== next.startMs) break;
      contiguousStart = i;
    }
    const startMs = ordered[contiguousStart].startMs;
    const endMs = ordered[ordered.length - 1].endMs;
    return { startMs, endMs, durationMs: endMs - startMs };
  }

  buildView(receivedAtMs, override = {}) {
    const entries = override.entries ?? this.entries;
    const window = override.window ?? this.computeWindow(entries);
    const holes = override.holes ?? this.holes ?? [];
    const source =
      override.source ??
      this.view?.source ?? {
        url: null,
        targetDurationSec: null,
        playlistType: null,
        ended: false,
        frameRate: null,
        initSegment: null,
        mediaSequence: null,
        discontinuitySequenceBase: null,
        declaredDatesPresent: false,
      };

    const lastSuccessAtMs = this.lastSuccessAtMs;
    const ageMs = lastSuccessAtMs == null ? null : Math.max(0, receivedAtMs - lastSuccessAtMs);
    const targetMs = (source.targetDurationSec ?? 6) * 1000;
    const stallAfterMs =
      this.config.stallAfterMs ?? Math.max(3 * targetMs, 10_000);
    const contentAgeMs =
      this.lastContentAdvanceAtMs == null
        ? null
        : Math.max(0, receivedAtMs - this.lastContentAdvanceAtMs);
    let state;
    if (lastSuccessAtMs == null) state = 'no-window';
    else if (this.consecutiveFailures > 0 && ageMs > this.config.staleAfterMs) state = 'stale';
    else if (this.consecutiveFailures > 0) state = 'unconfirmed';
    else if (ageMs > this.config.staleAfterMs) state = 'stale';
    else if (contentAgeMs != null && contentAgeMs > stallAfterMs) state = 'stalled';
    else state = 'live';

    const freshness = {
      state,
      ageMs,
      lastSuccessAtMs,
      lastConfirmedAtMs: this.lastConfirmedAtMs,
      lastContentAdvanceAtMs: this.lastContentAdvanceAtMs,
      contentAgeMs,
      stallAfterMs,
      consecutiveFailures: this.consecutiveFailures,
      staleAfterMs: this.config.staleAfterMs,
      // Only a live, advancing window may be presented as an ongoing live edge.
      liveEdgeIsCurrent: state === 'live',
      error: this.lastError,
    };

    const view = new LiveView({
      relation: {
        id: this.relation.id,
        resetCount: this.relation.resetCount,
        epoch: this.relation.epoch,
        minMsn: this.relation.minMsn,
        maxMsn: this.relation.maxMsn,
        startedAtMs: this.relation.startedAtMs,
      },
      entries,
      window,
      source,
      freshness,
      issues: this.issues,
      history: this.evicted,
      holes,
      receivedAtMs,
      relocationToleranceMs: this.config.relocationToleranceMs,
    });
    this.entries = entries;
    return view;
  }

  // Called by the UI when a poll happened but no manifest was received, or on
  // a timer, so freshness ages even without new input.
  tick(receivedAtMs = this.now()) {
    if (!this.view) return null;
    this.view = this.buildView(receivedAtMs);
    return this.view;
  }

  snapshot() {
    return this.view;
  }

  diagnostics() {
    return {
      relation: this.relation,
      events: [...this.events],
      evicted: [...this.evicted],
      knownSegments: this.knownMsn.size,
      issues: [...this.issues],
    };
  }
}

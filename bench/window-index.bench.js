// Window-index benchmark.
//
// Drives a ReplayTimeline through a long-running live load in which the
// advertised window slides on every poll. The same workload is replayed
// against the pre-optimisation implementation (bench/timeline-baseline.js) and
// the current one (src/kernel/timeline.js); both must report the same
// observable window at every checkpoint, otherwise the run fails rather than
// comparing numbers from diverged state.
//
// Two loads are exercised:
//
//   sliding  - thousands of polls, each adding a segment and rolling the
//              window, with resolvePlayback/resolveSequence lookups mixed in
//              (this is the "long running + window sliding" load)
//   hold     - a registered replay position pins the left edge so segments a
//              viewer still needs for decoding cannot be evicted early
//
// The index cost decomposition is measured in the exact order of a real
// lookup request (see COST_ORDER below):
//
//   1. ingest        applyPlaylist: reconcile + materialise + rollout bookkeeping
//   2. left-edge     advanceLeftEdge: cutoff computation and eviction loop
//   3. index lookup  resolvePlayback: find the segment for a playback time
//   4. sequence map  resolveSequence: Map lookup for a media sequence
//   5. range/snapshot windowRange/snapshot: what the API serialises per poll
//
// Only after every stage above has been executed are the latencies compared,
// so a number is never quoted for a build that failed an earlier correctness
// or valid-range gate. Run with: node bench/window-index.bench.js
//
// Optional env: BENCH_SEGMENTS (default 20000), BENCH_RETAIN (default 24),
// BENCH_WINDOW (advertised playlist size, default 60).

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SEGMENTS = Number(process.env.BENCH_SEGMENTS ?? 20000);
const RETAIN = Number(process.env.BENCH_RETAIN ?? 24);
// The advertised window must be at least as wide as the retained replay range,
// mirroring the demo defaults (upstream 30 segments vs kernel retain 24s).
// Otherwise the synthetic origin would re-advertise a segment the kernel has
// already evicted, which a real sliding origin never does.
const WINDOW = Math.max(Number(process.env.BENCH_WINDOW ?? 60), RETAIN + 4);
const SEG_DURATION = 1;
const LOOKUP_EVERY = 7;
const HOLD_TTL_MS = 30_000;

export const COST_ORDER = [
  'ingestMs',
  'leftEdgeMs',
  'resolvePlaybackMs',
  'resolveSequenceMs',
  'rangeSnapshotMs',
];

function makePlaylist(mediaSequence, count) {
  // A real live origin (see EncodeSource.rollManifest) advertises a sliding
  // suffix of one monotonic sequence axis: MEDIA-SEQUENCE only advances and a
  // number that rolled out is never reissued on the same epoch. Sequence
  // numbers are therefore contiguous here; sequence jumps and resets are
  // covered separately by the kernel unit/e2e tests.
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const sequence = mediaSequence + i;
    segments.push({
      sequence,
      discontinuitySequence: 0,
      discontinuity: false,
      duration: SEG_DURATION,
      declaredPdt: null,
      frameRange: { first: sequence * 30, last: sequence * 30 + 29 },
      gap: false,
      byteRange: null,
      init: null,
      uri: `http://origin.test/live/seg/s${sequence}.m4s`,
    });
  }
  return {
    version: 7,
    targetDuration: 1,
    mediaSequence,
    discontinuitySequence: 0,
    endList: false,
    segments,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    calls: samples.length,
    totalMs: round(sorted.reduce((a, b) => a + b, 0)),
    avgUs: round((sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) * 1000),
    p50Us: round(percentile(sorted, 50) * 1000),
    p95Us: round(percentile(sorted, 95) * 1000),
    maxUs: round(sorted.at(-1) * 1000),
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

async function load(modulePath) {
  const url = pathToFileURL(modulePath).href;
  return import(url);
}

// Replay the identical workload against one timeline implementation and
// collect lookup latencies plus the valid (advertised) range at checkpoints.
async function runSliding(label, TimelineClass, { compare } = {}) {
  const timeline = new TimelineClass({ retainSeconds: RETAIN, gapSeconds: 0 });
  const resolvePlaybackSamples = [];
  const resolveSequenceSamples = [];
  const ingestSamples = [];
  const leftEdgeSamples = [];
  const rangeSamples = [];
  const checkpoints = [];
  let unknownSequence = 0;
  let evictedPlayback = 0;
  let holes = 0;

  // Seed with a full advertised window in one ingest, exactly as the demo does
  // (PREBUILT segments before serving). From here on every poll is a true
  // sliding suffix: one new segment arrives and the oldest one drops, so no
  // sequence number is ever re-advertised after leaving the window.
  timeline.applyPlaylist(makePlaylist(0, WINDOW), { fetchedAt: 0 });

  for (let seq = WINDOW; seq < SEGMENTS; seq += 1) {
    const mediaSequence = seq - WINDOW + 1;
    const playlist = makePlaylist(mediaSequence, WINDOW);
    const t0 = performance.now();
    timeline.applyPlaylist(playlist, { fetchedAt: seq });
    const t1 = performance.now();
    ingestSamples.push(t1 - t0);

    // advanceLeftEdge runs inside applyPlaylist; measure its standalone cost
    // as well by re-invoking it (it is a no-op when nothing is due).
    const t2 = performance.now();
    timeline.advanceLeftEdge();
    const t3 = performance.now();
    leftEdgeSamples.push(t3 - t2);

    if (seq % LOOKUP_EVERY === 0 && timeline.live.length > 0) {
      const range = timeline.windowRange();
      // Lookups spread across the whole valid range: near the left edge,
      // mid-window, near the live edge, plus deliberately out-of-range times.
      const targets = [
        range.start + 0.05,
        (range.start + range.end) / 2,
        range.end - 0.05,
        range.start - 5,
        range.end + 5,
      ];
      for (const target of targets) {
        const a = performance.now();
        try {
          const r = timeline.resolvePlayback(target);
          if (r.status === 'hole') holes += 1;
        } catch (error) {
          if (error.code === 'EVICTED') evictedPlayback += 1;
        }
        resolvePlaybackSamples.push(performance.now() - a);
      }
      // Sequence lookups: one live, one already out of the advertised window,
      // one never seen at all.
      const liveSeq = timeline.live[Math.floor(timeline.live.length / 2)].sequence;
      const evictedSeq = mediaSequence - 2;
      for (const candidate of [liveSeq, evictedSeq, seq + 100_000]) {
        const a = performance.now();
        try {
          timeline.resolveSequence(candidate);
        } catch (error) {
          if (error.code === 'UNKNOWN_SEQUENCE') unknownSequence += 1;
        }
        resolveSequenceSamples.push(performance.now() - a);
      }
      const b = performance.now();
      timeline.windowRange();
      timeline.snapshot();
      rangeSamples.push(performance.now() - b);
    }

    if (seq % Math.max(1, Math.floor(SEGMENTS / 10)) === 0 || seq === SEGMENTS - 1) {
      const range = timeline.windowRange();
      const point = {
        atSequence: seq,
        liveSegments: timeline.live.length,
        rangeStart: range.start,
        rangeEnd: range.end,
        span: round(range.end - range.start),
        evictedRecords: timeline.evicted.size,
        tombstoneRecords: timeline.tombstones.length,
        runRecords: timeline.runs.length,
      };
      if (compare) {
        const expected = compare.checkpoints.find((c) => c.atSequence === seq);
        assert.ok(expected, `missing baseline checkpoint at ${seq}`);
        assert.deepEqual(
          { ...point, evictedRecords: null, tombstoneRecords: null, runRecords: null },
          { ...expected, evictedRecords: null, tombstoneRecords: null, runRecords: null },
          `valid range diverged at sequence ${seq}`,
        );
      }
      checkpoints.push(point);
    }
  }

  const finalRange = timeline.windowRange();
  return {
    label,
    checkpoints,
    finalRange,
    outcomes: { unknownSequence, evictedPlayback, holes },
    cost: {
      ingestMs: summarize(ingestSamples),
      leftEdgeMs: summarize(leftEdgeSamples),
      resolvePlaybackMs: summarize(resolvePlaybackSamples),
      resolveSequenceMs: summarize(resolveSequenceSamples),
      rangeSnapshotMs: summarize(rangeSamples),
    },
    bookkeeping: {
      evictedRecords: timeline.evicted.size,
      tombstoneRecords: timeline.tombstones.length,
      runRecords: timeline.runs.length,
      liveSegments: timeline.live.length,
    },
  };
}

// A registered hold represents a viewer currently parked inside the replay
// window. The left edge must not pass the hold while it is fresh, even once
// the retention cutoff would otherwise evict the segment, and must resume
// rolling once the hold is released or expires. The hold is registered while
// the target segment is still live — a hold cannot resurrect an already
// evicted segment, only protect one that is still decodable.
async function runHold(label, TimelineClass) {
  const timeline = new TimelineClass({ retainSeconds: 4, holdTtlMs: HOLD_TTL_MS });
  const events = [];
  // Build just enough history that segment 2 (playback 2..3s) is live, then
  // park the viewer on it before anything past the retention cutoff exists.
  for (let seq = 0; seq < 5; seq += 1) {
    timeline.applyPlaylist(makePlaylist(0, seq + 1), { fetchedAt: seq });
  }
  const held = timeline.resolvePlayback(2.5);
  assert.equal(held.status, 'ok');
  timeline.setHold({ position: 2.5, at: 5_000 });
  // Drive the stream well past the 4s retention. Without the hold, segment 2
  // would have been evicted many ingests ago.
  for (let seq = 5; seq < 30; seq += 1) {
    timeline.applyPlaylist(makePlaylist(0, seq + 1), { fetchedAt: seq + 5_000 });
  }
  const pinned = timeline.windowRange();
  events.push({ phase: 'held', ...pinned });
  // The pinned segment is still resolvable and decodable: it must neither be
  // evicted nor answer from a tombstone.
  const stillThere = timeline.resolvePlayback(2.5);
  assert.equal(stillThere.status, 'ok', 'held segment must remain playable');
  assert.equal(stillThere.segment.sequence, 2);
  const bySequence = timeline.resolveSequence(2);
  assert.equal(bySequence.status, 'available');

  // Once the hold goes stale (no touch for longer than holdTtlMs) the left edge
  // catches up on the next ingest instead of being pinned forever. The viewer
  // has effectively vanished.
  const staleAt = 5_000 + 25_000 + HOLD_TTL_MS + 1;
  for (let seq = 30; seq < 46; seq += 1) {
    timeline.applyPlaylist(makePlaylist(0, seq + 1), { fetchedAt: staleAt + seq });
  }
  const released = timeline.windowRange();
  events.push({ phase: 'hold-expired', ...released });
  let expiredRefusal = null;
  try {
    timeline.resolvePlayback(2.5);
  } catch (error) {
    expiredRefusal = error.code;
  }
  return {
    label,
    events,
    heldRange: pinned,
    afterExpiryRange: released,
    expiredRefusal,
    heldSegmentSurvived: stillThere.segment.sequence === 2,
  };
}

function ratio(after, before) {
  if (before === 0) return after === 0 ? 1 : Infinity;
  return round(after / before);
}

async function main() {
  const baselineModule = await load(path.join(here, 'timeline-baseline.js'));
  const currentModule = await load(path.join(root, 'src', 'kernel', 'timeline.js'));

  const baseline = await runSliding('baseline', baselineModule.ReplayTimeline);
  const current = await runSliding('optimized', currentModule.ReplayTimeline, {
    compare: baseline,
  });
  assert.deepEqual(
    current.outcomes,
    baseline.outcomes,
    'lookup outcome counts must match (evicted / unknown / hole)',
  );

  // Correctness gate for the hold semantics. The baseline has no hold API; the
  // hold load is only run against the optimised implementation and asserted
  // inline.
  const hold = await runHold('optimized', currentModule.ReplayTimeline);
  assert.equal(hold.heldSegmentSurvived, true);
  assert.equal(hold.expiredRefusal, 'EVICTED', 'expired hold must allow normal eviction');

  const comparison = {};
  for (const stage of COST_ORDER) {
    comparison[stage] = {
      baseline: baseline.cost[stage],
      optimized: current.cost[stage],
      totalSpeedup: ratio(baseline.cost[stage].totalMs, current.cost[stage].totalMs),
      p95Speedup: ratio(baseline.cost[stage].p95Us, current.cost[stage].p95Us),
      maxSpeedup: ratio(baseline.cost[stage].maxUs, current.cost[stage].maxUs),
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    workload: {
      segments: SEGMENTS,
      retainSeconds: RETAIN,
      advertisedWindowSegments: WINDOW,
      segmentDurationSeconds: SEG_DURATION,
      lookupsEvery: LOOKUP_EVERY,
      holdTtlMs: HOLD_TTL_MS,
    },
    costOrder: COST_ORDER,
    comparison,
    validRange: {
      baselineFinal: baseline.finalRange,
      optimizedFinal: current.finalRange,
      checkpoints: current.checkpoints,
    },
    bookkeeping: {
      baseline: baseline.bookkeeping,
      optimized: current.bookkeeping,
    },
    hold,
  };
  console.log(JSON.stringify(report, null, 2));
}

export { runSliding, runHold, summarize };

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('benchmark failed:', error);
    process.exit(1);
  });
}

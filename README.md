# Sports Replay Kernel

A live-sports replay service with a rolling, discontinuity-aware playback window.
A kernel polls an upstream live origin, builds its own continuous playback axis,
serves fMP4 segments with rewritten `tfdt`, and exposes a graphical MSE player
that can seek inside the retained window and return to the live edge.

This document covers:

1. How to launch and drive the **graphical player** (scripts alone are not the
   product — the UI is the intended surface).
2. The **window-index efficiency** work: what changed, the exact cost
   calculation order, how evidence is captured, and the rollback rule.

## 1. Launching the graphical player

### Prerequisites

- Node.js 22+ (ESM, built-in `node:test`).
- `ffmpeg` for the dynamic source encoder. `npm install` wires `ffmpeg-static`;
  if that binary does not match the platform, point `FFMPEG_PATH` / replace
  `node_modules/ffmpeg-static/ffmpeg` with a static build.
- For the headless browser test only: a Chrome/`chrome-headless-shell` plus its
  shared libraries (see *Browser test* below). Normal UI use needs no Chrome.

### Start the full stack

```bash
npm install
npm start          # == node src/demo.js
```

`src/demo.js` starts three real processes in one Node runtime:

| Component     | Default URL                                   | Role                                              |
|---------------|-----------------------------------------------|---------------------------------------------------|
| Replay kernel | http://127.0.0.1:8080                         | Window index, replay manifest/segments, JSON API |
| Player UI     | **http://127.0.0.1:8081/**                    | The graphical player (open this in a browser)    |
| Live origin   | http://127.0.0.1:8090/live/live.m3u8          | The simulated camera's HLS manifest              |

Open **http://127.0.0.1:8081/** in a browser. The camera keeps encoding new
segments, so the window genuinely rolls while you watch.

Useful environment overrules: `PORT`, `LIVE_PORT`, `RETAIN_SECONDS`,
`POLL_MS`, `PREBUILT`, `RESET_AT`, `GAP_SEQUENCES`, `STALE_PDT`,
`FAIL_UPSTREAM`, `PAUSE_SOURCE`.

### What the buttons do (all call the live kernel — no fixed data)

- **Seek slider** — fires the same `input`/`change` handler a human triggers,
  which calls `WindowPlayer.seek()`. That resolves the position against the
  live window via `/api/playhead`, buffers the real segment, moves the video
  element, and registers a kernel **hold** at that position.
- **−10s / +10s** — real seeks clamped to the current valid window.
- **Follow live edge (`#goLive`)** — calls `setFollowLive(true)`, which
  releases the hold (`/api/hold?clear=1`) and re-attaches to the live edge.
- **Advance source** — drives the dynamic encoder one segment through
  `/api/scenario/advance`.
- **media seq / Resolve** — `/api/sequence/:n`; an evicted number returns 410
  with a relocation hint instead of fabricated media.

The time window and playable segment bars on the page are rendered from
`/api/window` and the index/hold row from `/api/index-stats` on every poll.
There is no hardcoded window or segment list anywhere in the UI.

### Observe the hold protecting a parked viewer

1. Drag the seek slider a few seconds back. The **viewer hold** row changes to
   `pinned @ <t>s (age …ms)` and the index row shows live lookup counters.
2. Let the camera keep running. The left edge stops at the held segment instead
   of rolling over it; `/replay/seg/<n>` for that segment still returns `200`.
3. Click **Follow live edge**. The hold row returns to `none (following live)`
   and the window resumes rolling past the old position.

## 2. Window-index efficiency

### Problem

The original index (`bench/timeline-baseline.js`, kept verbatim as the running
reference) stored every segment ever seen:

- `live.sort()` on **every** ingest, an O(n log n) re-sort of the whole array.
- Linear `findIndex`/filter scans for playback-time and eviction lookups.
- Unbounded `tombstones`, `evicted`, and run records that grew for the entire
  process lifetime, so scans on long-running instances kept getting slower.
- Evicted entries were never removed from the sequence map, so it grew without
  bound.

### What changed (`src/kernel/timeline.js`)

- `live` stays in playback order. Normal ingest is a tail append; the rare
  out-of-order reissue uses one binary-searched splice (`stats.reorderInsertions`).
- `resolvePlayback` finds the covering segment with a binary search
  (`findEntryIndexAt`, O(log n)); the evicted path binary-searches the ordered
  tombstone ring (`findTombstoneAfter`).
- `resolveSequence` is O(1): the live `entryBySequence` map first, then a
  bounded `evictedBySequence` relocation index.
- Historical bookkeeping is bounded: at most `MAX_TOMBSTONES = 256` tombstones,
  `MAX_EVICTED_ENTRIES = 512` eviction records / recent-URI entries; closed runs
  are pruned when their last segment leaves the window. A long-running process
  therefore has a flat, retention-sized index rather than an ever-growing one.
- A viewer **hold** pins the left edge. A fresh hold stops retention eviction
  before the segment covering the parked position (`advanceLeftEdge`), so
  segments still needed for decoding are never deleted early. The hold expires
  after `holdTtlMs` without a refresh, or is released on return to live.

#### Boundary correctness

Two distinct eviction paths are kept separate on purpose:

- `window-rollout` (retention) honors a fresh hold.
- `upstream-rollout` (the origin stops advertising a segment) cannot be
  overridden — a segment the origin no longer publishes has no source bytes.

Because of that, a hold is only meaningful when the origin window is the outer
bound. The demo and the browser test configure the upstream window larger than
the kernel retention so a parked viewer's hold has real headroom. A reset is
detected on either a backwards `MEDIA-SEQUENCE` or, when a large origin window
pins that number at zero, a `DISCONTINUITY-SEQUENCE` increase **combined with**
sequence-number rollback — a plain in-stream discontinuity with monotonic
numbering never opens a reset epoch.

### Cost calculation order

The benchmark (`bench/window-index.bench.js`) measures the five stages in the
exact order a real lookup request pays them. A latency number is only compared
after the earlier correctness gates pass, so a build that diverged is never
benchmarked against a different state:

1. **ingest (`ingestMs`)** — `applyPlaylist`: duplicate/URI reconciliation,
   ordered materialisation, and upstream rollout bookkeeping.
2. **left edge (`leftEdgeMs`)** — `advanceLeftEdge`: cutoff computation and the
   hold-aware eviction loop.
3. **playback lookup (`resolvePlaybackMs`)** — binary search to the segment
   covering a playback time, including in-range and out-of-range targets.
4. **sequence lookup (`resolveSequenceMs`)** — O(1) map / relocation lookup.
5. **range snapshot (`rangeSnapshotMs`)** — `windowRange()` + `snapshot()`, the
   serialisation the API performs on every poll.

Each stage reports `avg`, `p50`, `p95`, and `max` latency plus totals. The same
workload is replayed against the baseline and the optimized timeline, with
`assert.deepEqual` checkpoints on the observable valid range at ten points and
matching lookup-outcome counts (evicted / unknown / hole). Any divergence fails
the run (`process.exit(1)`) instead of producing misleading speed numbers.

### Running the evidence

```bash
# Correctness: 36 unit tests incl. 9 dedicated window-index tests
npm test

# Cost decomposition + parity gate vs the baseline (writes bench/results/)
node bench/window-index.bench.js > bench/results/run-full.json

# Real seeks, playback, hold pinning, return-to-live, and a sequence reset,
# driven through the actual page in headless Chrome (see env below).
PUPPETEER_CACHE_DIR=.local/puppeteer \
LD_LIBRARY_PATH=vendor/chrome-libs/usr/lib/aarch64-linux-gnu:.local/chrome-extra-libs \
npm run test:e2e
```

Load is raised by long-running sliding, not synthetic loops: the benchmark
seeds a full advertised window then applies true sliding suffixes for
`BENCH_SEGMENTS` (default 20000) while mixing in-range and out-of-range
lookups. The browser test performs genuine seeks and decodes frame barcodes
from the rendered video, so a moving progress bar over a static file cannot
pass.

### Representative results (`bench/results/run-full.json`)

| Stage                     | Total speedup | p95 speedup |
|---------------------------|---------------|-------------|
| `resolvePlaybackMs`       | ~6.4×         | ~10×        |
| `rangeSnapshotMs`         | ~13×          | ~21×        |
| `resolveSequenceMs`       | parity (~1×)  | parity      |
| ingest / left edge        | ~parity       | parity      |

Bookkeeping after 20,000 segments: optimized keeps `evicted=512`,
`tombstones=256`, `runs=1`, `live=24`; the baseline accumulates `19,976`
eviction/tombstone records. The valid range and lookup outcomes are identical
at every checkpoint.

### Rollback rule

The optimization is gated on two invariants. If either regresses, the
corresponding change is reverted rather than shipped:

1. **Lookup latency** — no stage may be slower than the baseline on the same
   workload.
2. **Out-of-range behavior / valid range** — the observable window, relocation
   hints, and `EVICTED` / `UNKNOWN_SEQUENCE` refusals must match the baseline at
   every checkpoint. The parity `assert` enforces this; the baseline is never
   allowed to mask an error with a default value.

The pre-optimisation implementation is retained verbatim in
`bench/timeline-baseline.js` so the comparison and the rollback reference stay
reproducible.

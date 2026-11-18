// Tests for the rolling-window index optimisations:
//
//   - playback-time lookup stays correct while the window slides for a long run
//   - historical bookkeeping (tombstones, evicted records, runs) stays bounded
//   - a registered viewer hold keeps decodable segments at the left edge and
//     resumes normal rolling once the hold is released or goes stale
//   - sequence reuse (same number, different content) and re-advertisement of
//     an evicted number with the same content behave like the baseline
//
// These complement kernel-timeline.test.js, which covers the timeline's
// externally visible semantics; the assertions here pin the index behaviour
// the benchmark (bench/window-index.bench.js) measures.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayTimeline, WindowError } from '../src/kernel/timeline.js';
import { parseMediaPlaylist } from '../src/kernel/playlist.js';

const BASE = 'http://origin.test/live/live.m3u8';

function playlist({ mediaSequence = 0, segments, endList = false }) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  if (endList) lines.push('#EXT-X-ENDLIST');
  for (const s of segments) {
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.gap) lines.push('#EXT-X-GAP');
    lines.push(`#EXTINF:${s.duration},`);
    lines.push(s.uri ?? `seg${s.sequence}.m4s`);
  }
  return parseMediaPlaylist(lines.join('\n'), BASE);
}

const segs = (start, count, { duration = 1 } = {}) =>
  Array.from({ length: count }, (_, i) => ({ sequence: start + i, duration }));

test('playback lookup stays exact across a long sliding run', () => {
  const t = new ReplayTimeline({ retainSeconds: 24 });
  const WINDOW = 60;
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, WINDOW) }));
  for (let seq = WINDOW; seq < 5000; seq += 1) {
    const mediaSequence = seq - WINDOW + 1;
    t.applyPlaylist(playlist({ mediaSequence, segments: segs(mediaSequence, WINDOW) }));
    if (seq % 500 !== 0) continue;
    const range = t.windowRange();
    // Left edge, a mid-window point and the live edge all resolve to the exact
    // covering segment - no off-by-one from the binary search.
    for (const target of [range.start + 0.1, (range.start + range.end) / 2, range.end - 0.1]) {
      const r = t.resolvePlayback(target);
      assert.equal(r.status, 'ok');
      assert.ok(target >= r.segment.playbackStart && target < r.segment.playbackEnd);
    }
    // Out-of-range lookups still fail with the documented codes.
    assert.throws(() => t.resolvePlayback(range.start - 10), (e) => e.code === 'EVICTED');
    assert.throws(() => t.resolvePlayback(range.end + 10), (e) => e.code === 'AHEAD_OF_WINDOW');
  }
  const finalRange = t.windowRange();
  assert.equal(finalRange.end, 5000);
});

test('historical index bookkeeping is bounded on a long run', () => {
  const t = new ReplayTimeline({ retainSeconds: 8 });
  const WINDOW = 40;
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, WINDOW) }));
  for (let seq = WINDOW; seq < 4000; seq += 1) {
    const mediaSequence = seq - WINDOW + 1;
    t.applyPlaylist(playlist({ mediaSequence, segments: segs(mediaSequence, WINDOW) }));
  }
  // The live window is retention-bounded, and every historical structure is
  // capped regardless of how many segments were ever ingested.
  assert.ok(t.live.length <= 10);
  assert.ok(t.tombstones.length <= 256, `tombstones ${t.tombstones.length}`);
  assert.ok(t.evicted.size <= 512, `evicted ${t.evicted.size}`);
  assert.ok(t.evictedBySequence.size <= 512);
  assert.ok(t.recentEvictedUri.size <= 512);
  assert.ok(t.runs.length <= 1);
  // evictedTotal still counts the full history for the UI dead-band.
  assert.ok(t.indexStats.evictedTotal > 3000);
  assert.ok(t.stats.prunedTombstones > 0);
  assert.ok(t.stats.prunedEvictedRecords > 0);
});

test('a fresh hold pins the left edge and keeps the held segment decodable', () => {
  const t = new ReplayTimeline({ retainSeconds: 4, holdTtlMs: 30_000 });
  t.applyPlaylist(playlist({ segments: segs(0, 5) }), { fetchedAt: 0 });
  // Park a viewer on segment 2 while it is still live.
  const parked = t.resolvePlayback(2.5);
  assert.equal(parked.status, 'ok');
  t.setHold({ position: 2.5, at: 5_000 });
  // Roll far past the 4s retention; the hold keeps segment 2 alive.
  for (let seq = 5; seq < 30; seq += 1) {
    t.applyPlaylist(playlist({ segments: segs(0, seq + 1) }), { fetchedAt: 5_000 + seq * 100 });
  }
  const range = t.windowRange();
  assert.equal(range.start, 2, 'left edge must not pass the held position');
  const still = t.resolvePlayback(2.5);
  assert.equal(still.status, 'ok');
  assert.equal(still.segment.sequence, 2);
  assert.equal(t.resolveSequence(2).status, 'available');
  // Freshness is evaluated against the injected clock, not wall-clock time.
  const lastAt = 5_000 + 29 * 100;
  assert.equal(t.holdIsFresh(lastAt), true);
  assert.equal(t.protectedTime(lastAt), 2.5);
  assert.ok(t.stats.holdBlockedEvictions > 0);
});

test('touching the hold extends protection; a stale hold lets the window roll', () => {
  const t = new ReplayTimeline({ retainSeconds: 4, holdTtlMs: 1_000 });
  t.applyPlaylist(playlist({ segments: segs(0, 5) }), { fetchedAt: 0 });
  t.setHold({ position: 2.5, at: 0 });
  // Keep the viewer active: every touch is inside the TTL.
  for (let seq = 5; seq < 12; seq += 1) {
    const at = seq * 500;
    t.touchHold(at);
    t.applyPlaylist(playlist({ segments: segs(0, seq + 1) }), { fetchedAt: at });
  }
  assert.equal(t.windowRange().start, 2, 'active viewer keeps the segment');
  // The viewer vanishes; after the TTL the hold is stale and eviction resumes.
  const later = 12 * 500 + 5_000;
  for (let seq = 12; seq < 24; seq += 1) {
    t.applyPlaylist(playlist({ segments: segs(0, seq + 1) }), { fetchedAt: later + seq });
  }
  assert.ok(t.windowRange().start > 2, 'stale hold must not pin the edge forever');
  assert.throws(() => t.resolvePlayback(2.5), (e) => e.code === 'EVICTED');
  assert.equal(t.indexStats.hold.fresh, false);
});

test('clearing the hold releases the left edge immediately', () => {
  const t = new ReplayTimeline({ retainSeconds: 4 });
  t.applyPlaylist(playlist({ segments: segs(0, 5) }), { fetchedAt: 0 });
  t.setHold({ position: 2.5, at: 0 });
  for (let seq = 5; seq < 20; seq += 1) {
    t.applyPlaylist(playlist({ segments: segs(0, seq + 1) }), { fetchedAt: seq });
  }
  assert.equal(t.windowRange().start, 2);
  t.clearHold();
  for (let seq = 20; seq < 30; seq += 1) {
    t.applyPlaylist(playlist({ segments: segs(0, seq + 1) }), { fetchedAt: seq });
  }
  assert.ok(t.windowRange().start > 2);
});

test('re-advertising an evicted number with the same content does not remint time', () => {
  const t = new ReplayTimeline({ retainSeconds: 4 });
  // Seed a full window; retention evicts the earliest segments.
  t.applyPlaylist(playlist({ segments: segs(0, 40) }));
  const before = t.windowRange();
  // The origin re-advertises a sliding suffix that still names an evicted low
  // sequence using the identical URI, alongside one genuinely new segment. The
  // evicted re-advertised numbers are recognised as already-known and skipped;
  // only the new segment (40) extends the axis, so the start is unchanged and
  // the end advances by exactly one segment.
  const suffix = segs(15, 26); // sequences 15..40, URI segN.m4s unchanged
  t.applyPlaylist(playlist({ mediaSequence: 15, segments: suffix }));
  const after = t.windowRange();
  // The axis advances by exactly the one genuinely new segment (40); evicted
  // re-advertised numbers add no phantom time. The left edge rolls normally by
  // one segment rather than jumping.
  assert.equal(after.end, before.end + 1);
  assert.ok(after.start >= before.start);
  // No duplicate/phantom entry for the re-advertised evicted numbers.
  const sequences = t.live.map((e) => e.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.ok(sequences.every((s) => s >= 15));
});

test('reusing a sequence number for different content retires the old mapping', () => {
  const t = new ReplayTimeline({ retainSeconds: 100 });
  t.applyPlaylist(playlist({ segments: segs(0, 4) }));
  const original = t.resolveSequence(2);
  // Same number 2, different URI: the kernel treats it as new content.
  const reused = playlist({
    mediaSequence: 2,
    segments: [
      { sequence: 2, duration: 1, uri: 'seg2-remuxed.m4s' },
      { sequence: 3, duration: 1, uri: 'seg3.m4s' },
    ],
  });
  t.applyPlaylist(reused);
  const reminted = t.resolveSequence(2);
  assert.notEqual(reminted.uri, original.uri);
  assert.ok(reminted.playbackStart >= original.playbackStart);
});

test('evicted playback lookup uses the bounded tombstone ring for relocation', () => {
  const t = new ReplayTimeline({ retainSeconds: 4 });
  t.applyPlaylist(playlist({ segments: segs(0, 40) }));
  // A time inside the most recently evicted segment returns that tombstone.
  const range = t.windowRange();
  const target = range.start - 0.5;
  try {
    t.resolvePlayback(target);
    assert.fail('expected EVICTED');
  } catch (error) {
    assert.ok(error instanceof WindowError);
    assert.equal(error.code, 'EVICTED');
    assert.equal(error.relocatedTo, range.start);
    assert.ok(error.evictedRange, 'a nearby tombstone must be reported');
    assert.ok(error.evictedRange.end > target);
  }
});

test('index stats expose the cost counters without hiding zero work', () => {
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({ segments: segs(0, 6) }));
  t.resolvePlayback(1.5);
  t.resolvePlayback(1.5);
  const stats = t.indexStats;
  assert.equal(stats.resolvePlayback.calls, 2);
  assert.equal(stats.resolvePlayback.binarySearchSteps, 2);
  assert.equal(stats.ingests, 1);
  assert.equal(stats.evictions, 0);
  // No eviction has happened, so the eviction counters must honestly read zero
  // rather than being initialised to a flattering default.
  assert.equal(stats.evictedTotal, 0);
  assert.equal(stats.prunedTombstones, 0);
  assert.equal(stats.hold, null);
});

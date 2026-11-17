import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveKernel, WindowError } from '../src/kernel/live-kernel.mjs';
import { parseMediaPlaylist, ManifestError } from '../src/kernel/manifest.mjs';

let clock = 1_000_000;
const now = () => clock;
function tick(ms = 6_000) {
  clock += ms;
  return clock;
}

function seg(msn, dur = 6, extra = {}) {
  return { msn, durationMs: dur * 1000, uri: `seg-${msn}.m4s`, gap: false, discontinuityBefore: false, ...extra };
}

function manifest(segments, extra = {}) {
  return {
    sourceUrl: 'http://local/live/index.mpd.m3u8',
    targetDuration: 6,
    mediaSequence: segments[0].msn,
    discontinuitySequenceBase: 0,
    playlistType: 'EVENT',
    ended: false,
    frameRate: 30,
    map: { uri: 'init.mp4' },
    issues: [],
    segments,
    ...extra,
  };
}

function freshKernel() {
  clock = 1_000_000;
  return new LiveKernel({ now, staleAfterMs: 20_000, relocationToleranceMs: 5_000 });
}

test('parser keeps sequence, duration, and declared date separate', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-DISCONTINUITY-SEQUENCE:2',
    '#EXT-X-FRAME-RATE:30',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.0,',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-17T04:00:00.000Z',
    '#EXT-X-FRAME-INDEX:3000',
    'a.m4s',
    '#EXTINF:4.5,',
    'b.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-17T04:00:20.000Z',
    '#EXTINF:6,',
    'c.m4s',
    '#EXT-X-GAP',
    '#EXTINF:6,',
    'd.m4s',
  ].join('\n');
  const parsed = parseMediaPlaylist(text);
  assert.equal(parsed.mediaSequence, 100);
  assert.equal(parsed.segments[0].msn, 100);
  assert.equal(parsed.segments[1].msn, 101);
  assert.equal(parsed.segments[2].msn, 102);
  assert.equal(parsed.segments[0].programDateTimeMs, Date.parse('2026-11-17T04:00:00.000Z'));
  assert.equal(parsed.segments[1].programDateTimeMs, null, 'date must not be inherited by parser');
  assert.equal(parsed.segments[2].discontinuityBefore, true);
  assert.equal(parsed.segments[3].gap, true);
  assert.equal(parsed.segments[0].frameIndex, 3000);
  assert.equal(parsed.segments[2].programDateTimeMs, Date.parse('2026-11-17T04:00:20.000Z'));
});

test('malformed manifests are rejected', () => {
  assert.throws(() => parseMediaPlaylist('not a playlist'), ManifestError);
  assert.throws(
    () => parseMediaPlaylist('#EXTM3U\n#EXTINF:6,\njavascript:alert(1)'),
    /unsupported segment URI scheme/,
  );
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6'), /no segments/);
  const ok = parseMediaPlaylist(
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:6,\na.m4s',
  );
  assert.equal(ok.segments[0].msn, 5);
});

test('media time is stable across polls and advances by declared durations only', () => {
  const kernel = freshKernel();
  let r = kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  assert.equal(r.ok, true);
  assert.equal(r.view.endMs, 18_000);
  assert.equal(r.view.startMs, 0);

  tick();
  r = kernel.ingest(manifest([seg(1), seg(2), seg(3)]));
  assert.equal(r.status, 'window-updated');
  // Segment 1 must keep its absolute media time.
  const s1 = r.view.entries.find((e) => e.msn === 1);
  assert.equal(s1.startMs, 6_000);
  assert.equal(r.view.startMs, 6_000);
  assert.equal(r.view.endMs, 24_000);
  // The evicted target must be reported, not remapped.
  const located = r.view.locate(3_000);
  assert.equal(located.status, 'evicted');
  assert.equal(located.reason, 'window-rolled');
});

test('duration sum is not presented as a capture date', () => {
  const kernel = freshKernel();
  const t0 = Date.parse('2026-11-17T04:00:00Z');
  const r = kernel.ingest(
    manifest([
      seg(0, 6, { programDateTimeMs: t0 }),
      seg(1, 6, { programDateTimeMs: t0 + 6_000 }),
      seg(2, 6, { programDateTimeMs: t0 + 12_000 }),
    ]),
  );
  const entry = r.view.entries[1];
  assert.equal(entry.startMs, 6_000, 'media time is duration-derived');
  assert.equal(entry.declaredStartMs, t0 + 6_000, 'declared date is source-derived');
  // If the source declares a date that disagrees, media time must not move.
  const t1 = Date.parse('2026-11-17T05:00:00Z');
  const r2 = kernel.ingest(
    manifest([
      seg(1, 6, { programDateTimeMs: t1 }),
      seg(2, 6, { programDateTimeMs: t1 + 6_000 }),
      seg(3, 6, { programDateTimeMs: t1 + 12_000 }),
    ]),
  );
  const s1 = r2.view.entries.find((e) => e.msn === 1);
  assert.equal(s1.startMs, 6_000, 'a date jump must not rewrite media time');
  assert.equal(s1.declaredStartMs, t1);
});

test('declared date drift is surfaced, not blended', () => {
  const kernel = freshKernel();
  const t0 = Date.parse('2026-11-17T04:00:00Z');
  const r = kernel.ingest(
    manifest([
      seg(0, 6, { programDateTimeMs: t0 }),
      seg(1, 6, { programDateTimeMs: t0 + 6_000 }),
      seg(2, 6, { programDateTimeMs: t0 + 60_000 }),
    ]),
  );
  const issue = r.issues.find((i) => i.code === 'declared-date-media-drift');
  assert.ok(issue, 'drift must be reported');
  assert.equal(r.view.entries[2].startMs, 12_000);
});

test('discontinuity starts a new epoch but keeps media time contiguous', () => {
  const kernel = freshKernel();
  const r = kernel.ingest(
    manifest([
      seg(0, 6),
      seg(1, 6),
      seg(2, 6, { discontinuityBefore: true }),
      seg(3, 6),
    ]),
  );
  assert.equal(r.view.entries[2].epoch, 1);
  assert.equal(r.view.entries[2].startMs, 12_000);
  assert.equal(r.view.entries[3].startMs, 18_000);
  assert.ok(r.view.entries[2].discontinuityBefore);
});

test('a media-sequence reset starts a new relation and evicts the old window', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(100), seg(101), seg(102)]));
  const before = kernel.snapshot();
  tick();
  const r = kernel.ingest(manifest([seg(1), seg(2), seg(3)]));
  assert.equal(r.status, 'relation-reset');
  assert.equal(r.reset, 'media-sequence-reset');
  assert.notEqual(r.view.relation.id, before.relation.id);
  // A reset must continue on a monotone timeline, not restart at zero, or an
  // old target could silently point at new content.
  assert.ok(r.view.startMs >= before.endMs);
  const old = r.view.locate(before.startMs + 1);
  assert.equal(old.status, 'evicted');
  assert.equal(old.reason, 'relation-reset');
  const decision = r.view.resolveStart(before.startMs + 1);
  assert.equal(decision.ok, false);
  assert.equal(decision.action, 'refuse');
});

test('a missing segment creates a timeline break and is not silently closed', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2), seg(3)]));
  tick();
  // msn 2 disappears entirely from the manifest, but 0,1,3 remain.
  const r = kernel.ingest(manifest([seg(0), seg(1), seg(3), seg(4)]));
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.code === 'segment-gap' && i.beforeMsn === 3));
  const e3 = r.view.entries.find((e) => e.msn === 3);
  assert.equal(e3.timelineBreakBefore, true);
  assert.deepEqual(e3.missingBefore, [2]);
  // Media time of the survivor does not shift, and missing msn 2 is a hole.
  assert.equal(e3.startMs, 18_000);
  const hole = r.view.locate(12_000);
  assert.equal(hole.status, 'gap');
  assert.equal(hole.reason, 'missing-segment');
  // The hole is genuine, so it is explicitly refused rather than jumped over
  // as if the content were continuous.
  const refused = r.view.resolveStart(12_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'gap');
  // The window itself only covers the unbroken tail run: the missing msn makes
  // the earlier segments non-adjacent, so they are not advertised as playable.
  assert.equal(r.view.window.startMs, 18_000);
  // And a published segment outside that run is reported as such, not served.
  const outside = r.view.locate(6_500);
  assert.equal(outside.status, 'evicted');
});

test('a declared EXT-X-GAP is reported and refused, never silently jumped', () => {
  const kernel = freshKernel();
  const r = kernel.ingest(manifest([seg(0), seg(1, 6, { gap: true }), seg(2)]));
  const located = r.view.locate(7_000);
  assert.equal(located.status, 'gap');
  assert.equal(located.reason, 'declared-gap');
  const issue = r.view.issues.find((i) => i.code === 'declared-gap');
  assert.equal(issue.msn, 1);
  // A declared gap keeps its sequence slot, so the numbering after it stays
  // aligned: it is not mistaken for a sequence hole or a reset.
  assert.equal(r.view.entries[2].msn, 2);
  assert.equal(r.view.relation.resetCount, 0);
  const refused = r.view.resolveStart(7_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'gap');
  // A playable position after the gap is still reachable.
  const ok = r.view.resolveStart(13_000);
  assert.equal(ok.ok, true);
  assert.equal(ok.action, 'play');
});

test('a media-sequence jump forward leaves an explicit hole at the jump point', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  const beforeStart = kernel.snapshot().window.endMs; // 18000
  tick();
  // The source jumps from 2 to 40 with no overlap at all.
  const r = kernel.ingest(manifest([seg(40), seg(41), seg(42)]));
  assert.equal(r.ok, true);
  // The new content must be placed *after* the old timeline, never remapped
  // onto the old media time.
  assert.ok(r.view.window.startMs >= beforeStart);
  const first = r.view.entries[0];
  assert.equal(first.msn, 40);
  assert.ok(first.startMs >= beforeStart);
  // The unseen msns are an explicit zero-length break: their duration is
  // unknown, so inventing a bridge would fabricate timeline.
  const hole = r.view.holes[0];
  assert.ok(hole, 'hole recorded');
  assert.equal(hole.reason, 'sequence-jump');
  assert.equal(hole.startMs, beforeStart);
  assert.equal(hole.endMs, beforeStart);
  assert.equal(r.view.locate(beforeStart).status, 'playable');
  // Anything before the new window is explicitly outside it.
  assert.equal(r.view.locate(beforeStart - 1).status, 'evicted');
  // The old target is reported as no longer current, not silently playable.
  const stale = r.view.resolveStart(1_000);
  assert.equal(stale.ok, false);
  // Forward-looking playback of the new content still works.
  const fresh = r.view.resolveStart(r.view.window.startMs + 1_000);
  assert.equal(fresh.ok, true);
});

test('evicted targets are refused, not endlessly requested', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  for (let i = 1; i <= 5; i++) {
    tick();
    kernel.ingest(manifest([seg(i), seg(i + 1), seg(i + 2)]));
  }
  const view = kernel.snapshot();
  // Window start is now 30s. A request for 1s is far behind.
  const decision = view.resolveStart(1_000);
  assert.equal(decision.ok, false);
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.reason, 'window-rolled');
  // A target only just behind is relocated explicitly within tolerance.
  const near = view.resolveStart(view.startMs - 1_000);
  assert.equal(near.ok, true);
  assert.equal(near.action, 'relocate');
  assert.equal(near.relocatedMs, view.startMs);
  // A target ahead of the edge is refused.
  const ahead = view.resolveStart(view.endMs + 1_000);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.reason, 'ahead-of-live-edge');
});

test('segmentsBetween returns exactly the intersecting request set', () => {
  const kernel = freshKernel();
  const r = kernel.ingest(manifest([seg(0), seg(1), seg(2), seg(3)]));
  const view = r.view;
  const set = view.segmentsBetween(5_000, 13_000).map((e) => e.msn);
  assert.deepEqual(set, [0, 1, 2]);
  const none = view.segmentsBetween(24_000, 30_000);
  assert.deepEqual(none, []);
});

test('stale manifest retains last confirmed window but is not live', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  const before = kernel.snapshot();
  clock += 21_000; // beyond staleAfterMs
  // Simulate a failed poll.
  const r = kernel.ingest(new Error('network down'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 'retained');
  assert.equal(r.view.window.startMs, before.window.startMs);
  assert.equal(r.view.window.endMs, before.window.endMs);
  assert.equal(r.view.freshness.state, 'stale');
  assert.equal(r.view.freshness.liveEdgeIsCurrent, false);
  assert.equal(r.view.isLive, false);
  assert.equal(r.view.isFresh, false);
  // The UI must not treat the retained end as a current live edge.
  assert.ok(r.view.freshness.ageMs >= 21_000);
});

test('a short transient failure inside the freshness budget is labelled unconfirmed', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  clock += 5_000;
  const r = kernel.ingest(new Error('timeout'));
  assert.equal(r.view.freshness.state, 'unconfirmed');
  assert.equal(r.view.freshness.liveEdgeIsCurrent, false);
  assert.equal(r.view.freshness.consecutiveFailures, 1);
  // Recovery returns to live.
  clock += 2_000;
  const rec = kernel.ingest(manifest([seg(0), seg(1), seg(2), seg(3)]));
  assert.equal(rec.view.freshness.state, 'live');
  assert.equal(rec.view.freshness.consecutiveFailures, 0);
});

test('window size is bounded and old layout entries are evicted from history', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  for (let i = 1; i <= 4; i++) {
    tick();
    kernel.ingest(manifest([seg(i), seg(i + 1), seg(i + 2)]));
  }
  const diag = kernel.diagnostics();
  const evicted = diag.events.filter((e) => e.type === 'window-eviction');
  assert.ok(evicted.length >= 4);
  for (const e of evicted) assert.ok(e.endMs <= kernel.snapshot().window.startMs);
});

test('parser gap and duplicate checks are reported as issues', () => {
  const kernel = freshKernel();
  const r = kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  tick();
  const dup = kernel.ingest(manifest([seg(1), seg(1), seg(2)]));
  assert.equal(dup.ok, true);
  assert.ok(dup.issues.some((i) => i.code === 'duplicate-media-sequence'));
  assert.ok(r.ok);
});

test('resolveStart never returns a target that no longer exists', () => {
  const kernel = freshKernel();
  kernel.ingest(manifest([seg(0), seg(1), seg(2)]));
  for (let i = 1; i <= 6; i++) {
    tick();
    kernel.ingest(manifest([seg(i), seg(i + 1), seg(i + 2)]));
  }
  const view = kernel.snapshot();
  for (let t = 0; t <= 200_000; t += 2_500) {
    const d = view.resolveStart(t);
    if (d.ok) {
      assert.ok(d.mediaTimeMs >= view.startMs && d.mediaTimeMs < view.endMs);
      const segAt = view.segmentAt(d.mediaTimeMs);
      assert.ok(segAt, `resolved target at ${t} must map to a real segment`);
      assert.equal(segAt.gap, false);
    } else {
      assert.ok(d.reason, 'refusal must carry a reason');
    }
  }
});

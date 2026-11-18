import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayTimeline, WindowError } from '../src/kernel/timeline.js';
import { parseMediaPlaylist, PlaylistError } from '../src/kernel/playlist.js';

const BASE = 'http://origin.test/live/live.m3u8';

function playlist({ mediaSequence = 0, discSequence = 0, segments, endList = false }) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discSequence}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  if (endList) lines.push('#EXT-X-ENDLIST');
  for (const s of segments) {
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.pdt) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.pdt}`);
    if (s.frames) lines.push(`#EXT-X-FRAME-RANGE:${s.frames}`);
    if (s.gap) lines.push('#EXT-X-GAP');
    lines.push(`#EXTINF:${s.duration},`);
    lines.push(s.uri ?? `seg${s.sequence}.m4s`);
  }
  return parseMediaPlaylist(lines.join('\n'), BASE);
}

function segs(start, count, { duration = 2, ...rest } = {}) {
  return Array.from({ length: count }, (_, i) => ({ sequence: start + i, duration, ...rest }));
}

test('parse separates sequence, duration and declared date', () => {
  const pl = playlist({
    mediaSequence: 40,
    segments: [
      { sequence: 40, duration: 2, pdt: '2026-01-01T00:00:00.000Z', frames: '100-159' },
      { sequence: 41, duration: 1.5, pdt: '2026-01-01T00:00:02.000Z', frames: '160-204' },
    ],
  });
  assert.equal(pl.mediaSequence, 40);
  assert.equal(pl.segments[0].sequence, 40);
  assert.equal(pl.segments[1].sequence, 41);
  assert.equal(pl.segments[0].duration, 2);
  assert.equal(pl.segments[1].duration, 1.5);
  assert.equal(pl.segments[0].declaredPdt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(pl.segments[0].frameRange, { first: 100, last: 159 });
  assert.equal(pl.segments[0].init.uri, 'http://origin.test/live/init.mp4');
});

test('parse rejects malformed playlists instead of guessing', () => {
  assert.throws(() => parseMediaPlaylist('', BASE), PlaylistError);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\nseg0.m4s\n', BASE), PlaylistError);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:abc,\nseg0.m4s\n', BASE), PlaylistError);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:2,\n', BASE), PlaylistError);
});

test('playback time accumulates only forward and ignores sequence gaps', () => {
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({ mediaSequence: 10, segments: segs(10, 3) }));
  let w = t.window;
  assert.equal(w.start, 0);
  assert.equal(w.end, 6);
  // The upstream jumps ahead by ten sequence numbers (it skipped some). The
  // skipped numbers are not time: the new segments continue the axis, while
  // segments the origin no longer advertises are refused.
  t.applyPlaylist(playlist({ mediaSequence: 20, segments: segs(20, 2) }));
  w = t.window;
  assert.equal(w.start, 6);
  assert.equal(w.end, 10);
  assert.deepEqual(
    w.segments.map((s) => [s.sequence, s.playbackStart, s.playbackEnd]),
    [[20, 6, 8], [21, 8, 10]],
  );
  assert.throws(() => t.resolveSequence(11), (e) => e.code === 'EVICTED' && e.relocatedTo === 6);
});

test('declared dates never become playback time', () => {
  const t = new ReplayTimeline();
  // Wildly inconsistent PDTs: 10-hour jump backwards then forwards.
  t.applyPlaylist(playlist({
    mediaSequence: 0,
    segments: [
      { sequence: 0, duration: 2, pdt: '2026-01-01T00:00:00.000Z' },
      { sequence: 1, duration: 2, pdt: '2025-12-31T14:00:00.000Z' },
      { sequence: 2, duration: 2, pdt: '2026-01-02T03:00:00.000Z' },
    ],
  }));
  const w = t.window;
  assert.deepEqual(
    w.segments.map((s) => [s.playbackStart, s.playbackEnd]),
    [[0, 2], [2, 4], [4, 6]],
  );
  assert.equal(w.segments[2].declaredPdt, Date.parse('2026-01-02T03:00:00.000Z'));
});

test('a discontinuity opens a new run instead of adding up old durations', () => {
  const t = new ReplayTimeline({ gapSeconds: 5 });
  t.applyPlaylist(playlist({
    mediaSequence: 0,
    segments: [
      { sequence: 0, duration: 2 },
      { sequence: 1, duration: 2 },
      { sequence: 2, duration: 2, discontinuity: true },
      { sequence: 3, duration: 2 },
    ],
  }));
  const w = t.window;
  assert.equal(w.runs.length, 2);
  assert.deepEqual(
    w.segments.map((s) => [s.sequence, s.playbackStart, s.playbackEnd, s.runId]),
    [
      [0, 0, 2, 'r0.0'],
      [1, 2, 4, 'r0.0'],
      [2, 9, 11, 'r0.1'],
      [3, 11, 13, 'r0.1'],
    ],
  );
  assert.equal(w.runs[1].playbackStart, 9, 'new run starts a declared gap after the previous run');
});

test('a new discontinuity sequence without an explicit tag also opens a run', () => {
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({
    mediaSequence: 5,
    discSequence: 2,
    segments: [
      { sequence: 5, duration: 2 },
      { sequence: 6, duration: 2 },
    ],
  }));
  t.applyPlaylist(playlist({
    mediaSequence: 6,
    discSequence: 3,
    segments: [
      { sequence: 6, duration: 2 },
      { sequence: 7, duration: 2, discontinuity: true },
    ],
  }));
  const w = t.window;
  assert.equal(w.runs.length, 2);
  assert.equal(w.segments.at(-1).runId, 'r0.1');
  assert.equal(w.segments.at(-1).playbackStart, 4);
  // EXT-X-DISCONTINUITY increments the declared discontinuity sequence.
  assert.equal(w.runs[1].discontinuitySequence, 4);
});

test('evicted playback positions are refused with a relocation, not fetched', () => {
  const t = new ReplayTimeline({ retainSeconds: 6 });
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, 10) }));
  // Playback axis is 0..20s, retain 6 → left edge at 14.
  const w = t.window;
  assert.equal(w.end, 20);
  assert.equal(w.start, 14);
  assert.throws(
    () => t.resolvePlayback(3),
    (error) => {
      assert.ok(error instanceof WindowError);
      assert.equal(error.code, 'EVICTED');
      assert.equal(error.relocatedTo, 14);
      assert.ok(error.available.start === 14);
      return true;
    },
  );
  // Eviction also shows up in the snapshot so UIs can draw the dead band.
  const evicted = t.snapshot().evictedRanges;
  assert.ok(evicted.some((e) => e.playbackEnd > 3 && e.playbackStart < 14));
});

test('positions of surviving segments are stable as the window rolls', () => {
  const t = new ReplayTimeline({ retainSeconds: 100 });
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, 10) }));
  const before = t.window.segments.find((s) => s.sequence === 8);
  t.applyPlaylist(playlist({ mediaSequence: 6, segments: segs(6, 10) }));
  const after = t.window.segments.find((s) => s.sequence === 8);
  assert.equal(after.playbackStart, before.playbackStart);
  assert.equal(after.playbackEnd, before.playbackEnd);
});

test('old sequence numbers resolve or are explicitly refused', () => {
  const t = new ReplayTimeline({ retainSeconds: 6 });
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, 5) }));
  t.applyPlaylist(playlist({ mediaSequence: 4, segments: segs(4, 6) }));
  const live = t.resolveSequence(8);
  assert.equal(live.playbackStart, 16);
  assert.throws(
    () => t.resolveSequence(1),
    (error) => {
      assert.equal(error.code, 'EVICTED');
      assert.equal(error.relocatedSequence, 7);
      assert.equal(error.relocatedTo, 14);
      return true;
    },
  );
  assert.throws(() => t.resolveSequence(999), (e) => e.code === 'UNKNOWN_SEQUENCE');
});

test('stale manifest keeps the confirmed range and reports freshness', () => {
  let clock = 1_000;
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, 3) }), { fetchedAt: clock });
  const confirmed = t.window;
  clock = 1_000 + 7_500;
  t.notePlaylistFailure(new Error('origin timeout'), { at: clock });
  const fresh = t.freshness;
  assert.equal(fresh.fresh, false);
  assert.equal(fresh.lastConfirmedAt, 1_000);
  assert.match(fresh.lastError.message, /timeout/);
  // The last confirmed range is retained, not dropped and not extended.
  assert.deepEqual(t.window.segments.map((s) => s.sequence), confirmed.segments.map((s) => s.sequence));
  assert.equal(t.window.end, confirmed.end);
});

test('a sequence reset starts a new epoch and retires the old axis', () => {
  const t = new ReplayTimeline({ retainSeconds: 100 });
  t.applyPlaylist(playlist({
    mediaSequence: 50,
    segments: [
      { sequence: 50, duration: 2 },
      { sequence: 51, duration: 2 },
    ],
  }));
  assert.equal(t.epoch, 0);
  assert.equal(t.window.end, 4);
  const result = t.applyPlaylist(playlist({
    mediaSequence: 0,
    segments: [
      { sequence: 0, duration: 2 },
      { sequence: 1, duration: 2 },
    ],
  }));
  assert.equal(result.reset, true);
  assert.equal(t.epoch, 1);
  // Old sequences are gone from the new epoch and cannot be requested.
  assert.throws(() => t.resolveSequence(50), (e) => e.code === 'UNKNOWN_SEQUENCE');
  // Playback continues forward on a fresh run rather than rewinding.
  const w = t.window;
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].epoch, 1);
  assert.equal(w.segments[0].playbackStart, 4);
  // A genuinely new sequence is available in the new epoch.
  const entry = t.resolveSequence(1);
  assert.equal(entry.epoch, 1);
});

test('declared gaps are represented and never playable', () => {
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({
    mediaSequence: 0,
    segments: [
      { sequence: 0, duration: 2 },
      { sequence: 1, duration: 2, gap: true },
      { sequence: 2, duration: 2 },
    ],
  }));
  const w = t.window;
  assert.equal(w.end, 6, 'the gap still occupies declared time');
  const resolved = t.resolvePlayback(3);
  assert.equal(resolved.status, 'gap');
  assert.equal(resolved.relocatedTo, 4);
  assert.equal(t.resolvePlayback(1).status, 'ok');
});

test('resolvePlayback refuses future positions and reports the boundary', () => {
  const t = new ReplayTimeline();
  t.applyPlaylist(playlist({ mediaSequence: 0, segments: segs(0, 2) }));
  assert.throws(
    () => t.resolvePlayback(9),
    (e) => e.code === 'AHEAD_OF_WINDOW' && e.available.end === 4,
  );
});

test('playlist durations are used as declared, not invented from time of day', () => {
  const t = new ReplayTimeline();
  // A source declares a 3s segment where the nominal frame budget says 2s.
  t.applyPlaylist(playlist({
    mediaSequence: 0,
    segments: [
      { sequence: 0, duration: 3, pdt: '2026-01-01T00:00:00.000Z' },
      { sequence: 1, duration: 3, pdt: '2026-01-01T00:00:02.000Z' },
    ],
  }));
  assert.deepEqual(t.window.segments.map((s) => s.playbackEnd), [3, 6]);
});

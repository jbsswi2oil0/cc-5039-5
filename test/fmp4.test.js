import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInit, segmentStats, rewriteSegmentTimeline } from '../src/kernel/fmp4.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncodeSource } from '../src/source/encode-source.js';
import { decodeBarcodeFromPixels } from '../src/source/barcode.js';

test('init parsing reports both tracks and their own timescales', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-fmp4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await new EncodeSource({ dir, segmentFrames: 10 }).init();
  await source.advance(2);
  const init = await readFile(source.initPath());
  const info = parseInit(init);
  assert.equal(info.tracks.length, 2);
  const video = info.tracks.find((tr) => tr.handlerType === 'vide');
  const audio = info.tracks.find((tr) => tr.handlerType === 'soun');
  assert.equal(video.timescale, 15360);
  assert.equal(audio.timescale, 48000);
});

test('rewriting tfdt moves a segment onto the kernel axis, preserving A/V offset', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-fmp4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await new EncodeSource({ dir, segmentFrames: 10 }).init();
  await source.advance(2);
  const init = await readFile(source.initPath());
  const info = parseInit(init);
  const raw = await readFile(source.segmentPath(1));

  const original = segmentStats(raw, info);
  assert.equal(original.find((s) => s.trackId === 1).startSeconds, 0);

  const shifted = rewriteSegmentTimeline(raw, 17.25, info);
  const stats = segmentStats(shifted, info);
  const video = stats.find((s) => s.trackId === 1);
  const audio = stats.find((s) => s.trackId === 2);
  assert.equal(video.startSeconds, 17.25);
  assert.equal(audio.startSeconds, 17.25);
  // Sample counts and durations are untouched: no frame duplication.
  assert.equal(video.samples, original.find((s) => s.trackId === 1).samples);
  assert.equal(
    video.durationSeconds,
    original.find((s) => s.trackId === 1).durationSeconds,
  );
});

test('segments carry exactly the declared number of frames and their barcode ids', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-fmp4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frames = 12;
  const source = await new EncodeSource({ dir, segmentFrames: frames, fps: 30 }).init();
  await source.advance(3);
  const init = await readFile(source.initPath());
  const info = parseInit(init);

  for (const sequence of [0, 1, 2]) {
    const segment = await readFile(source.segmentPath(sequence));
    const video = segmentStats(segment, info).find((s) => s.trackId === 1);
    assert.equal(video.samples, frames, `segment ${sequence} sample count`);
    assert.equal(video.durationSeconds, frames / 30);
  }
  // The frame ids encoded in the picture must match the declared frame range.
  const range = source.frameForSequence(1);
  assert.deepEqual(range, { first: frames, last: frames * 2 - 1 });
});

test('a source whose declared dates are stale still yields a coherent axis', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-fmp4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await new EncodeSource({
    dir,
    segmentFrames: 6,
    scenarios: { declareStalePdt: true },
  }).init();
  await source.advance(3);
  const { parseMediaPlaylist } = await import('../src/kernel/playlist.js');
  const { ReplayTimeline } = await import('../src/kernel/timeline.js');
  const pl = parseMediaPlaylist(source.manifest(), 'http://origin/live/live.m3u8');
  const timeline = new ReplayTimeline();
  timeline.applyPlaylist(pl);
  const w = timeline.window;
  assert.equal(w.end, 0.6);
  // Declared dates are a full hour behind the nominal camera clock, but they
  // are only metadata: playback positions are unaffected.
  const declared = w.segments.map((s) => s.declaredPdt);
  assert.ok(declared.every((d) => d < source.startDate));
});

test('barcode reader can recover ids from a decoded frame', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-fmp4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await new EncodeSource({ dir, segmentFrames: 4 }).init();
  await source.advance(1);
  const init = await readFile(source.initPath());
  const raw = await readFile(source.segmentPath(0));
  const { execFileSync } = await import('node:child_process');
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const { writeFile } = await import('node:fs/promises');
  const combined = path.join(dir, 'combined.mp4');
  await writeFile(combined, Buffer.concat([init, raw]));
  const pixels = execFileSync(
    ffmpegPath,
    ['-v', 'error', '-i', combined, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  const frameBytes = 640 * 360 * 3;
  const count = pixels.length / frameBytes;
  // Decoding init+fragment as a standalone file makes ffmpeg emit the first
  // picture twice (edit list handling). The encoded pictures themselves are
  // the final `segmentFrames` outputs.
  assert.equal(count, 5);
  const ids = [];
  for (let i = count - 4; i < count; i++) {
    ids.push(
      decodeBarcodeFromPixels(
        pixels.subarray(i * frameBytes, (i + 1) * frameBytes),
        640,
        640 * 3,
        3,
        360,
      ).frameId,
    );
  }
  assert.deepEqual(ids, [0, 1, 2, 3]);
});

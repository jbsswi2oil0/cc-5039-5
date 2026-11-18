// Dynamic encode source.
//
// The source models a live camera: it owns capture frame numbers and a
// source-declared program date, then encodes bounded chunks of frames into
// independently decodable fMP4 fragments. The manifest it publishes is only a
// declaration; playback time is reconstructed by the kernel from durations and
// discontinuities, never from segment counts or declared dates.
//
// Scenario knobs let tests inject the failure modes the kernel must survive:
// sequence resets, missing segments, delayed publication, and discontinuities.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { BARCODE, drawBarcode } from './barcode.js';
import { drawText } from './text.js';
import { parseInit, segmentStats } from '../kernel/fmp4.js';

export const WIDTH = BARCODE.width;
export const HEIGHT = BARCODE.height;
export const FPS = 30;

export class EncodeSource {
  constructor({
    dir,
    segmentFrames = 30,
    fps = FPS,
    scenarios = {},
    startDate = Date.parse('2026-03-14T18:00:00.000Z'),
    upstreamWindowSegments = 30,
  } = {}) {
    if (!dir) throw new Error('EncodeSource requires a directory');
    this.dir = dir;
    this.segmentFrames = segmentFrames;
    this.fps = fps;
    this.startDate = startDate;
    this.upstreamWindowSegments = upstreamWindowSegments;
    this.scenarios = {
      resetAtSequence: null,
      gapSequences: [],
      publishLagSegments: 0,
      declareStalePdt: false,
      pdtOffsetMs: 0,
      ...scenarios,
    };

    this.sequence = 0;
    this.captureFrame = 0;
    this.discontinuitySequence = 0;
    this.initUri = '/live/init.mp4';
    this.initBytes = null;
    this.initFingerprint = null;

    this.published = [];
    this.allPublished = [];
    this.queue = Promise.resolve();
    this.segments = new Map();
    this.pendingDelay = new Map();
    this.notes = [];
    this.framesBySequence = new Map();
    this.runCounter = 0;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    return this;
  }

  note(message, at = Date.now()) {
    this.notes.push({ at, message });
    if (this.notes.length > 80) this.notes.shift();
  }

  get delayedCount() {
    return this.pendingDelay.size;
  }

  async advance(count = 1) {
    const run = this.queue.then(async () => {
      for (let i = 0; i < count; i++) await this.encodeOne();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async encodeOne() {
    // A sequence reset restarts numbering and opens a new timing run, which is
    // exactly what an encoder restart looks like to the kernel.
    let restarted = false;
    if (
      this.scenarios.resetAtSequence !== null &&
      this.sequence === this.scenarios.resetAtSequence
    ) {
      this.note(`sequence reset at capture frame ${this.captureFrame}`);
      this.sequence = 0;
      this.discontinuitySequence += 1;
      this.runCounter += 1;
      restarted = true;
    }

    const sequence = this.sequence;
    const firstFrame = this.captureFrame;
    const lastFrame = firstFrame + this.segmentFrames - 1;
    const isGap = this.scenarios.gapSequences.includes(sequence);

    const nominalPdt = this.startDate + (firstFrame / this.fps) * 1000;
    const declaredPdt = this.scenarios.declareStalePdt
      ? new Date(nominalPdt - 3600_000).toISOString()
      : new Date(nominalPdt + this.scenarios.pdtOffsetMs).toISOString();

    let meta = null;
    if (!isGap) {
      meta = await this.encodeSegment({
        sequence,
        firstFrame,
        lastFrame,
        discontinuitySequence: this.discontinuitySequence,
      });
    } else {
      this.note(`declared gap at sequence ${sequence} (frames ${firstFrame}-${lastFrame})`);
    }

    const entry = {
      sequence,
      uri: meta ? `/live/seg/${meta.file}` : `/live/seg/gap-${sequence}.m4s`,
      duration: null, // filled from the encoded segment below
      frameRange: { first: firstFrame, last: lastFrame },
      discontinuitySequence: this.discontinuitySequence,
      declaredPdt,
      gap: isGap,
      file: meta?.file ?? null,
      bytes: meta?.bytes ?? 0,
    };
    entry.duration = meta ? meta.duration : this.segmentFrames / this.fps;

    if (restarted) {
      // The origin restarted: its published window starts over. The old window
      // stays visible until this first post-restart segment exists, so the
      // manifest never goes blank mid-restart.
      this.published = [];
      this.pendingDelay.clear();
    }

    this.segments.set(sequence, entry);
    this.framesBySequence.set(sequence, { first: firstFrame, last: lastFrame });

    this.allPublished.push(entry);
    const lag = this.scenarios.publishLagSegments;
    if (lag > 0 && entry.discontinuitySequence === 0 && this.pendingDelay.size < lag) {
      // The manifest lags the camera: the segment has been captured but the
      // origin has not published it yet.
      this.pendingDelay.set(sequence, entry);
      this.note(`manifest lags camera: sequence ${sequence} captured, not yet published`);
    } else {
      this.published.push(entry);
      this.flushLag();
      this.rollManifest();
    }

    this.captureFrame = lastFrame + 1;
    this.sequence += 1;
  }

  async encodeSegment({ sequence, firstFrame, lastFrame }) {
    const file = `s${String(sequence).padStart(5, '0')}-${firstFrame}-${lastFrame}.m4s`;
    const outPath = path.join(this.dir, file);
    const count = lastFrame - firstFrame + 1;
    const frames = Buffer.concat(
      Array.from({ length: count }, (_, i) => this.renderFrame(firstFrame + i)),
    );

    // The HLS muxer gives exact per-frame timing (the raw mp4 muxer shifts the
    // first video sample by AAC priming). It is used as a one-chunk muxer: the
    // scratch playlist and its part file are renamed into place below.
    const scratch = path.join(this.dir, `.scratch-${sequence}`);
    await mkdir(scratch, { recursive: true });
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${WIDTH}x${HEIGHT}`, '-r', String(this.fps),
      '-i', 'pipe:0',
      '-f', 'lavfi', '-i', `sine=frequency=${180 + (sequence % 7) * 40}:sample_rate=48000:duration=${count / this.fps}`,
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
      '-g', String(this.fps), '-keyint_min', String(this.fps), '-sc_threshold', '0', '-bf', '0',
      '-crf', '20', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-shortest',
      '-f', 'hls', '-hls_time', String(count / this.fps), '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(scratch, 'part%d.m4s'),
      '-hls_list_size', '0', path.join(scratch, 'out.m3u8'),
    ];
    await runFfmpeg(args, frames);

    const pieces = (await readdir(scratch)).filter((f) => f.endsWith('.m4s')).sort();
    const fragment = Buffer.concat(
      await Promise.all(pieces.map((p) => readFile(path.join(scratch, p)))),
    );
    const init = await readFile(path.join(scratch, 'init.mp4'));
    if (!this.initBytes) {
      this.initBytes = init;
      this.initFingerprint = createHash('sha256').update(init).digest('hex').slice(0, 16);
      await writeFile(path.join(this.dir, 'init.mp4'), init);
    }
    await writeFile(outPath, fragment);
    await rm(scratch, { recursive: true, force: true });
    const measured = measure(fragment, this.initBytes);
    return { file, bytes: fragment.length, duration: measured.duration };
  }

  renderFrame(frame) {
    const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const o = (y * WIDTH + x) * 3;
        const nudge = ((x >> 4) & 1) ^ ((y >> 4) & 1) ? 6 : 0;
        rgb[o] = 22 + nudge;
        rgb[o + 1] = 36 + nudge;
        rgb[o + 2] = 58 + nudge;
      }
    }
    // A moving marker makes a frozen picture obvious on screen.
    const cx = 40 + ((frame * 7) % (WIDTH - 80));
    const cy = 120 + Math.round(46 * Math.sin(frame / 18));
    for (let y = cy - 22; y <= cy + 22; y++) {
      for (let x = cx - 22; x <= cx + 22; x++) {
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > 484) continue;
        const o = (y * WIDTH + x) * 3;
        rgb[o] = 240;
        rgb[o + 1] = 190;
        rgb[o + 2] = 40;
      }
    }
    drawBarcode(rgb, WIDTH, frame);
    drawText(rgb, WIDTH, HEIGHT, `FRAME ${frame}`, 12, 12, 3, [240, 240, 240]);
    drawText(rgb, WIDTH, HEIGHT, `SRC ${(frame / this.fps).toFixed(2)} S`, 12, 44, 2, [170, 205, 240]);
    return rgb;
  }

  // ---- manifest -----------------------------------------------------------

  manifest({ endList = false, includeDelayed = false } = {}) {
    const base = this.published.slice();
    if (includeDelayed) {
      base.push(...this.pendingDelay.values());
      base.sort((a, b) => a.sequence - b.sequence);
    }
    const mediaSequence = base.length > 0 ? base[0].sequence : 0;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.ceil(this.segmentFrames / this.fps)}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discontinuitySequence}`,
      `#EXT-X-MAP:URI="${this.initUri}"`,
    ];
    if (endList) lines.push('#EXT-X-ENDLIST');
    let previousDisc = null;
    for (const entry of base) {
      if (previousDisc !== null && entry.discontinuitySequence !== previousDisc) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      previousDisc = entry.discontinuitySequence;
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${entry.declaredPdt}`);
      lines.push(`#EXT-X-FRAME-RANGE:${entry.frameRange.first}-${entry.frameRange.last}`);
      if (entry.gap) lines.push('#EXT-X-GAP');
      lines.push(`#EXTINF:${entry.duration.toFixed(6)},`);
      lines.push(entry.uri);
    }
    return lines.join('\n') + '\n';
  }

  // Publish held-back segments in sequence order once the origin catches up.
  flushLag() {
    if (this.pendingDelay.size === 0) return 0;
    const released = [...this.pendingDelay.values()].sort((a, b) => a.sequence - b.sequence);
    this.pendingDelay.clear();
    this.published.push(...released);
    this.published.sort((a, b) => a.sequence - b.sequence);
    this.note(`published ${released.length} lagging segment(s)`);
    return released.length;
  }

  releaseDelayed() {
    const released = this.flushLag();
    if (released) this.rollManifest();
    return released;
  }

  // A live origin only ever advertises a sliding suffix of its segments. This
  // is what makes MEDIA-SEQUENCE advance and what tells a consumer that older
  // segments have fallen out of the upstream window.
  rollManifest() {
    if (this.published.length <= this.upstreamWindowSegments) return;
    this.published = this.published.slice(-this.upstreamWindowSegments);
  }

  segmentPath(sequence) {
    const entry = this.segments.get(sequence);
    if (!entry || entry.gap) return null;
    return path.join(this.dir, entry.file);
  }

  frameForSequence(sequence) {
    return this.framesBySequence.get(sequence) ?? null;
  }

  initPath() {
    return path.join(this.dir, 'init.mp4');
  }

  describe() {
    return {
      sequence: this.sequence,
      captureFrame: this.captureFrame,
      delayed: this.pendingDelay.size,
      published: this.published.length,
      discontinuitySequence: this.discontinuitySequence,
      initFingerprint: this.initFingerprint,
      notes: this.notes.slice(-12),
    };
  }
}

function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

function measure(fragment, initBytes) {
  const info = parseInit(initBytes);
  const stats = segmentStats(fragment, info);
  const video = stats.find((s) => s.trackId === 1);
  return { duration: video ? video.durationSeconds : 0, stats };
}

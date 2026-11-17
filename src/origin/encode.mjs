import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderFrameBuffer } from '../shared/frame.mjs';

export const FPS = 30;
export const SEGMENT_SECONDS = 4;
export const SEGMENT_FRAMES = FPS * SEGMENT_SECONDS;

let ffmpegPath = null;
export async function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const mod = await import('ffmpeg-static');
  ffmpegPath = mod.default;
  return ffmpegPath;
}

const X264_ARGS = [
  '-c:v', 'libx264',
  '-profile:v', 'baseline',
  '-level', '3.0',
  '-preset', 'ultrafast',
  '-tune', 'zerolatency',
  '-g', String(SEGMENT_FRAMES),
  '-keyint_min', String(SEGMENT_FRAMES),
  '-sc_threshold', '0',
  '-bf', '0',
  '-pix_fmt', 'yuv420p',
  '-threads', '2',
  '-video_track_timescale', '90000',
  '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
  '-f', 'mp4',
];

export function ffmpegArgs({ width, height, output }) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${width}x${height}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    ...X264_ARGS,
    output,
  ];
}

// Encodes exactly `frames` camera frames starting at frameStart. Frames are
// rendered procedurally and streamed to ffmpeg, so segments are produced on
// demand rather than sliced from a pre-made file.
export async function encodeSegment({
  epoch,
  frameStart,
  frames = SEGMENT_FRAMES,
  gap = false,
  width,
  height,
}) {
  const output = Buffer.alloc(0).buffer;
  const bin = await resolveFfmpeg();
  const child = spawn(bin, ffmpegArgs({ width, height, output: 'pipe:1' }), {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  const flush = async (buf) => {
    if (!child.stdin.write(buf)) await once(child.stdin, 'drain');
  };

  for (let i = 0; i < frames; i += 1) {
    const { buffer } = renderFrameBuffer({ epoch, frame: frameStart + i, gap });
    await flush(buffer);
  }
  child.stdin.end();
  await exit;
  return Buffer.concat(chunks);
}

// Splits a fragmented MP4 into the shared init (ftyp+moov) and the media
// fragments (from the first moof onward).
export function splitInit(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    if (size < 8) throw new Error('invalid MP4 box size');
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'moof') {
      return { init: Buffer.from(buf.subarray(0, offset)), media: Buffer.from(buf.subarray(offset)) };
    }
    offset += size;
  }
  throw new Error('no moof box found');
}

// Rewrites the tfdt base media decode time of every moof/traf so the segment
// carries its absolute media start time. Multiple fragments in one file keep
// their relative spacing instead of all collapsing onto one timestamp.
export function patchTfdt(buf, baseMs, timescale = 90000) {
  const copy = Buffer.from(buf);
  const base = Math.round((baseMs * timescale) / 1000);
  let firstOriginal = null;
  const visit = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = copy.readUInt32BE(offset);
      if (size < 8) return;
      const type = copy.toString('latin1', offset + 4, offset + 8);
      if (type === 'tfdt') {
        const version = copy[offset + 8];
        const original =
          version === 1 ? Number(copy.readBigUInt64BE(offset + 12)) : copy.readUInt32BE(offset + 12);
        if (firstOriginal == null) firstOriginal = original;
        const written = base + (original - firstOriginal);
        if (version === 1) {
          copy.writeBigUInt64BE(BigInt(written), offset + 12);
        } else {
          copy.writeUInt32BE(written >>> 0, offset + 12);
        }
      } else if (type === 'moof' || type === 'traf' || type === 'moov' || type === 'mvex') {
        visit(offset + 8, offset + size);
      }
      offset += size;
    }
  };
  visit(0, copy.length);
  return copy;
}

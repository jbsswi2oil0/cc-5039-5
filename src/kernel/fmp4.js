// Minimal ISO-BMFF helpers for the fragmented MP4 segments produced by the
// live source. Segments are encoded independently, so the kernel re-anchors
// them onto its own playback axis by rewriting tfdt while preserving the
// relative offset between tracks inside a segment.

import { createHash } from 'node:crypto';

function readBoxHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }
  if (size < headerSize || offset + size > buf.length) return null;
  return { type, start: offset, size, headerSize };
}

export function childBoxes(buf, parent) {
  const start = parent.start + parent.headerSize;
  const end = parent.start + parent.size;
  const out = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(buf, offset);
    if (!box || box.start + box.size > end) break;
    out.push(box);
    offset += box.size;
  }
  return out;
}

export function topBoxes(buf) {
  return childBoxes(buf, { start: 0, headerSize: 0, size: buf.length });
}

function child(buf, parent, type) {
  return childBoxes(buf, parent).find((b) => b.type === type) ?? null;
}

export function parseInit(init) {
  const moov = topBoxes(init).find((b) => b.type === 'moov');
  if (!moov) throw new Error('init segment has no moov box');
  const tracks = [];
  for (const trak of childBoxes(init, moov).filter((b) => b.type === 'trak')) {
    const tkhd = child(init, trak, 'tkhd');
    const mdia = child(init, trak, 'mdia');
    const mdhd = mdia ? child(init, mdia, 'mdhd') : null;
    if (!tkhd || !mdhd) throw new Error('init track lacks tkhd/mdhd');
    const mdhdVersion = init[mdhd.start + mdhd.headerSize];
    const timescale = mdhdVersion === 1
      ? init.readUInt32BE(mdhd.start + mdhd.headerSize + 20)
      : init.readUInt32BE(mdhd.start + mdhd.headerSize + 12);
    const handler = child(init, mdia, 'hdlr');
    const handlerType = handler
      ? init.toString('latin1', handler.start + handler.headerSize + 8, handler.start + handler.headerSize + 12)
      : 'unknown';
    const trackId = init.readUInt32BE(tkhd.start + tkhd.headerSize + 12);
    const trex = topBoxes(init)
      .filter((b) => b.type === 'mvex')
      .flatMap((mvex) => childBoxes(init, mvex))
      .find((b) => {
        if (b.type !== 'trex') return false;
        return init.readUInt32BE(b.start + b.headerSize + 4) === trackId;
      });
    const defaultSampleDuration = trex ? init.readUInt32BE(trex.start + trex.headerSize + 12) : 0;
    tracks.push({ trackId, timescale, handlerType, defaultSampleDuration });
  }
  if (tracks.length === 0) throw new Error('init segment has no tracks');
  return {
    tracks,
    fingerprint: createHash('sha256').update(init).digest('hex').slice(0, 16),
  };
}

export function forEachTraf(segment, fn) {
  for (const moof of topBoxes(segment).filter((b) => b.type === 'moof')) {
    for (const traf of childBoxes(segment, moof).filter((b) => b.type === 'traf')) {
      const inner = childBoxes(segment, traf);
      const tfhd = inner.find((b) => b.type === 'tfhd');
      if (!tfhd) continue;
      fn({ moof, traf, inner, tfhd });
    }
  }
}

function readFullBox(segment, box) {
  const offset = box.start + box.headerSize;
  const version = segment[offset];
  const flags = segment.readUIntBE(offset + 1, 3);
  return { version, flags, body: offset + 4 };
}

export function readTfdt(segment, box) {
  const { version, body } = readFullBox(segment, box);
  const base = version === 1
    ? Number(segment.readBigUInt64BE(body))
    : segment.readUInt32BE(body);
  return { base, version, box };
}

// Sum sample durations per track. Values are in each track's own timescale.
export function segmentStats(segment, initInfo) {
  const defaults = new Map(
    initInfo.tracks.map((t) => [
      t.trackId,
      { sampleDuration: t.defaultSampleDuration, timescale: t.timescale },
    ]),
  );
  const perTrack = new Map();
  forEachTraf(segment, ({ inner, tfhd }) => {
    const trackId = segment.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
    const base = defaults.get(trackId);
    if (!base) throw new Error(`segment references unknown track ${trackId}`);
    const tfhdInfo = readFullBox(segment, tfhd);
    let defaultSampleDuration = base.sampleDuration;
    let cursor = tfhdInfo.body + 4; // skip track_ID
    if (tfhdInfo.flags & 0x000001) cursor += 8;
    if (tfhdInfo.flags & 0x000002) cursor += 4;
    if (tfhdInfo.flags & 0x000008) {
      defaultSampleDuration = segment.readUInt32BE(cursor);
      cursor += 4;
    }
    if (tfhdInfo.flags & 0x000010) cursor += 4;
    if (tfhdInfo.flags & 0x000020) cursor += 4;

    const tfdtBox = inner.find((b) => b.type === 'tfdt');
    const tfdt = tfdtBox ? readTfdt(segment, tfdtBox).base : 0;

    let samples = 0;
    let duration = 0;
    for (const trun of inner.filter((b) => b.type === 'trun')) {
      const info = readFullBox(segment, trun);
      let p = info.body;
      const sampleCount = segment.readUInt32BE(p);
      p += 4;
      if (info.flags & 0x000001) p += 4;
      if (info.flags & 0x000004) p += 4;
      let firstDuration = null;
      for (let i = 0; i < sampleCount; i++) {
        let d = defaultSampleDuration;
        if (info.flags & 0x000100) {
          d = segment.readUInt32BE(p);
          p += 4;
        }
        if (info.flags & 0x000200) p += 4;
        if (info.flags & 0x000400) p += 4;
        if (info.flags & 0x000800) p += 4;
        if (i === 0) firstDuration = d;
        duration += d;
        samples += 1;
      }
      if (firstDuration !== null) {
        // recorded for completeness; not used for axis
      }
    }
    const existing = perTrack.get(trackId) ?? { trackId, timescale: base.timescale, samples: 0, duration: 0, tfdt: null };
    existing.samples += samples;
    existing.duration += duration;
    existing.tfdt = existing.tfdt ?? tfdt;
    perTrack.set(trackId, existing);
  });
  return [...perTrack.values()].map((t) => ({
    ...t,
    startSeconds: t.tfdt === null ? null : t.tfdt / t.timescale,
    durationSeconds: t.duration / t.timescale,
  }));
}

// Shift every track by the same delta so the earliest sample of the segment
// lands at `startSeconds`, keeping intra-segment A/V offsets intact.
export function rewriteSegmentTimeline(segment, startSeconds, initInfo) {
  const out = Buffer.from(segment);
  const stats = segmentStats(segment, initInfo);
  if (stats.length === 0) throw new Error('segment has no tracks');
  const anchor = Math.min(...stats.map((s) => s.startSeconds));
  forEachTraf(out, ({ inner, tfhd }) => {
    const trackId = out.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
    const track = initInfo.tracks.find((t) => t.trackId === trackId);
    if (!track) throw new Error(`track ${trackId} not present in init segment`);
    const tfdtBox = inner.find((b) => b.type === 'tfdt');
    if (!tfdtBox) throw new Error(`segment track ${trackId} lacks tfdt`);
    const tfdt = readTfdt(out, tfdtBox);
    const offset = tfdt.base / track.timescale - anchor;
    const base = Math.round((startSeconds + offset) * track.timescale);
    if (base < 0 || !Number.isSafeInteger(base)) {
      throw new RangeError(`invalid rewritten tfdt for track ${trackId}: ${base}`);
    }
    if (tfdt.version === 1) {
      out.writeBigUInt64BE(BigInt(base), tfdt.box.start + tfdt.box.headerSize + 4);
    } else {
      if (base > 0xffffffff) throw new RangeError(`tfdt overflow for track ${trackId}`);
      out.writeUInt32BE(base, tfdt.box.start + tfdt.box.headerSize + 4);
    }
  });
  return out;
}

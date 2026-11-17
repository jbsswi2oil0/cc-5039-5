// Dynamic live origin.
//
// Publishes a rolling HLS-style media playlist whose segments are encoded on
// demand from a procedural camera. Nothing is sliced from a pre-rendered long
// file: the manifest window, sequence numbers and available segments are all
// generated as the origin clock advances.
//
// Content identity is independent of media sequence numbers. Each segment has
// a `contentIndex` (its position in the continuous camera timeline) and an
// `epoch` (encoding/discontinuity generation). The URI encodes both, so a
// sequence-number reset produces *new* URIs: the kernel can detect that a msn
// now refers to different content and must treat it as a new relation.
//
// Scenario knobs let tests force the failure modes the kernel must survive:
// late updates, sequence resets, missing segments, gaps, and a discontinuity
// with a declared clock jump.

import { encodeSegment, splitInit, patchTfdt, SEGMENT_SECONDS, FPS } from './encode.mjs';
import { FRAME_WIDTH, FRAME_HEIGHT } from '../shared/frame.mjs';

export const DEFAULT_SCENARIO = Object.freeze({
  windowSegments: 8,
  startSegment: 0,
  segmentIntervalMs: SEGMENT_SECONDS * 1000,
  startHoursAgo: 0.25,
  // -1 means "no automatic publishing"; tests drive advanceTo() explicitly.
  autoAdvance: true,
  // Failure injection.
  stall: null, // { afterMs, durationMs }
  resetAtContentIndex: null, // content index where the source restarts msn at 0
  // Sequence numbers whose media is unavailable. They keep their slot in the
  // playlist (EXT-X-GAP) so the numbering stays aligned; removing the entry
  // would renumber every following segment, which is a different event.
  gapMsn: [],
  // A discontinuity begins when contentIndex reaches this value.
  discontinuityAtContentIndex: null,
  declaredDateJumpMs: 0,
  segmentEncodeMs: 0,
});

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z').replace('Z', 'Z');
}

export class DynamicOrigin {
  constructor(scenario = {}) {
    this.scenario = { ...DEFAULT_SCENARIO, ...scenario };
    this.startedAtMs = Date.now() - this.scenario.startHoursAgo * 3600_000;
    // When not auto-advancing, `manualContentIndex` sets the newest content
    // index directly (tests set it).
    this.manualContentIndex = null;
    this.encodeCache = new Map();
    this.initCache = null;
    this.encodeQueue = new Map();
    this.pollCount = 0;
    this.failBudget = 0;
    this.forcedFailures = 0;
    this.lastMsnSpec = null;
    this.declaredBaseMs = this.startedAtMs;
  }

  // Newest published content index (0-based).
  newestContentIndex() {
    if (this.manualContentIndex != null) return this.manualContentIndex;
    if (!this.scenario.autoAdvance) return this.scenario.startSegment + this.scenario.windowSegments - 1;
    const elapsed = Date.now() - this.startedAtMs;
    return Math.floor(elapsed / this.scenario.segmentIntervalMs);
  }

  advanceTo(contentIndex) {
    this.manualContentIndex = contentIndex;
  }

  // Maps a content index to the media sequence number that currently
  // identifies it. Before a reset this is contentIndex; after a reset, the
  // numbering restarts at 0 from a specific content index.
  msnForContent(contentIndex) {
    const resetAt = this.scenario.resetAtContentIndex;
    if (resetAt != null && contentIndex >= resetAt) {
      return contentIndex - resetAt;
    }
    return contentIndex;
  }

  contentForMsn(msn) {
    const resetAt = this.scenario.resetAtContentIndex;
    if (resetAt != null && msn <= this.msnForContent(this.newestContentIndex()) && resetAt <= this.newestContentIndex()) {
      return resetAt + msn;
    }
    return msn;
  }

  isResetActive() {
    const resetAt = this.scenario.resetAtContentIndex;
    return resetAt != null && this.newestContentIndex() >= resetAt;
  }

  // The oldest content index in the published window. A sequence reset is a
  // genuine restart: the source drops its history and republishes the window
  // from the reset point, so numbering never mixes two eras.
  oldestContentIndex() {
    const resetAt = this.scenario.resetAtContentIndex;
    const newest = this.newestContentIndex();
    if (resetAt != null && newest >= resetAt) {
      return Math.max(resetAt, newest - this.scenario.windowSegments + 1);
    }
    return Math.max(0, newest - this.scenario.windowSegments + 1);
  }

  epochForContent(contentIndex) {
    const at = this.scenario.discontinuityAtContentIndex;
    return at != null && contentIndex >= at ? 1 : 0;
  }

  // Declared wall clock for a segment start. Before the discontinuity this is
  // a linear clock; at and after the discontinuity the declared clock jumps by
  // an explicit amount, which must not rewrite media time.
  declaredStartForContent(contentIndex) {
    let declared = this.declaredBaseMs + contentIndex * this.scenario.segmentIntervalMs;
    const at = this.scenario.discontinuityAtContentIndex;
    if (at != null && contentIndex >= at) declared += this.scenario.declaredDateJumpMs;
    return declared;
  }

  frameStartForContent(contentIndex) {
    // Frame numbers follow content, not sequence numbers, so a sequence reset
    // is directly visible as a msn/frame mismatch.
    return contentIndex * FPS * SEGMENT_SECONDS;
  }

  // The current msn window as {msn, contentIndex, uri, epoch, gap}.
  currentWindow() {
    const newest = this.newestContentIndex();
    const oldest = this.oldestContentIndex();
    const out = [];
    for (let content = oldest; content <= newest; content += 1) {
      const msn = this.msnForContent(content);
      const epoch = this.epochForContent(content);
      out.push({
        msn,
        contentIndex: content,
        uri: `segment-${epoch}-${content}.m4s`,
        epoch,
        gap: this.scenario.gapMsn.includes(msn),
      });
    }
    return out;
  }

  poll({ forcedFailure = false } = {}) {
    this.pollCount += 1;
    if (forcedFailure || this.forcedFailures > 0) {
      if (this.forcedFailures > 0) this.forcedFailures -= 1;
      return { status: 503, body: 'origin unavailable' };
    }

    const stall = this.scenario.stall;
    if (stall) {
      const elapsed = Date.now() - this.startedAtMs;
      if (elapsed >= stall.afterMs && elapsed < stall.afterMs + stall.durationMs) {
        return { status: 503, body: 'origin unavailable (stalled)' };
      }
    }
    return {
      status: 200,
      body: this.renderManifest(),
      contentType: 'application/vnd.apple.mpegurl',
    };
  }

  setScenario(partial) {
    this.scenario = { ...this.scenario, ...partial };
    return this.scenario;
  }

  renderManifest() {
    const visible = this.currentWindow();
    if (visible.length === 0) return '#EXTM3U\n';
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:6',
      `#EXT-X-MEDIA-SEQUENCE:${visible[0].msn}`,
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      `#EXT-X-FRAME-RATE:${FPS}`,
      '#EXT-X-MAP:URI="init.mp4"',
      `#EXT-X-PROGRAM-DATE-TIME:${iso(this.declaredStartForContent(visible[0].contentIndex))}`,
    ];
    let previousEpoch = visible[0].epoch;
    for (let i = 0; i < visible.length; i += 1) {
      const s = visible[i];
      if (i > 0 && s.epoch !== previousEpoch) {
        lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(this.declaredStartForContent(s.contentIndex))}`);
        previousEpoch = s.epoch;
      }
      lines.push(`#EXTINF:${(this.scenario.segmentIntervalMs / 1000).toFixed(3)},`);
      lines.push(`#EXT-X-FRAME-INDEX:${this.frameStartForContent(s.contentIndex)}`);
      if (s.gap) lines.push('#EXT-X-GAP');
      lines.push(s.uri);
    }
    lines.push('');
    return lines.join('\n');
  }

  segmentMeta(uri) {
    const match = /^segment-(\d+)-(\d+)\.m4s$/.exec(uri);
    if (!match) return null;
    const epoch = Number(match[1]);
    const contentIndex = Number(match[2]);
    return {
      uri,
      epoch,
      contentIndex,
      frameStart: this.frameStartForContent(contentIndex),
      contentStartMs: contentIndex * this.scenario.segmentIntervalMs,
    };
  }

  async encode(uri) {
    const meta = this.segmentMeta(uri);
    if (!meta) return null;
    if (this.encodeCache.has(uri)) return this.encodeCache.get(uri);
    if (this.encodeQueue.has(uri)) return this.encodeQueue.get(uri);
    const task = (async () => {
      if (this.scenario.segmentEncodeMs) {
        await new Promise((r) => setTimeout(r, this.scenario.segmentEncodeMs));
      }
      const buf = await encodeSegment({
        epoch: meta.epoch,
        frameStart: meta.frameStart,
        frames: Math.round((this.scenario.segmentIntervalMs / 1000) * FPS),
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
      });
      this.encodeCache.set(uri, buf);
      return buf;
    })().finally(() => this.encodeQueue.delete(uri));
    this.encodeQueue.set(uri, task);
    return task;
  }

  async initSegment() {
    if (this.initCache) return this.initCache;
    // Encode a throwaway segment to obtain a byte-identical init.
    const buf = await encodeSegment({
      epoch: 0,
      frameStart: 0,
      frames: 2,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    this.initCache = splitInit(buf).init;
    return this.initCache;
  }

  async segmentMedia(uri) {
    const meta = this.segmentMeta(uri);
    if (!meta) return null;
    const buf = await this.encode(uri);
    if (!buf) return null;
    const { media } = splitInit(buf);
    // Delivered file carries the absolute content start time in tfdt. Epoch 1
    // gets a large offset so a discontinuity is explicit in the bytes too.
    const absoluteMs = meta.contentStartMs + meta.epoch * 1_000_000;
    return patchTfdt(media, absoluteMs);
  }

  // Media-time start the kernel should derive for a content index. This is the
  // origin's declared duration sum, which the kernel recomputes for itself.
  mediaStartForContent(contentIndex) {
    return contentIndex * this.scenario.segmentIntervalMs;
  }
}

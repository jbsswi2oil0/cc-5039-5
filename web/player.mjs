// Browser live-replay player.
//
// The player does not own a timeline of its own: it drives a SourceBuffer from
// the kernel's stable media-time mapping. Every segment it appends is fetched
// from the live origin at the moment it is needed, and only segments that the
// kernel says are inside the current window are ever requested. Positions that
// have rolled out of the window are relocated or refused by the kernel before
// any fetch happens.

import { LiveKernel } from '../src/kernel/live-kernel.mjs';
import { parseMediaPlaylist } from '../src/kernel/manifest.mjs';
import { decodeBarcodeFromRGBA, FRAME_WIDTH, FRAME_HEIGHT } from '../src/shared/frame.mjs';

const POLL_MS = 1500;

function params() {
  const q = new URLSearchParams(location.search);
  return {
    playlist: q.get('playlist') ?? '/live/index.m3u8',
    pollMs: Number(q.get('poll') ?? POLL_MS),
    staleAfterMs: Number(q.get('staleAfterMs') ?? 20_000),
    stallAfterMs: Number(q.get('stallAfterMs') ?? 10_000),
    relocationToleranceMs: Number(q.get('tol') ?? 5_000),
    prebufferSegments: Number(q.get('prebuffer') ?? 3),
  };
}

const CODEC_CANDIDATES = [
  'video/mp4; codecs="avc1.42C01E"',
  'video/mp4; codecs="avc1.42001E"',
  'video/mp4; codecs="avc1.42E01E"',
];

function pickCodec() {
  if (typeof MediaSource === 'undefined') return null;
  return CODEC_CANDIDATES.find((c) => MediaSource.isTypeSupported(c)) ?? null;
}

// Reads tfdt baseMediaDecodeTime and the mdhd timescale from a media segment.
// Fragmented MP4 nests tfdt inside moof > traf, so containers are recursed.
function readTfdtMs(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let timescale = 90000;
  let tfdt = null;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex']);
  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      const size = dv.getUint32(o);
      if (size < 8 || o + size > end) return;
      const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      const body = o + 8;
      if (type === 'mdhd') {
        const version = bytes[body];
        timescale = dv.getUint32(body + (version === 1 ? 20 : 12));
      } else if (type === 'tfdt') {
        const version = bytes[body];
        tfdt = version === 1 ? Number(dv.getBigUint64(body + 4)) : dv.getUint32(body + 4);
      } else if (CONTAINERS.has(type)) {
        walk(body, o + size);
      }
      o += size;
    }
  };
  walk(0, bytes.length);
  if (tfdt == null) return null;
  return (tfdt / timescale) * 1000;
}

function fmtClock(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function fmtRel(ms) {
  const s = ms / 1000;
  return `${s >= 0 ? '+' : ''}${s.toFixed(2)}s`;
}

class ReplayPlayer {
  constructor(opts) {
    this.opts = opts;
    this.kernel = new LiveKernel({
      staleAfterMs: opts.staleAfterMs,
      stallAfterMs: opts.stallAfterMs,
      relocationToleranceMs: opts.relocationToleranceMs,
    });
    this.video = document.getElementById('video');
    this.codec = pickCodec();
    this.listener = null;

    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = Promise.resolve();
    this.runStartMs = null;
    this.runEndMs = null;
    this.lastAppendedMsn = null;
    this.initBuffer = null;
    this.initAppended = false;
    this.segmentCache = new Map();
    this.fetchStats = { segments: 0, missing: 0, refused: 0, failures: 0 };
    this.mode = 'live';
    this.seeking = false;
    this.relocationToleranceMs = opts.relocationToleranceMs;
    this.events = [];
    this.staleAutoPaused = false;
    this.evictedHold = false;
    this.lastPoll = { atMs: null, ok: null, error: null };
    this.frameCheck = { decoded: null, expected: null, atMs: null, ok: null };
    this.currentUriMeta = null;
    this.pollTimer = null;
    this.viewValue = null;
  }

  async start() {
    this.video.muted = true;
    this.video.playsInline = true;
    await this.resetMedia();
    this.bindVideo();
    await this.pollOnce();
    await this.followLiveEdge({ initial: true });
    this.pollTimer = setInterval(() => this.pollOnce().catch(() => {}), this.opts.pollMs);
  }

  bindVideo() {
    this.video.addEventListener('error', () => this.note('video-error', this.video.error?.message ?? 'video error'));
    this.video.addEventListener('stalled', () => this.note('video-stalled', 'playback stalled'));
  }

  note(type, message, detail = {}) {
    this.events.push({ type, message, atMs: Date.now(), ...detail });
    if (this.events.length > 100) this.events.shift();
    window.__onPlayerEvent?.(this.events[this.events.length - 1]);
  }

  // ---- media plumbing -----------------------------------------------------

  async resetMedia() {
    if (this.mediaSource && this.mediaSource.url) URL.revokeObjectURL(this.mediaSource.url);
    this.runStartMs = null;
    this.runEndMs = null;
    this.lastAppendedMsn = null;
    this.initAppended = false;
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    await new Promise((resolve) => this.mediaSource.addEventListener('sourceopen', resolve, { once: true }));
    if (!this.codec) {
      this.note('codec-unsupported', 'no supported H.264 MSE codec in this browser');
      throw new Error('unsupported');
    }
    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.codec);
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('error', () => this.note('sourcebuffer-error', 'append failed'));
  }

  waitUpdate() {
    if (!this.sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.sourceBuffer.removeEventListener('updateend', done);
        resolve();
      };
      this.sourceBuffer.addEventListener('updateend', done);
      setTimeout(() => {
        this.sourceBuffer.removeEventListener('updateend', done);
        resolve();
      }, 5000);
    });
  }

  append(buffer) {
    this.queue = this.queue.then(async () => {
      if (!this.sourceBuffer || this.sourceBuffer.updating) await this.waitUpdate();
      this.sourceBuffer.appendBuffer(buffer);
      await this.waitUpdate();
    });
    return this.queue;
  }

  async fetchInit() {
    if (this.initBuffer) return this.initBuffer;
    const res = await fetch('/live/init.mp4', { cache: 'no-store' });
    if (!res.ok) throw new Error(`init fetch failed ${res.status}`);
    this.initBuffer = await res.arrayBuffer();
    return this.initBuffer;
  }

  async fetchSegment(entry) {
    if (this.segmentCache.has(entry.uri)) return this.segmentCache.get(entry.uri);
    const url = `/live/${encodeURIComponent(entry.uri)}`;
    const res = await fetch(url, { cache: 'no-store' });
    this.fetchStats.segments += 1;
    if (!res.ok) {
      this.fetchStats.failures += 1;
      if (res.status === 404) this.fetchStats.missing += 1;
      throw new Error(`segment ${entry.uri} fetch failed ${res.status}`);
    }
    const buffer = await res.arrayBuffer();
    this.segmentCache.set(entry.uri, buffer);
    // Bound the cache; old segments must not be silently reused after eviction.
    if (this.segmentCache.size > 40) {
      const first = this.segmentCache.keys().next().value;
      this.segmentCache.delete(first);
    }
    return buffer;
  }

  // Appends a contiguous run starting at `entry`, up to `count` segments that
  // are adjacent (msn and media time) and inside the window.
  async appendRun(entry, count) {
    const view = this.viewValue;
    if (!view) throw new Error('no view');
    if (!this.sourceBuffer) await this.resetMedia();
    await this.queue;
    if (!this.initAppended) {
      this.sourceBuffer.appendBuffer(await this.fetchInit());
      await this.waitUpdate();
      this.initAppended = true;
    }
    let current = entry;
    let appended = 0;
    while (current && appended < count) {
      if (this.runEndMs != null && current.startMs !== this.runEndMs) break;
      const media = await this.fetchSegment(current);
      if (this.runStartMs == null) this.runStartMs = current.startMs;
      this.runEndMs = current.endMs;
      const tfdtMs = readTfdtMs(media);
      if (tfdtMs == null) throw new Error('segment has no tfdt');
      // Map the file's internal clock onto the kernel's stable media timeline.
      this.sourceBuffer.timestampOffset = (current.startMs - tfdtMs) / 1000;
      await this.append(media);
      this.lastAppendedMsn = current.msn;
      this.currentUriMeta = { uri: current.uri, msn: current.msn, frameStart: current.frameStart };
      appended += 1;
      const next = view.entries.find((e) => e.msn === current.msn + 1);
      current = next && next.startMs === current.endMs ? next : null;
    }
    return appended;
  }

  // Extends the buffer at the end if the next manifest entry is contiguous.
  async extendTail() {
    if (this.runEndMs == null) return;
    const nextMsn = this.lastAppendedMsn + 1;
    const entry = this.viewValue?.entries.find((e) => e.msn === nextMsn);
    if (!entry || entry.gap) return;
    if (entry.startMs !== this.runEndMs || entry.endMs > this.viewValue.window.endMs) return;
    await this.appendRun(entry, 1);
  }

  // ---- kernel ingestion ---------------------------------------------------

  async pollOnce() {
    const receivedAtMs = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(this.opts.playlist, { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const text = await res.text();
      const result = this.kernel.ingest(text, {
        receivedAtMs,
        parse: (t) => parseMediaPlaylist(t, { sourceUrl: this.opts.playlist }),
      });
      this.lastPoll = { atMs: receivedAtMs, ok: result.ok, error: result.error ?? null };
      const view = result.view;
      this.view = view;
      if (!view) return;
      if (result.status === 'relation-reset') {
        this.note('relation-reset', `源序号重置，进入新关系 ${view.relation.id}`, {
          reset: result.reset,
        });
        await this.handleRelationReset();
      } else if (!result.ok) {
        this.note('manifest-unconfirmed', `清单更新失败：${result.error}，保留 ${fmtRel(view.window.startMs)}…${fmtRel(view.window.endMs)} 的确认范围`);
        if (this.mode === 'live' && view.freshness.state === 'stale') {
          this.note('stale', '清单已过期，不再按实时直播推进');
        }
      }
      this.emit();
      await this.reconcile();
    } catch (error) {
      const result = this.kernel.ingest(error, { receivedAtMs });
      this.lastPoll = { atMs: receivedAtMs, ok: false, error: String(error?.message ?? error) };
      if (result.view) {
        this.view = result.view;
        this.note('manifest-failed', `清单获取失败：${result.error}`);
        this.emit();
      }
    }
  }

  async handleRelationReset() {
    // Old buffered content belongs to the previous relation and must not be
    // mistaken for the new sequence. Drop the buffer and re-anchor to the new
    // relation's live edge; the new relation starts at a fresh time base, so
    // the old playhead must not be carried across.
    await this.queue;
    await this.resetMedia();
    this.note('buffer-cleared', '序号重置后清空旧缓冲，按新关系窗口重新取流');
    this.mode = 'live';
    await this.followLiveEdge({ initial: true });
  }

  async reconcile() {
    const view = this.viewValue;
    if (!view || !this.sourceBuffer) return;
    if (this.seeking) { this.emit(); return; }

    // 1. Evict buffered media that has rolled out of the window. The playhead
    // is only considered evicted once playback has actually started: before
    // that it sits at 0 and the buffer has not been anchored yet.
    if (this.runStartMs != null && this.runStartMs < view.window.startMs) {
      const cutoff = view.window.startMs / 1000;
      const playheadSettled = this.video.readyState >= 2 || !this.video.paused;
      if (playheadSettled && this.video.currentTime < cutoff) {
        const decision = view.resolveStart(this.video.currentTime * 1000);
        if (decision.ok) {
          this.note('playhead-evicted', `播放点已被移出窗口，重定位到 ${fmtRel(decision.relocatedMs)}`);
          await this.seekToMediaMs(decision.relocatedMs, { fromPlayer: true, mode: this.mode });
          return;
        }
        // The kernel refused: stop and surface what happened. Never retry the
        // same dead position on every poll.
        this.note('playhead-evicted', `播放点已被移出窗口且无法重定位：${decision.message}`, {
          reason: decision.reason,
          requestedMs: Math.round(this.video.currentTime * 1000),
        });
        this.video.pause();
        this.evictedHold = true;
        try {
          this.sourceBuffer.remove(0, cutoff);
          this.runStartMs = Math.max(this.runStartMs, view.window.startMs);
        } catch {
          /* best effort */
        }
        this.emit();
        return;
      }
      if (this.evictedHold) {
        // Hold until the user explicitly picks a new in-window position or
        // returns to live.
        this.emit();
        return;
      }
      try {
        this.sourceBuffer.remove(0, cutoff);
        await this.waitUpdate();
        this.runStartMs = Math.max(this.runStartMs, view.window.startMs);
      } catch {
        // Removal is best-effort; correctness still comes from the kernel.
      }
    }

    // 2. Keep the tail fed. A live playhead follows the growing edge; a replay
    // playhead is only fed as far as needed to avoid a stall at the target.
    if (this.mode === 'live') {
      await this.extendTail();
      if (view.freshness.state === 'stalled' || view.freshness.state === 'stale') {
        if (!this.staleAutoPaused) {
          this.staleAutoPaused = true;
          this.video.pause();
          this.note('live-edge-frozen', '源清单已停止推进，已暂停跟随旧的直播边缘');
        }
      } else if (view.freshness.state === 'live') {
        this.staleAutoPaused = false;
      }
    } else {
      // Replay: keep a small forward buffer, but never fetch beyond the window.
      const aheadMs = this.runEndMs - this.video.currentTime * 1000;
      if (this.runEndMs != null && this.runEndMs < view.window.endMs && aheadMs < 8000) {
        await this.extendTail();
      }
    }
    this.emit();
  }

  // ---- user actions -------------------------------------------------------

  async followLiveEdge({ initial = false } = {}) {
    const view = this.viewValue;
    if (!view) return;
    const edge = view.window.endMs;
    const backMs = this.opts.prebufferSegments * 4000;
    let target = Math.max(view.window.startMs, edge - backMs);
    // Start on a segment boundary so the first append is clean.
    const decision = view.resolveStart(target, { toleranceMs: 0 });
    if (!decision.ok) {
      this.note('live-follow-refused', decision.message);
      return;
    }
    this.mode = 'live';
    this.staleAutoPaused = false;
    await this.seekToMediaMs(decision.mediaTimeMs, { fromPlayer: true, resume: true, mode: 'live' });
    this.note('follow-live', `已定位到直播边缘附近 ${fmtRel(decision.mediaTimeMs)}，窗口 ${fmtRel(view.window.startMs)}…${fmtRel(view.window.endMs)}`);
  }

  async jumpToLive() {
    await this.followLiveEdge();
  }

  async seekBack(seconds) {
    const view = this.viewValue;
    if (!view) return null;
    const current = this.video.currentTime * 1000;
    return this.seekToMediaMs(current - seconds * 1000, { fromPlayer: false });
  }

  // Public seek entry: the kernel is the authority. Returns the decision.
  async seekToMediaMs(targetMs, { fromPlayer = false, resume = null, mode = null } = {}) {
    const view = this.viewValue;
    if (!view) return { ok: false, action: 'refuse', reason: 'no-window' };
    const decision = view.resolveStart(targetMs);
    if (!decision.ok) {
      this.fetchStats.refused += 1;
      this.note('seek-refused', `拒绝定位到 ${fmtRel(targetMs)}：${decision.message}`, {
        requestedMs: targetMs,
        reason: decision.reason,
      });
      this.emit();
      return decision;
    }
    if (decision.action === 'relocate') {
      this.note('seek-relocated', `${fmtRel(targetMs)} → ${fmtRel(decision.relocatedMs)}（${decision.message}）`);
    }
    this.evictedHold = false;
    const target = decision.mediaTimeMs;
    const entry = decision.segment;
    const wasPlaying = resume ?? !this.video.paused;
    this.video.pause();
    this.seeking = true;
    this.mode = mode ?? 'replay';

    // If the target is already buffered and contiguous, just seek.
    const inRun = this.runStartMs != null && target >= this.runStartMs && target <= this.runEndMs;
    if (!inRun) {
      // Reset and append from the containing segment forward.
      await this.queue;
      await this.resetMedia();
      await this.appendRun(entry, Math.max(2, this.opts.prebufferSegments));
    }
    try {
      this.video.currentTime = target / 1000;
    } catch {
      // If the timeline has not been established yet, wait and retry.
      await this.waitUpdate();
      this.video.currentTime = target / 1000;
    }
    await new Promise((resolve) => {
      const done = () => resolve();
      this.video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 3000);
    });
    this.seeking = false;
    if (wasPlaying) {
      try {
        await this.video.play();
      } catch {
        /* autoplay policy */
      }
    }
    this.emit();
    return decision;
  }

  // ---- frame verification --------------------------------------------------

  sampleFrame() {
    if (this.video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    let decoded;
    try {
      decoded = decodeBarcodeFromRGBA(ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data);
    } catch {
      return null;
    }
    if (!decoded.checksumOk) return null;
    const view = this.viewValue;
    const mediaMs = this.video.currentTime * 1000;
    const entry = view?.segmentAt(mediaMs);
    let expected = null;
    if (entry && entry.frameStart != null) {
      expected = entry.frameStart + Math.floor(((mediaMs - entry.startMs) / 1000) * 30);
    }
    this.frameCheck = {
      decodedFrame: decoded.frame,
      decodedEpoch: decoded.epoch,
      expectedFrame: expected,
      atMs: mediaMs,
      ok: expected == null ? null : Math.abs(decoded.frame - expected) <= 1,
      checksumOk: decoded.checksumOk,
    };
    return this.frameCheck;
  }

  // ---- state export -------------------------------------------------------

  get view() {
    return this.viewValue;
  }

  set view(v) {
    this.viewValue = v;
  }

  emit() {
    window.__onPlayerUpdate?.(this.snapshot());
  }

  snapshot() {
    const view = this.viewValue;
    if (!view) {
      return {
        hasWindow: false,
        mode: this.mode,
        events: this.events.slice(-12),
        poll: this.lastPoll,
        fetchStats: this.fetchStats,
      };
    }
    const mediaMs = this.video.currentTime * 1000;
    const located = view.locate(mediaMs);
    const current = view.segmentAt(mediaMs);
    return {
      hasWindow: true,
      mode: this.mode,
      window: { ...view.window },
      relation: { ...view.relation },
      freshness: { ...view.freshness },
      source: { ...view.source },
      issues: view.issues.slice(-8),
      evicted: view.history.slice(-40).map((h) => ({ ...h })),
      playhead: {
        mediaMs,
        relativeToEdgeMs: mediaMs - view.window.endMs,
        inWindow: located.status === 'playable',
        locatedStatus: located.status,
        segment: current
          ? {
              msn: current.msn,
              uri: current.uri,
              frameStart: current.frameStart,
              startMs: current.startMs,
              endMs: current.endMs,
              declaredStartText: current.declaredStartText,
              declaredStartMs: current.declaredStartMs,
              epoch: current.epoch,
            }
          : null,
        expectedFrame: current && current.frameStart != null
          ? current.frameStart + Math.floor(((mediaMs - current.startMs) / 1000) * 30)
          : null,
      },
      buffer: {
        startMs: this.runStartMs,
        endMs: this.runEndMs,
        lastAppendedMsn: this.lastAppendedMsn,
        cachedSegments: this.segmentCache.size,
      },
      frameCheck: this.frameCheck,
      fetchStats: this.fetchStats,
      events: this.events.slice(-12),
      poll: this.lastPoll,
      segmentCount: view.entries.length,
      segmentsInWindow: view.segmentsInWindow().length,
    };
  }
}

async function main() {
  const opts = params();
  const player = new ReplayPlayer(opts);
  window.__player = player;
  window.__seek = (ms) => player.seekToMediaMs(ms);
  window.__seekBack = (s) => player.seekBack(s);
  window.__jumpLive = () => player.jumpToLive();
  window.__sampleFrame = () => player.sampleFrame();
  window.__snapshot = () => player.snapshot();
  await player.start();
}

main().catch((error) => {
  window.__bootError = String(error?.stack ?? error);
  window.__onPlayerUpdate?.({ bootError: window.__bootError });
});

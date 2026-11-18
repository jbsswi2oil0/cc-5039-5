// MSE player for the replay kernel's own playback axis.
//
// The kernel rewrites each segment's tfdt onto a continuous playback axis, so
// media time in this player *is* kernel playback time. hls.js cannot be used
// here because it normalises the timeline back to zero, which would hide the
// difference between "where the window is" and "what the player is showing".

const CODEC_VIDEO = 'avc1.42c01f';
const CODEC_AUDIO = 'mp4a.40.2';

export class WindowPlayer extends EventTarget {
  constructor(video, { kernelBase = '', onStatus } = {}) {
    super();
    this.video = video;
    this.kernelBase = kernelBase;
    this.onStatus = onStatus;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.appending = false;
    this.loaded = new Map(); // `${epoch}:${sequence}` -> { start, end }
    this.loading = new Set(); // same key space
    this.epoch = null;
    this.windowStart = null;
    this.windowEnd = null;
    this.playing = false;
    this.followLive = true;
    this.lastPlaybackTime = null;
    this.target = null;
    this.errors = [];
    this.initLoaded = false;
    this.initPromise = null;
    this.attach();
  }

  attach() {
    const withAudio = `video/mp4; codecs="${CODEC_VIDEO},${CODEC_AUDIO}"`;
    const videoOnly = `video/mp4; codecs="${CODEC_VIDEO}"`;
    this.mime = MediaSource.isTypeSupported(withAudio) ? withAudio : videoOnly;
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mime);
        this.sourceBuffer.mode = 'segments';
        this.sourceBuffer.addEventListener('updateend', () => this.pump());
        this.sourceBuffer.addEventListener('error', () => this.recordError('sourcebuffer-error'));
      } catch (error) {
        this.recordError(`addSourceBuffer failed: ${error.message}`);
      }
    }, { once: true });
    this.video.addEventListener('play', () => {
      this.playing = true;
      this.emit('playstate');
    });
    this.video.addEventListener('pause', () => {
      this.playing = false;
      this.emit('playstate');
    });
    this.video.addEventListener('timeupdate', () => {
      this.lastPlaybackTime = this.currentTime;
      this.emit('time');
      if (this.followLive) this.enforceFollowingWindow();
      this.skipDeclaredGaps();
    });
    this.video.addEventListener('waiting', () => this.emit('buffering'));
    this.video.addEventListener('playing', () => this.emit('playing'));
    this.video.addEventListener('error', () => {
      const err = this.video.error;
      this.recordError(`video element error ${err?.code}: ${err?.message ?? ''}`);
    });
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    this.onStatus?.(this.status(), type, detail);
  }

  recordError(message) {
    this.errors.push({ at: Date.now(), message });
    if (this.errors.length > 20) this.errors.shift();
    this.emit('error', { message });
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get ranges() {
    const ranges = [];
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      ranges.push({ start: round3(b.start(i)), end: round3(b.end(i)) });
    }
    return ranges;
  }

  status() {
    return {
      currentTime: round3(this.video.currentTime),
      duration: Number.isFinite(this.video.duration) ? round3(this.video.duration) : null,
      readyState: this.video.readyState,
      playing: this.playing,
      paused: this.video.paused,
      followLive: this.followLive,
      ranges: this.ranges,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      loadedSequences: [...this.loaded.keys()].sort((a, b) => a - b),
      errors: this.errors.slice(-5),
      mode: this.mime,
    };
  }

  // Synchronise the player with the kernel's advertised window. The window may
  // have advanced, and the playhead may have been evicted.
  async syncWindow(payload) {
    const { start, end } = payload.window;
    // A sequence reset starts a new epoch whose sequence numbers may collide
    // with the previous one. Loaded/loading bookkeeping is per epoch, otherwise
    // the player would treat new media as already buffered.
    if (payload.epoch !== this.epoch) {
      this.epoch = payload.epoch ?? null;
      this.loaded.clear();
      this.loading.clear();
      this.skippedGap = null;
      if (this.followLive) this.target = null;
    }
    const previousEnd = this.windowEnd;
    this.windowStart = start;
    this.windowEnd = end;
    if (start === null) {
      this.emit('window', payload);
      return;
    }
    const liveEdge = Math.max(start, end - 1);
    if (this.followLive) {
      // Following the live edge means keeping it buffered and only jumping
      // when the playhead has actually fallen behind, never re-seeking every
      // poll (that stutters and keeps emptying the buffer).
      const behindBy = liveEdge - this.currentTime;
      if (this.currentTime < start || this.target === null) {
        this.target = this.currentTime < start ? start : liveEdge;
        await this.seek(this.target);
      } else if (behindBy > 2.5) {
        this.target = liveEdge;
        await this.seek(liveEdge);
      }
      this.target = liveEdge;
    } else if (this.target === null) {
      this.target = Math.max(start, Math.min(this.currentTime || start, end - 0.1));
    }
    await this.ensureBufferedAround(
      this.followLive
        ? Math.max(liveEdge, Math.min(this.currentTime || liveEdge, liveEdge))
        : this.target,
    );
    if (this.video.paused && this.followLive) {
      await this.play().catch(() => {});
    }
    if (this.currentTime < start) {
      await this.seek(start);
    }
    this.emit('window', payload);
  }

  enforceFollowingWindow() {
    if (this.windowStart === null) return;
    if (this.currentTime < this.windowStart) {
      this.emit('relocated', {
        requested: this.currentTime,
        relocatedTo: this.windowStart,
        reason: 'window-advanced-past-playhead',
      });
      this.target = this.windowStart;
      this.seek(this.windowStart).catch(() => {});
    }
  }

  // A declared gap (EXT-X-GAP) has no media at all. Step over it rather than
  // waiting forever inside it.
  skipDeclaredGaps() {
    if (!this.windowSegments) return;
    const t = this.currentTime;
    if (t >= this.windowEnd - 0.05) return;
    const inside = this.windowSegments.find(
      (s) => s.gap && t >= s.playbackStart && t < s.playbackEnd - 0.02,
    );
    if (!inside) return;
    if (this.skippedGap === inside.sequence) return;
    this.skippedGap = inside.sequence;
    this.emit('gapSkipped', {
      sequence: inside.sequence,
      from: inside.playbackStart,
      to: inside.playbackEnd,
    });
    this.seek(inside.playbackEnd).catch(() => {});
  }

  async ensureBufferedAround(t) {
    if (t === null || this.windowStart === null) return;
    const need = [];
    const span = 6; // seconds of lookahead
    const from = Math.max(this.windowStart, Math.min(this.currentTime, t) - 1);
    const to = Math.min(this.windowEnd, t + span);
    if (to <= from) return;

    let cursor = from;
    while (cursor < to) {
      const cover = this.ranges.find((r) => r.start <= cursor && r.end > cursor);
      if (cover) {
        cursor = cover.end;
        continue;
      }
      const missing = this.windowSegments.find(
        (s) => s.playbackStart <= cursor && s.playbackEnd > cursor,
      );
      if (missing?.gap) {
        cursor = missing.playbackEnd;
        continue;
      }
      if (!missing) {
        const next = this.windowSegments.find((s) => s.playbackStart > cursor);
        if (!next) break;
        need.push(next);
        cursor = next.playbackEnd;
        continue;
      }
      need.push(missing);
      cursor = missing.playbackEnd;
    }
    for (const segment of need) {
      if (segment.gap) continue;
      const key = `${segment.epoch ?? this.epoch}:${segment.sequence}`;
      if (this.loaded.has(key) || this.loading.has(key)) continue;
      this.loading.add(key);
      try {
        await this.appendSegment(segment, key);
      } finally {
        this.loading.delete(key);
      }
    }
  }

  setWindowSegments(segments) {
    this.windowSegments = segments;
  }

  async loadInit() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const response = await fetch(`${this.kernelBase}/replay/init.mp4`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`init fetch failed: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      this.queue.push({ sequence: 'init', bytes });
      this.pump();
      while (this.queue.length || this.appending) {
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      this.initLoaded = true;
    })();
    return this.initPromise;
  }

  async appendSegment(segment, key = `${segment.epoch ?? this.epoch}:${segment.sequence}`) {
    if (!this.initLoaded) await this.loadInit();
    const url = `${this.kernelBase}/replay/seg/${segment.sequence}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      this.recordError(`segment ${segment.sequence}: HTTP ${response.status} ${body.code ?? ''}`);
      if (response.status === 410) {
        this.emit('evicted', {
          sequence: segment.sequence,
          relocatedTo: body.relocatedTo ?? null,
          relocatedSequence: body.relocatedSequence ?? null,
        });
        if (body.relocatedTo !== null && body.relocatedTo !== undefined) {
          this.target = body.relocatedTo;
          await this.seek(body.relocatedTo);
        }
      }
      return;
    }
    const bytes = await response.arrayBuffer();
    this.queue.push({ sequence: segment.sequence, bytes, segment });
    this.pump();
    while (this.queue.length || this.appending) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      if (this.errors.some((e) => e.message.includes('sourcebuffer-error'))) break;
    }
    this.loaded.set(key, {
      start: segment.playbackStart,
      end: segment.playbackEnd,
    });
    const headerStart = Number(response.headers.get('x-kernel-playback-start'));
    if (Number.isFinite(headerStart)) {
      this.emit('segmentLoaded', {
        sequence: segment.sequence,
        playbackStart: headerStart,
        mediaStart: this.loaded.get(key).start,
      });
    }
  }

  pump() {
    if (!this.sourceBuffer || this.appending) return;
    if (this.sourceBuffer.updating) return;
    if (this.mediaSource?.readyState !== 'open') return;
    const item = this.queue.shift();
    if (!item) return;
    this.appending = true;
    this.sourceBuffer.addEventListener('updateend', () => {
      this.appending = false;
      this.pump();
    }, { once: true });
    try {
      this.sourceBuffer.timestampOffset = 0;
      this.sourceBuffer.appendBuffer(item.bytes);
    } catch (error) {
      this.appending = false;
      this.recordError(`appendBuffer failed: ${error.message}`);
      this.pump();
    }
  }

  async play() {
    try {
      await this.video.play();
    } catch (error) {
      this.recordError(`play() rejected: ${error.message}`);
      throw error;
    }
  }

  pause() {
    this.video.pause();
  }

  async seek(t) {
    const clamped = Math.min(Math.max(t, this.windowStart ?? 0), (this.windowEnd ?? t) - 0.05);
    this.target = clamped;
    this.lastPlaybackTime = clamped;
    await this.ensureBufferedAround(clamped);
    this.video.currentTime = clamped;
    this.emit('seek', { to: clamped });
  }

  setFollowLive(value) {
    this.followLive = value;
    if (value && this.windowEnd !== null) {
      this.target = Math.max(this.windowStart, this.windowEnd - 2);
      this.ensureBufferedAround(this.target)
        .then(() => this.seek(this.target))
        .then(() => this.play().catch(() => {}));
    }
    this.emit('follow', { value });
  }

  // Keep the buffer from growing without bound: evicted media is removed.
  async trimBuffer(keepFrom) {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    const ranges = this.ranges;
    if (ranges.length === 0) return;
    if (keepFrom > 4) {
      try {
        this.sourceBuffer.remove(0, keepFrom);
        await new Promise((resolve) => {
          this.sourceBuffer.addEventListener('updateend', resolve, { once: true });
        });
      } catch (error) {
        this.recordError(`trim failed: ${error.message}`);
      }
    }
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

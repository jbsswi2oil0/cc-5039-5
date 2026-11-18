// Replay kernel service.
//
// The kernel polls the upstream live manifest, maintains a playback axis of its
// own, and exposes:
//
//   /api/health           - kernel state, freshness, scenarios
//   /api/window           - available playback window + run boundaries
//   /api/playhead?t=      - resolve a playback position to a segment
//   /api/sequence/:n      - resolve an old media sequence
//   /replay/index.m3u8    - playable manifest in playback-axis time
//   /replay/init.mp4      - init segment (as published by the source)
//   /replay/seg/:n        - segment with tfdt rewritten onto the playback axis
//
// Importantly the browser plays real segments from the dynamic source: the
// manifest advertises playback-axis positions, and the kernel refuses requests
// for positions it has already evicted instead of fabricating segments.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseInit, rewriteSegmentTimeline, segmentStats } from './kernel/fmp4.js';
import { ReplayTimeline, WindowError } from './kernel/timeline.js';
import { PlaylistPoller } from './kernel/poller.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export class ReplayKernelServer {
  constructor({
    source,
    sourceBaseUrl,
    port = 0,
    retainSeconds = 24,
    pollIntervalMs = 250,
    gapSeconds = 0,
    upstreamFailures = false,
  } = {}) {
    this.source = source;
    this.sourceBaseUrl = sourceBaseUrl;
    this.port = port;
    this.retainSeconds = retainSeconds;
    this.pollIntervalMs = pollIntervalMs;
    this.upstreamFailures = upstreamFailures;
    this.timeline = new ReplayTimeline({ retainSeconds, gapSeconds });
    this.initCache = new Map();
    this.server = null;
    this.poller = null;
    this.boundPort = null;
    this.sequenceResetCount = 0;
    this.lastPlaylist = null;
  }

  async listen() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        } else {
          res.destroy(error);
        }
      });
    });
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this.boundPort = this.server.address().port;
    this.poller = new PlaylistPoller({
      url: new URL('/live/live.m3u8', this.sourceBaseUrl).toString(),
      intervalMs: this.pollIntervalMs,
      fetchImpl: async (url, opts) => {
        if (this.upstreamFailures) throw new Error('upstream manifest unavailable (injected)');
        return fetch(url, opts);
      },
      onPlaylist: (event) => this.ingest(event),
      onError: (error, meta) => this.onPollError(error, meta),
    });
    this.poller.start();
    return this;
  }

  async close() {
    this.poller?.stop();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  ingest({ playlist, fetchedAt }) {
    if (!playlist) return;
    this.lastPlaylist = playlist;
    try {
      const result = this.timeline.applyPlaylist(playlist, { fetchedAt });
      if (result.reset) this.sequenceResetCount += 1;
    } catch (error) {
      if (error.code === 'SEQUENCE_RESET') {
        // The upstream renumbered its segments. The old axis cannot be
        // extended, so the window is rebuilt from the new numbering; requests
        // for the old positions fail explicitly rather than silently aliasing.
        this.sequenceResetCount += 1;
        this.timeline = new ReplayTimeline({
          retainSeconds: this.retainSeconds,
          gapSeconds: this.timeline.gapSeconds,
        });
        this.timeline.applyPlaylist(playlist, { fetchedAt });
        return;
      }
      throw error;
    }
  }

  onPollError(error, { at }) {
    this.timeline.notePlaylistFailure(error, { at });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.boundPort}`);
    const route = url.pathname;
    if (route === '/api/health') return this.health(res);
    if (route === '/api/window') return this.windowJson(res);
    if (route === '/api/playhead') return this.playhead(res, url);
    if (route.startsWith('/api/sequence/')) return this.sequenceLookup(res, url);
    if (route === '/replay/index.m3u8') return this.playlist(res);
    if (route === '/replay/init.mp4') return this.init(res);
    if (route.startsWith('/replay/seg/')) return this.segment(res, url);
    if (route.startsWith('/api/scenario/')) return this.scenario(res, url);
    return sendJson(res, 404, { error: 'not found', path: route });
  }

  health(res) {
    sendJson(res, 200, {
      ok: true,
      source: this.source?.describe?.() ?? null,
      timeline: {
        window: this.timeline.window,
        freshness: this.timeline.freshness,
        sequenceResetCount: this.sequenceResetCount,
        lastPlaylistSequence: this.timeline.lastPlaylistSequence,
        poller: this.poller?.stats ?? null,
      },
    });
  }

  windowJson(res) {
    sendJson(res, 200, {
      ...this.timeline.snapshot(),
      sourceNow: Date.now(),
    });
  }

  playhead(res, url) {
    const t = Number(url.searchParams.get('t'));
    try {
      const resolved = this.timeline.resolvePlayback(t);
      const described = resolved.segment ? this.timeline.describe(resolved.segment) : null;
      sendJson(res, 200, {
        ...resolved,
        segment: described,
        playableUrl: described ? `/replay/seg/${described.sequence}` : null,
      });
    } catch (error) {
      if (error instanceof WindowError) {
        sendJson(res, 409, { code: error.code, message: error.message, ...error });
      } else throw error;
    }
  }

  sequenceLookup(res, url) {
    const sequence = Number(url.pathname.split('/').pop());
    try {
      const entry = this.timeline.resolveSequence(sequence);
      sendJson(res, 200, { ...this.timeline.describe(entry) });
    } catch (error) {
      if (error instanceof WindowError) {
        sendJson(res, 410, { code: error.code, message: error.message, ...error });
      } else throw error;
    }
  }

  async playlist(res) {
    const snapshot = this.timeline.snapshot();
    const { window, freshness } = snapshot;
    if (window.start === null) {
      res.writeHead(503, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n');
      return;
    }
    const target = Math.max(1, Math.ceil(Math.max(...window.segments.map((s) => s.duration))));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${window.segments[0].sequence}`,
      `#EXT-X-PLAYLIST-TYPE:EVENT`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MAP:URI="/replay/init.mp4"',
      `#EXT-X-KERNEL-FRESH:${freshness.fresh ? 'YES' : 'NO'}`,
      `#EXT-X-KERNEL-WINDOW:${window.start.toFixed(3)}-${window.end.toFixed(3)}`,
    ];
    let previousDisc = null;
    let previousEnd = null;
    for (const segment of window.segments) {
      if (previousDisc !== null && segment.runId !== previousDisc) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      // A run boundary is placed on the playback axis; where segments are
      // missing, the published EXTINF reflects the declared timeline so the
      // player does not slide subsequent segments earlier.
      lines.push(`#EXT-X-FRAME-RANGE:${segment.frameRange ? `${segment.frameRange.first}-${segment.frameRange.last}` : ''}`);
      if (segment.gap) lines.push('#EXT-X-GAP');
      lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
      lines.push(`/replay/seg/${segment.sequence}`);
      previousDisc = segment.runId;
      previousEnd = segment.playbackEnd;
    }
    void previousEnd;
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    });
    res.end(lines.join('\n') + '\n');
  }

  async init(res) {
    const cached = this.initCache.get('init');
    if (cached) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
      res.end(cached);
      return;
    }
    const response = await fetch(new URL('/live/init.mp4', this.sourceBaseUrl));
    if (!response.ok) {
      sendJson(res, 502, { error: `init fetch failed (${response.status})` });
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    this.initCache.set('init', bytes);
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.end(bytes);
  }

  async segment(res, url) {
    const sequence = Number(url.pathname.split('/').pop());
    let entry;
    try {
      entry = this.timeline.resolveSequence(sequence);
    } catch (error) {
      if (error instanceof WindowError) {
        // Explicit refusal with a relocation hint: the segment is gone and
        // must not be requested again as if it still existed.
        sendJson(res, 410, {
          code: error.code,
          message: error.message,
          relocatedTo: error.relocatedTo ?? null,
          relocatedSequence: error.relocatedSequence ?? null,
          evictedRange: error.evictedRange ?? null,
          available: error.available ?? null,
        });
        return;
      }
      throw error;
    }
    const upstream = new URL(entry.uri, this.sourceBaseUrl);
    const response = await fetch(upstream);
    if (!response.ok) {
      sendJson(res, 502, { error: `upstream segment fetch failed (${response.status})`, sequence });
      return;
    }
    const raw = Buffer.from(await response.arrayBuffer());
    const initBytes = await this.getInitBytes();
    const info = parseInit(initBytes);
    let body;
    let measured = null;
    try {
      body = rewriteSegmentTimeline(raw, entry.playbackStart, info);
      measured = segmentStats(body, info);
    } catch (error) {
      sendJson(res, 500, { error: `segment rewrite failed: ${error.message}`, sequence });
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/iso.segment',
      'cache-control': 'no-store',
      'x-kernel-sequence': String(entry.sequence),
      'x-kernel-playback-start': String(entry.playbackStart),
      'x-kernel-frame-range': entry.frameRange ? `${entry.frameRange.first}-${entry.frameRange.last}` : '',
      'x-kernel-video-duration': measured ? String(measured.find((s) => s.samples > 0)?.durationSeconds.toFixed(4)) : '',
    });
    res.end(body);
  }

  async getInitBytes() {
    const cached = this.initCache.get('init');
    if (cached) return cached;
    const response = await fetch(new URL('/live/init.mp4', this.sourceBaseUrl));
    if (!response.ok) throw new Error(`init fetch failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    this.initCache.set('init', bytes);
    return bytes;
  }

  async scenario(res, url) {
    const action = url.pathname.split('/').pop();
    if (!this.source) {
      sendJson(res, 503, { error: 'no dynamic source in this process' });
      return;
    }
    if (action === 'advance') {
      const count = Number(url.searchParams.get('n') ?? 1);
      await this.source.advance(count);
      sendJson(res, 200, { ok: true, ...this.source.describe() });
      return;
    }
    if (action === 'release') {
      const released = this.source.releaseDelayed();
      sendJson(res, 200, { ok: true, released, ...this.source.describe() });
      return;
    }
    sendJson(res, 404, { error: `unknown scenario action ${action}` });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

// Serve the public/ directory for the player UI.
export function createStaticHandler(rootDir) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let filePath = path.join(rootDir, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = path.join(rootDir, 'index.html');
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const bytes = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  };
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

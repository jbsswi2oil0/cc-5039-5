// Live playlist poller.
//
// Polling is deliberately separate from the timeline: a failed fetch marks the
// last confirmed range as stale but never discards it, and never pretends the
// stream is still advancing. A parse failure or a sequence reset is surfaced so
// callers can decide whether to rebuild state.

import { parseMediaPlaylist } from './playlist.js';

export class PlaylistPoller {
  constructor({ url, intervalMs = 1000, fetchImpl = globalThis.fetch, onPlaylist, onError, now = Date.now }) {
    this.url = url;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.onPlaylist = onPlaylist;
    this.onError = onError;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.etag = null;
    this.lastModified = null;
    this.stats = { fetches: 0, failures: 0, notModified: 0, lastDurationMs: null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  async tick() {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    const startedAt = this.now();
    try {
      const headers = { 'cache-control': 'no-cache' };
      if (this.etag) headers['if-none-match'] = this.etag;
      if (this.lastModified) headers['if-modified-since'] = this.lastModified;
      const response = await this.fetchImpl(this.url, { headers, signals: undefined, cache: 'no-store' });
      this.stats.fetches += 1;
      if (response.status === 304) {
        this.stats.notModified += 1;
        this.onPlaylist?.({ notModified: true, fetchedAt: startedAt });
        return;
      }
      if (!response.ok) throw new Error(`playlist fetch failed with HTTP ${response.status}`);
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      if (etag) this.etag = etag;
      if (lastModified) this.lastModified = lastModified;
      const text = await response.text();
      const fetchedAt = this.now();
      const playlist = parseMediaPlaylist(text, this.url);
      this.onPlaylist?.({ playlist, fetchedAt, notModified: false });
    } catch (error) {
      this.stats.failures += 1;
      this.onError?.(error, { at: this.now() });
    } finally {
      this.stats.lastDurationMs = this.now() - startedAt;
      this.inFlight = false;
      this.schedule(this.intervalMs);
    }
  }
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamicOrigin } from '../origin/dynamic-origin.mjs';
import { parseMediaPlaylist } from '../kernel/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(body);
}

export function createServer({ scenario = {}, origin = null, testControl = false } = {}) {
  const dynamicOrigin = origin ?? new DynamicOrigin(scenario);
  // The manifest served to the browser is proxied through the server so the
  // page has a same-origin playlist URL; this is still a live endpoint.
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // Test-only control plane. Off unless explicitly enabled, so the demo
    // cannot be driven from outside.
    if (testControl && pathname.startsWith('/test/')) {
      if (req.method !== 'POST') return send(res, 405, 'POST required');
      if (pathname === '/test/advance') {
        const to = Number(url.searchParams.get('to'));
        if (!Number.isFinite(to) || to < 0) return send(res, 400, 'bad to');
        dynamicOrigin.advanceTo(to);
        return send(res, 200, JSON.stringify({ newestContentIndex: dynamicOrigin.newestContentIndex() }));
      }
      if (pathname === '/test/scenario') {
        const body = await new Promise((resolve) => {
          let b = '';
          req.on('data', (c) => (b += c));
          req.on('end', () => resolve(b));
        });
        let partial = {};
        try {
          partial = JSON.parse(body);
        } catch {
          return send(res, 400, 'bad json');
        }
        dynamicOrigin.setScenario(partial);
        return send(res, 200, JSON.stringify(dynamicOrigin.scenario));
      }
      if (pathname === '/test/fail') {
        const count = Number(url.searchParams.get('count') ?? '1');
        dynamicOrigin.forcedFailures = Math.max(0, count);
        return send(res, 200, JSON.stringify({ forcedFailures: dynamicOrigin.forcedFailures }));
      }
      return send(res, 404, 'unknown test endpoint');
    }

    if (pathname === '/live/index.m3u8') {
      const result = dynamicOrigin.poll();
      if (result.status !== 200) return send(res, result.status, result.body, {
        'content-type': 'text/plain',
        'retry-after': '1',
      });
      return send(res, 200, result.body, { 'content-type': result.contentType });
    }

    if (pathname === '/live/init.mp4') {
      const init = await dynamicOrigin.initSegment();
      return send(res, 200, init, { 'content-type': 'video/mp4' });
    }

    if (pathname.startsWith('/live/segment-')) {
      const uri = pathname.slice('/live/'.length);
      const meta = dynamicOrigin.segmentMeta(uri);
      if (!meta) return send(res, 404, 'not found');
      try {
        const media = await dynamicOrigin.segmentMedia(uri);
        if (!media) return send(res, 404, 'not found');
        return send(res, 200, media, {
          'content-type': 'video/mp4',
          'x-frame-start': String(meta.frameStart),
          'x-content-index': String(meta.contentIndex),
          'x-epoch': String(meta.epoch),
        });
      } catch (error) {
        return send(res, 503, String(error?.message ?? error), { 'content-type': 'text/plain' });
      }
    }

    if (pathname === '/api/kernel') {
      // Server-side kernel view, so the page and tests can compare the
      // player's position with the kernel's authoritative mapping.
      return send(res, 200, JSON.stringify(server.kernelSnapshot?.() ?? null), {
        'content-type': 'application/json',
      });
    }

    // Static UI files.
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(ROOT, safe);
    if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, data, {
        'content-type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
    });
  });
  server.origin = dynamicOrigin;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const scenario = {
    speed: 1,
    windowSegments: Number(process.env.WINDOW_SEGMENTS ?? 8),
    segmentIntervalMs: Number(process.env.SEGMENT_INTERVAL_MS ?? 4000),
    startHoursAgo: Number(process.env.START_HOURS_AGO ?? 0.25),
    ...(process.env.SCENARIO ? JSON.parse(process.env.SCENARIO) : {}),
  };
  const server = createServer({ scenario, testControl: process.env.TEST_CONTROL === '1' });
  server.listen(port, () => {
    console.log(`live-replay origin on http://localhost:${port}/`);
    console.log(`playlist: http://localhost:${port}/live/index.m3u8`);
  });
}

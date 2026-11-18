// HTTP surface of the dynamic source. This stands in for the upstream live
// origin: it publishes a manifest and serves the encoded fragments.

import http from 'node:http';
import { readFile } from 'node:fs/promises';

export function createLiveServer(source, { port = 8090, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/live/live.m3u8') {
        const body = source.manifest({ includeDelayed: url.searchParams.get('includeDelayed') === '1' });
        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        });
        res.end(body);
        return;
      }
      if (url.pathname === '/live/init.mp4') {
        const bytes = await readFile(source.initPath());
        res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
        res.end(bytes);
        return;
      }
      if (url.pathname.startsWith('/live/seg/')) {
        const file = decodeURIComponent(url.pathname.split('/').pop());
        const match = /^s(\d+)-\d+-\d+\.m4s$/.exec(file);
        if (!match) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const sequence = Number(match[1]);
        const segPath = source.segmentPath(sequence);
        if (!segPath) {
          // A gap or an unpublished (delayed) segment: behave like a live
          // origin that does not have the object yet.
          res.writeHead(404, { 'cache-control': 'no-store' });
          res.end('not published');
          return;
        }
        const bytes = await readFile(segPath);
        res.writeHead(200, { 'content-type': 'video/iso.segment', 'cache-control': 'no-store' });
        res.end(bytes);
        return;
      }
      if (url.pathname === '/live/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(source.describe()));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.message ?? error));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, port, host }));
  });
}

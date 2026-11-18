// Dynamic replay demo.
//
// Starts a dynamic source (a live camera with a moving picture and a frame
// barcode), its live origin, and the replay kernel plus player UI. The kernel
// polls the live manifest and the player streams the kernel's segments.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EncodeSource } from './source/encode-source.js';
import { createLiveServer } from './live-server.js';
import { ReplayKernelServer, createStaticHandler } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = Number(process.env.PORT ?? 8080);
const LIVE_PORT = Number(process.env.LIVE_PORT ?? 8090);
const SEGMENT_FRAMES = Number(process.env.SEGMENT_FRAMES ?? 30);
const RETAIN_SECONDS = Number(process.env.RETAIN_SECONDS ?? 24);
const POLL_MS = Number(process.env.POLL_MS ?? 250);
const ADVANCE_MS = Number(process.env.ADVANCE_MS ?? SEGMENT_FRAMES * (1000 / 30));
const PREBUILT = process.env.PREBUILT ? Number(process.env.PREBUILT) : 60;

const scenarios = {
  resetAtSequence: process.env.RESET_AT ? Number(process.env.RESET_AT) : null,
  gapSequences: (process.env.GAP_SEQUENCES ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number),
  delayedSequences: (process.env.DELAYED_SEQUENCES ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number),
  declareStalePdt: process.env.STALE_PDT === '1',
};

const source = await new EncodeSource({
  dir: process.env.SOURCE_DIR ?? path.join(root, '.data', 'source'),
  segmentFrames: SEGMENT_FRAMES,
  scenarios,
}).init();

await source.advance(PREBUILT);
source.releaseDelayed();

const live = await createLiveServer(source, { port: LIVE_PORT });
const kernel = new ReplayKernelServer({
  source,
  sourceBaseUrl: `http://127.0.0.1:${LIVE_PORT}`,
  port: PORT,
  retainSeconds: RETAIN_SECONDS,
  pollIntervalMs: POLL_MS,
  upstreamFailures: process.env.FAIL_UPSTREAM === '1',
});
await kernel.listen();

// Keep the "camera" running so the window actually moves.
const advanceTimer = setInterval(() => {
  if (process.env.PAUSE_SOURCE === '1') return;
  source.advance(1).catch((error) => console.error('advance failed', error.message));
}, ADVANCE_MS);
advanceTimer.unref?.();

const staticHandler = createStaticHandler(path.join(root, 'public'));
const staticServer = http.createServer((req, res) => {
  // Everything that is not the kernel API or its replay surface falls through
  // to the player UI.
  if (
    req.url.startsWith('/api/') ||
    req.url.startsWith('/replay/')
  ) {
    kernel.server.emit('request', req, res);
    return;
  }
  if (req.url.startsWith('/node_modules/')) {
    const urlPath = new URL(req.url, 'http://x').pathname;
    const filePath = path.join(root, urlPath);
    import('node:fs/promises').then(({ readFile }) => {
      readFile(filePath)
        .then((bytes) => {
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
          res.end(bytes);
        })
        .catch(() => {
          res.writeHead(404);
          res.end('not found');
        });
    });
    return;
  }
  staticHandler(req, res);
});
await new Promise((resolve) => staticServer.listen(PORT + 1, '127.0.0.1', resolve));

console.log(`replay kernel  http://127.0.0.1:${PORT}`);
console.log(`player UI      http://127.0.0.1:${PORT + 1}/`);
console.log(`live origin    http://127.0.0.1:${LIVE_PORT}/live/live.m3u8`);

async function shutdown() {
  clearInterval(advanceTimer);
  await kernel.close();
  await new Promise((resolve) => staticServer.close(resolve));
  await new Promise((resolve) => live.server.close(resolve));
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

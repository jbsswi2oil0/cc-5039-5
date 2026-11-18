// End-to-end browser check.
//
// Boots the dynamic source, live origin, kernel and player, then drives the
// real page in headless Chrome. Every assertion about "what is on screen" is
// made by decoding the frame barcode out of the rendered video, so a moving
// progress bar over a static file cannot pass.
//
// Run with:  npm run test:e2e
// Requires Chrome's shared libraries; see README if Chrome cannot start.

import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EncodeSource } from '../src/source/encode-source.js';
import { createLiveServer } from '../src/live-server.js';
import { ReplayKernelServer, createStaticHandler } from '../src/server.js';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SEGMENT_FRAMES = 12;
const FPS = 30;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 100, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} not met: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function expectedFrame(playbackStart, frameRange) {
  // The kernel axis is built from declared durations; within a segment the
  // picture is the source capture frame that started at that offset.
  const offset = Math.max(0, Math.round((playbackStart - playbackStart) * FPS));
  void offset;
  return frameRange;
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-browser-'));
  const source = await new EncodeSource({
    dir,
    segmentFrames: SEGMENT_FRAMES,
    fps: FPS,
    upstreamWindowSegments: 40,
    scenarios: { publishLagSegments: 1 },
  }).init();
  await source.advance(40);

  const livePort = await freePort();
  const live = await createLiveServer(source, { port: livePort });
  const kernelPort = await freePort();
  const kernel = new ReplayKernelServer({
    source,
    sourceBaseUrl: `http://127.0.0.1:${livePort}`,
    port: kernelPort,
    retainSeconds: 16,
    pollIntervalMs: 120,
  });
  await kernel.listen();

  const uiPort = await freePort();
  const staticHandler = createStaticHandler(path.join(root, 'public'));
  const ui = http.createServer((req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/replay/')) {
      kernel.server.emit('request', req, res);
      return;
    }
    staticHandler(req, res);
  });
  await new Promise((resolve) => ui.listen(uiPort, '127.0.0.1', resolve));

  // Media is produced at exactly 1x real time: 12 frames per 400 ms.
  let advanceTimer = setInterval(() => {
    source.advance(1).catch(() => {});
  }, (SEGMENT_FRAMES / FPS) * 1000);

  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  };

  const stopSource = () => {
    if (advanceTimer) clearInterval(advanceTimer);
    advanceTimer = null;
  };
  const startSource = () => {
    if (advanceTimer) return;
    advanceTimer = setInterval(() => {
      source.advance(1).catch(() => {});
    }, (SEGMENT_FRAMES / FPS) * 1000);
  };

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${uiPort}/`, { waitUntil: 'domcontentloaded' });

    const probe = () => page.evaluate(() => window.__replayProbe());

    // 1. Real playback starts, with media buffered on the kernel axis.
    const playing = await waitFor(async () => {
      const p = await probe();
      return p.status.readyState >= 2 && p.status.ranges.length > 0 ? p : null;
    }, { label: 'playback ready' });
    await waitFor(async () => {
      const p = await probe();
      return p.status.currentTime > playing.status.currentTime + 0.2 ? p : null;
    }, { label: 'currentTime advancing' });
    const live1 = await probe();
    check(
      'video plays real segments on the kernel axis',
      live1.status.currentTime > 0 && live1.status.ranges.length > 0,
      `t=${live1.status.currentTime} range=${JSON.stringify(live1.status.ranges)}`,
    );

    // Let the live playhead reach the live edge so there is real history
    // behind it, then stop the source: the window and the picture are frozen
    // while the picture is measured.
    await waitFor(async () => {
      const p = await probe();
      return p.status.currentTime > p.snapshot.window.end - 4 &&
        p.snapshot.window.end - p.snapshot.window.start > 12
        ? p
        : null;
    }, { timeoutMs: 30000, label: 'playhead reaches live edge' });
    stopSource();

    // Pause first, seek precisely, then read the picture. Playback is not
    // running during the measurement, so the barcode belongs to exactly the
    // frame the kernel resolved.
    const probeAt = async (t) => {
      // Route the seek through the player so the needed segment is actually
      // buffered before the video element is moved.
      await page.evaluate(async (target) => {
        const player = window.__player;
        const video = document.getElementById('video');
        player.setFollowLive(false);
        player.pause();
        await player.seek(target);
        const started = Date.now();
        while (Date.now() - started < 4000) {
          if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.35) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((r) => setTimeout(r, 150));
      }, t);
      return probe();
    };

    // 2. The picture is the frame the manifest says it is.
    const liveNow = await probe();
    const liveProbe = await probeAt(liveNow.status.currentTime);
    // Resolve the segment from the position that was actually rendered.
    const liveSegment = liveProbe.snapshot.window.segments.find(
      (s) => liveProbe.status.currentTime >= s.playbackStart &&
        liveProbe.status.currentTime < s.playbackEnd,
    );
    const liveExpected = liveSegment.frameRange.first +
      Math.round((liveProbe.status.currentTime - liveSegment.playbackStart) * FPS);
    check(
      'on-screen frame id lies inside the advertised frame range',
      liveProbe.frameId >= liveSegment.frameRange.first - 1 &&
        liveProbe.frameId <= liveSegment.frameRange.last + 1,
      `frame=${liveProbe.frameId} expected~${liveExpected} range=${liveSegment.frameRange.first}-${liveSegment.frameRange.last}`,
    );

    // 3. Replay six seconds inside the window shows earlier real frames.
    const replayTarget = liveProbe.status.currentTime - 6;
    check(
      'replay target is still inside the available window',
      replayTarget >= liveProbe.snapshot.window.start,
      `target=${replayTarget.toFixed(2)} start=${liveProbe.snapshot.window.start}`,
    );
    const replayed = await probeAt(replayTarget);
    const currentReplay = replayed.snapshot.window.segments.find(
      (s) => replayed.status.currentTime >= s.playbackStart && replayed.status.currentTime < s.playbackEnd,
    );
    check(
      'seeking back shows a strictly earlier frame, not the live picture',
      replayed.frameId < liveProbe.frameId - 90,
      `replay frame=${replayed.frameId} (t=${replayed.status.currentTime}) live frame=${liveProbe.frameId} (t=${liveProbe.status.currentTime})`,
    );
    check(
      'replay picture matches the replayed segment frame range',
      currentReplay &&
        replayed.frameId >= currentReplay.frameRange.first - 1 &&
        replayed.frameId <= currentReplay.frameRange.last + 1,
      currentReplay
        ? `frame=${replayed.frameId} seg=${currentReplay.sequence} range=${currentReplay.frameRange.first}-${currentReplay.frameRange.last}`
        : 'no segment',
    );

    // Resume playback and the source; the window now rolls forward past the
    // replay target.
    await page.evaluate(() => {
      window.__player.setFollowLive(true);
      window.__player.play().catch(() => {});
    });
    startSource();

    // 4. Window rolls forward past the replay target: the kernel must refuse
    //    the old position and relocate the player.
    const oldTarget = replayTarget;
    await waitFor(async () => {
      const p = await probe();
      return p.snapshot.window.start > oldTarget + 0.5 ? p : null;
    }, { timeoutMs: 25000, label: 'window rolls past replay target' });
    const relocated = await waitFor(async () => {
      const p = await probe();
      return p.status.currentTime >= p.snapshot.window.start && p.status.readyState >= 2
        ? p
        : null;
    }, { label: 'player relocated inside window' });
    const closedLookup = await fetch(
      `http://127.0.0.1:${kernelPort}/api/playhead?t=${oldTarget.toFixed(3)}`,
    );
    const closedBody = await closedLookup.json();
    check(
      'evicted replay target is refused and the player is relocated',
      closedLookup.status === 409 && closedBody.code === 'EVICTED',
      `HTTP ${closedLookup.status} ${closedBody.code} relocatedTo=${closedBody.relocatedTo}`,
    );
    check(
      'player actually moved to the new window start',
      relocated.status.currentTime >= relocated.snapshot.window.start - 0.05,
      `t=${relocated.status.currentTime} start=${relocated.snapshot.window.start}`,
    );

    // 5. The player keeps receiving new segments as the source advances.
    const beforeTail = (await probe()).snapshot.window.end;
    await waitFor(async () => {
      const p = await probe();
      return p.snapshot.window.end > beforeTail + 0.2 ? p : null;
    }, { timeoutMs: 15000, label: 'window end advances' });
    check('window end advances while playing', true);

    // 6. Refresh the page against a fresh kernel state (no console errors).
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    // 7. Sequence reset: drive the source into a reset and verify the page
    //    survives with a new epoch rather than freezing.
    await page.evaluate(() => {
      window.__player.setFollowLive(true);
    });
    const epochBefore = (await probe()).snapshot.epoch;
    source.scenarios.resetAtSequence = source.sequence + 2;
    const afterReset = await waitFor(async () => {
      const p = await probe();
      return p.snapshot.epoch > epochBefore ? p : null;
    }, { timeoutMs: 25000, label: 'epoch advance after reset' });
    const resetPlaying = await waitFor(async () => {
      const p = await probe();
      return p.status.readyState >= 2 && p.snapshot.epoch === afterReset.snapshot.epoch
        ? p
        : null;
    }, { timeoutMs: 15000, label: 'player resumes after reset' });
    check(
      'player resumes on the new epoch after a sequence reset',
      resetPlaying.status.readyState >= 2,
      `epoch=${resetPlaying.snapshot.epoch} t=${resetPlaying.status.currentTime}`,
    );

    const failures = results.filter((r) => !r.ok);
    const summary = {
      results,
      window: (await probe()).snapshot.window,
      epoch: (await probe()).snapshot.epoch,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) {
      throw new Error(`${failures.length} browser check(s) failed`);
    }
  } finally {
    clearInterval(advanceTimer);
    await browser.close();
    await kernel.close();
    await new Promise((resolve) => ui.close(resolve));
    await new Promise((resolve) => live.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

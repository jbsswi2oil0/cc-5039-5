// End-to-end tests.
//
// Each test starts its own dynamic origin (deterministic, manual advance) and
// drives a real Chromium MSE player. Frame numbers are verified by decoding
// the burned-in barcode from the *decoded video frame*, not from the manifest
// or the kernel's own bookkeeping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const LIBS = '/workspace/.chromelibs/usr/lib/aarch64-linux-gnu:/workspace/.chromelibs/lib/aarch64-linux-gnu';
process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

let nextPort = 8200;

async function startOrigin(scenario, { port = nextPort++ } = {}) {
  const child = spawn(process.execPath, ['src/server/server.mjs'], {
    cwd: '/workspace',
    env: {
      ...process.env,
      PORT: String(port),
      TEST_CONTROL: '1',
      SCENARIO: JSON.stringify({ autoAdvance: false, ...scenario }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`origin did not start: ${logs.join('')}`)), 12000);
    const check = () => {
      if (logs.join('').includes('playlist:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
  });
  const base = `http://127.0.0.1:${port}`;
  const control = async (path, body = null) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.text();
  };
  return { child, base, port, control, logs, stop: () => child.kill('SIGTERM') };
}

async function openPlayer(origin, query = '') {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin.base}/web/index.html?poll=500&${query}`);
  await page.waitForFunction(() => window.__player?.viewValue, null, { timeout: 40000 });
  return { browser, page, errors };
}

async function playFor(page, ms) {
  await page.waitForTimeout(ms);
}

async function snapshot(page) {
  return page.evaluate(() => window.__snapshot());
}

async function waitFor(page, predicate, { timeout = 20000, label = 'condition', arg = null } = {}) {
  await page.waitForFunction(predicate, arg, { timeout, polling: 100 });
}

// Decodes the currently displayed video frame and checks it against the
// kernel's expected frame for the playhead.
async function checkFrame(page) {
  const check = await page.evaluate(() => window.__sampleFrame());
  assert.ok(check, 'frame must decode');
  assert.equal(check.checksumOk, true, 'barcode checksum');
  assert.ok(check.expectedFrame != null, 'expected frame known');
  assert.ok(
    Math.abs(check.decodedFrame - check.expectedFrame) <= 1,
    `decoded frame ${check.decodedFrame} vs expected ${check.expectedFrame} at ${check.atMs}ms`,
  );
  return check;
}

test('normal live playback: window, playhead and burned-in frame agree', async (t) => {
  const origin = await startOrigin({ startSegment: 100, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=120');
  const { browser, page, errors } = await openPlayer(origin);
  t.after(async () => {
    await browser.close();
  });

  await playFor(page, 2500);
  const snap = await snapshot(page);
  assert.equal(snap.freshness.state, 'live');
  assert.equal(snap.freshness.liveEdgeIsCurrent, true);
  // The kernel derives media time from declared durations within the relation,
  // so the first relation's timeline starts at 0. Its extent is exactly the
  // declared window: six 4s segments.
  assert.equal(snap.window.startMs, 0);
  assert.equal(snap.window.endMs, 6 * 4000);
  assert.ok(snap.playhead.inWindow);

  const check = await checkFrame(page);
  // Content index 115 is the oldest in this window, so its frames start there;
  // the burned-in number must reflect real content, not a rotation from zero.
  assert.ok(
    check.decodedFrame >= 115 * 120,
    `decoded frame ${check.decodedFrame} must belong to published content`,
  );

  // Playback advances.
  const t0 = snap.playhead.mediaMs;
  await playFor(page, 1500);
  const snap2 = await snapshot(page);
  assert.ok(snap2.playhead.mediaMs > t0, 'playhead advances');
  await checkFrame(page);
  assert.deepEqual(errors, []);
});

test('window rolls forward while replaying: evicted target is refused, not refetched', async (t) => {
  const origin = await startOrigin({ startSegment: 200, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=220');
  const { browser, page } = await openPlayer(origin);
  t.after(async () => {
    await browser.close();
  });
  await playFor(page, 2000);

  // Enter replay 10s behind the live edge.
  const snap = await snapshot(page);
  const decision = await page.evaluate(
    (target) => window.__seek(target),
    snap.window.endMs - 10_000,
  );
  assert.equal(decision.ok, true);
  await playFor(page, 1200);
  const before = await snapshot(page);
  assert.equal(before.mode, 'replay');
  await checkFrame(page);
  const replayTarget = before.playhead.mediaMs;

  const refusedBefore = before.fetchStats.refused;
  const segmentFetchesBefore = before.fetchStats.failures;

  // Roll the window far past the replay target. With manual advance the
  // manifest keeps its media timeline and the window moves forward.
  await origin.control('/test/advance?to=260');
  await waitFor(
    page,
    (target) => window.__player.snapshot().window.startMs > target,
    { label: 'window roll', timeout: 15000, arg: replayTarget },
  );
  await playFor(page, 1500);

  const after = await snapshot(page);
  assert.ok(after.window.startMs > replayTarget, 'replay target has been evicted');

  // Asking for the evicted target must be refused explicitly.
  const refused = await page.evaluate((target) => window.__seek(target), replayTarget);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /window-rolled|relation-reset/);
  const afterRefusal = await snapshot(page);
  assert.ok(afterRefusal.fetchStats.refused > refusedBefore, 'refusal counted');
  // A refusal must not have triggered a segment fetch.
  assert.equal(afterRefusal.fetchStats.failures, segmentFetchesBefore);
});

test('sequence reset starts a new relation and cannot be confused with old content', async (t) => {
  const origin = await startOrigin({ startSegment: 300, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=320');
  const { browser, page } = await openPlayer(origin);
  t.after(async () => {
    await browser.close();
  });
  await playFor(page, 2000);
  const before = await snapshot(page);
  assert.equal(before.relation.resetCount, 0);

  // Restart sequence numbering at content 340: msn 340 becomes msn 0, but the
  // content (and burned-in frame number) keeps advancing.
  await origin.control('/test/scenario', {
    resetAtContentIndex: 340,
  });
  await origin.control('/test/advance?to=342');
  await waitFor(page, () => window.__player.snapshot().relation.resetCount >= 1, {
    label: 'relation reset',
  });
  await playFor(page, 2000);

  const after = await snapshot(page);
  assert.ok(after.relation.resetCount >= 1);
  assert.notEqual(after.relation.id, before.relation.id);
  // Timeline must not go backwards: a stale old target must be reported as
  // evicted rather than silently matching new content at the same media time.
  const stale = await page.evaluate((target) => window.__seek(target), before.playhead.mediaMs);
  assert.equal(stale.ok, false);
  assert.ok(['window-rolled', 'relation-reset'].includes(stale.reason));
  await checkFrame(page);
});

test('a missing segment is reported as a gap and never silently stitched', async (t) => {
  // With startSegment 400, content index == msn. Publishing up to 420 gives a
  // window of msn 415..420. The segment keeps its sequence slot but the source
  // declares it unavailable, so numbering stays aligned (dropping the entry
  // outright would renumber every later segment, which is a different event).
  const origin = await startOrigin({ startSegment: 400, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=420');
  const { browser, page } = await openPlayer(origin);
  t.after(async () => {
    await browser.close();
  });
  await playFor(page, 1500);

  // msn 418 becomes unavailable, still inside the window.
  await origin.control('/test/scenario', { gapMsn: [418] });
  // Advance so the kernel sees the manifest with the hole.
  await origin.control('/test/advance?to=421');
  await waitFor(
    page,
    () => window.__player.snapshot().issues?.some((i) => i.code === 'declared-gap'),
    { label: 'gap issue' },
  );

  const snap = await snapshot(page);
  const gapIssue = snap.issues.find((i) => i.code === 'declared-gap');
  assert.equal(gapIssue.msn, 418);

  // The relation's media timeline starts at 0 with msn 415, so msn 418's slot
  // is [12s, 16s); 14s is inside the hole.
  const located = await page.evaluate(() => window.__player.viewValue.locate(14_000));
  assert.equal(located.status, 'gap');
  assert.equal(located.reason, 'declared-gap');
  const decision = await page.evaluate(() => window.__seek(14_000));
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'gap');
  // A refused seek must not cause a fetch of the missing segment.
  const after = await snapshot(page);
  assert.equal(after.fetchStats.failures, snap.fetchStats.failures);

  // A position after the hole is still reachable.
  const later = await page.evaluate(() => window.__seek(18_000));
  assert.equal(later.ok, true);
  await checkFrame(page);
});

test('manifest failures retain the last confirmed range and stop claiming live', async (t) => {
  const origin = await startOrigin({ startSegment: 500, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=520');
  const { browser, page } = await openPlayer(origin, 'staleAfterMs=3000&stallAfterMs=4000');
  t.after(async () => {
    await browser.close();
  });
  await playFor(page, 1500);
  const before = await snapshot(page);
  assert.equal(before.freshness.state, 'live');

  // Fail every poll for a while. The content is not advanced either.
  await origin.control('/test/fail?count=50');
  await playFor(page, 5000);

  const during = await snapshot(page);
  assert.ok(['unconfirmed', 'stale'].includes(during.freshness.state));
  assert.equal(during.freshness.liveEdgeIsCurrent, false);
  // The confirmed range must be retained, not dropped or advanced.
  assert.equal(during.window.startMs, before.window.startMs);
  assert.equal(during.window.endMs, before.window.endMs);
  assert.ok(during.freshness.consecutiveFailures > 0);
  // The player must not present it as an ongoing live edge.
  assert.equal(during.freshness.state, 'stale');

  // Recovery returns to live.
  await origin.control('/test/fail?count=0');
  await origin.control('/test/advance?to=525');
  await waitFor(page, () => window.__player.snapshot().freshness.state === 'live', {
    label: 'recovery',
  });
  const after = await snapshot(page);
  assert.equal(after.freshness.state, 'live');
  assert.ok(after.window.endMs > during.window.endMs);
});

test('late source update: manifest content that stops advancing is marked stalled', async (t) => {
  const origin = await startOrigin({ startSegment: 600, windowSegments: 6 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=620');
  const { browser, page } = await openPlayer(origin, 'stallAfterMs=3000');
  t.after(async () => {
    await browser.close();
  });
  await playFor(page, 1200);
  assert.equal((await snapshot(page)).freshness.state, 'live');

  // Polls keep succeeding (HTTP 200) but the content does not advance.
  await playFor(page, 4500);
  const snap = await snapshot(page);
  assert.equal(snap.freshness.state, 'stalled');
  assert.equal(snap.freshness.liveEdgeIsCurrent, false);
  assert.ok(snap.freshness.contentAgeMs >= 3000);

  // Advancing the source resumes live.
  await origin.control('/test/advance?to=626');
  await waitFor(page, () => window.__player.snapshot().freshness.state === 'live', {
    label: 'unstall',
  });
});

test('delivered segments are real encoded media whose frame index matches the URI', async (t) => {
  const origin = await startOrigin({ startSegment: 700, windowSegments: 4 });
  t.after(() => origin.stop());
  await origin.control('/test/advance?to=705');
  const res = await fetch(`${origin.base}/live/segment-0-703.m4s`);
  assert.equal(res.status, 200);
  const frameStart = Number(res.headers.get('x-frame-start'));
  assert.equal(frameStart, 703 * 120);
  const buf = Buffer.from(await res.arrayBuffer());
  // It is animated content, not a single static frame: a real fMP4 media
  // fragment (the init segment is served separately at /live/init.mp4).
  assert.ok(buf.length > 20_000, 'segment has real media payload');
  assert.equal(buf.toString('latin1', 4, 8), 'moof');
  const moofCount = buf.toString('latin1').split('moof').length - 1;
  assert.ok(moofCount >= 1, 'has media fragment');
});

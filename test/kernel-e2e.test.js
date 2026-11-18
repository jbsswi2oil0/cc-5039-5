import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncodeSource } from '../src/source/encode-source.js';
import { createLiveServer } from '../src/live-server.js';
import { ReplayKernelServer } from '../src/server.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 50 } = {}) {
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
  throw new Error(`condition not met: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function harness(t, {
  scenarios = {},
  retainSeconds = 8,
  segmentFrames = 10,
  autoAdvanceMs = null,
  upstreamWindowSegments = 12,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kernel-e2e-'));
  const source = await new EncodeSource({
    dir,
    segmentFrames,
    scenarios: { ...scenarios },
    upstreamWindowSegments,
  }).init();
  await source.advance(6);
  const livePort = await freePort();
  const live = await createLiveServer(source, { port: livePort });
  const kernelPort = await freePort();
  const kernel = new ReplayKernelServer({
    source,
    sourceBaseUrl: `http://127.0.0.1:${livePort}`,
    port: kernelPort,
    retainSeconds,
    pollIntervalMs: 40,
  });
  await kernel.listen();
  let timer = null;
  if (autoAdvanceMs) {
    timer = setInterval(() => {
      source.advance(1).catch(() => {});
    }, autoAdvanceMs);
    timer.unref?.();
  }
  t.after(async () => {
    if (timer) clearInterval(timer);
    await kernel.close();
    await new Promise((resolve) => live.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { source, kernel, livePort, kernelPort, dir };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, headers: response.headers };
}

test('kernel window advances with the source and reports real frame ranges', async (t) => {
  const { source, kernelPort } = await harness(t, { segmentFrames: 10 });
  const first = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.start !== null ? body : null;
  });
  assert.equal(first.epoch, 0);
  assert.ok(first.window.segments.length > 0);
  assert.equal(first.freshness.fresh, true);

  await source.advance(3);
  const advanced = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.end > first.window.end ? body : null;
  });
  assert.ok(advanced.window.end > first.window.end);
  // Frame ranges move with the source, not with playlist arithmetic.
  for (const segment of advanced.window.segments) {
    const declared = source.frameForSequence(segment.sequence);
    assert.deepEqual(segment.frameRange, declared);
  }
});

test('segment bytes are re-anchored to the advertised playback time', async (t) => {
  const { kernelPort } = await harness(t, { segmentFrames: 10 });
  const view = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.segments.length >= 2 ? body : null;
  });
  const segment = view.window.segments[1];
  const response = await fetch(`http://127.0.0.1:${kernelPort}/replay/seg/${segment.sequence}`);
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('x-kernel-playback-start')), segment.playbackStart);
  const bytes = Buffer.from(await response.arrayBuffer());
  const { parseInit, segmentStats } = await import('../src/kernel/fmp4.js');
  const init = await (await fetch(`http://127.0.0.1:${kernelPort}/replay/init.mp4`)).arrayBuffer();
  const info = parseInit(Buffer.from(init));
  const stats = segmentStats(bytes, info);
  const video = stats.find((s) => s.trackId === 1);
  // tfdt is quantised to the track timescale (1/15360 s), so the media start
  // agrees with the advertised axis to within one tick.
  assert.ok(
    Math.abs(video.startSeconds - segment.playbackStart) <= 1 / 15360,
    `media start ${video.startSeconds} vs axis ${segment.playbackStart}`,
  );
  assert.ok(Math.abs(video.durationSeconds - segment.duration) < 1e-3);
  // The segment's internal timestamps continue forward across runs; they are
  // not reset to zero per request.
  const next = view.window.segments[2];
  const response2 = await fetch(`http://127.0.0.1:${kernelPort}/replay/seg/${next.sequence}`);
  const stats2 = segmentStats(Buffer.from(await response2.arrayBuffer()), info);
  assert.ok(
    Math.abs(stats2.find((s) => s.trackId === 1).startSeconds - next.playbackStart) <= 1 / 15360,
  );
  assert.equal(next.playbackStart, segment.playbackEnd);
});

test('evicted positions are refused with an explicit relocation', async (t) => {
  const { kernelPort, source } = await harness(t, {
    retainSeconds: 3,
    segmentFrames: 10,
    autoAdvanceMs: 50,
  });
  await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.start !== null && body.evictedRanges.length > 0 ? body : null;
  });
  const { body } = await getJson(kernelPort, '/api/window');
  const oldestEvicted = body.evictedRanges[0];
  const response = await fetch(
    `http://127.0.0.1:${kernelPort}/api/playhead?t=${oldestEvicted.playbackStart + 0.05}`,
  );
  assert.equal(response.status, 409);
  const refusal = await response.json();
  assert.equal(refusal.code, 'EVICTED');
  assert.equal(refusal.relocatedTo, body.window.start);

  const seqResponse = await fetch(`http://127.0.0.1:${kernelPort}/api/sequence/${oldestEvicted.sequence}`);
  assert.equal(seqResponse.status, 410);
  const seqBody = await seqResponse.json();
  assert.equal(seqBody.code, 'EVICTED');
  assert.ok(seqBody.relocatedSequence >= body.window.segments[0].sequence);

  // The segment itself must not be served: a stale player cannot quietly
  // keep pulling a sequence that has rolled out.
  const segResponse = await fetch(`http://127.0.0.1:${kernelPort}/replay/seg/${oldestEvicted.sequence}`);
  assert.equal(segResponse.status, 410);
  const segBody = await segResponse.json();
  assert.equal(segBody.code, 'EVICTED');
  assert.ok(segBody.relocatedTo !== null);

  // Advancing the source further must not resurrect it.
  await source.advance(3);
  const again = await fetch(`http://127.0.0.1:${kernelPort}/replay/seg/${oldestEvicted.sequence}`);
  assert.equal(again.status, 410);
});

test('manifest keeps the confirmed range but marks it stale after failures', async (t) => {
  const { kernel } = await harness(t, { segmentFrames: 10 });
  const initial = await waitFor(async () => {
    const { body } = await getJson(kernel.port, '/api/window');
    return body.window.start !== null ? body : null;
  });
  kernel.upstreamFailures = true;
  const stale = await waitFor(async () => {
    const { body } = await getJson(kernel.port, '/api/window');
    return body.freshness.fresh === false ? body : null;
  });
  assert.equal(stale.freshness.lastConfirmedAt, initial.freshness.lastConfirmedAt);
  assert.deepEqual(
    stale.window.segments.map((s) => s.sequence),
    initial.window.segments.map((s) => s.sequence),
  );
  assert.ok(stale.freshness.lastError);
  // The replay manifest advertises the stale state rather than pretending to
  // be live.
  const manifest = await (await fetch(`http://127.0.0.1:${kernel.port}/replay/index.m3u8`)).text();
  assert.match(manifest, /#EXT-X-KERNEL-FRESH:NO/);
});

test('a sequence reset starts a new epoch and refuses the old axis', async (t) => {
  const { source, kernelPort } = await harness(t, {
    segmentFrames: 10,
    retainSeconds: 100,
    autoAdvanceMs: 60,
    upstreamWindowSegments: 3,
    scenarios: { resetAtSequence: 9 },
  });
  const before = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.segments.length >= 3 ? body : null;
  });
  const oldSequences = before.window.segments.map((s) => s.sequence);
  assert.ok(oldSequences.length >= 3);

  const after = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.epoch > 0 ? body : null;
  }, { timeoutMs: 15000 });
  assert.ok(after.epoch > 0);
  // The reset is a new run; the new epoch's playback time does not overlap the
  // old run's positions for the same sequence numbers.
  const newFirst = after.window.segments[0];
  assert.equal(newFirst.epoch, after.epoch);
  assert.ok(after.window.runs.some((r) => r.epoch === after.epoch));
  // Old sequence numbers are unknown in the new epoch, not silently aliased.
  // Sequence numbers may legitimately be re-used after a reset, but the old
  // epoch's positions must never be aliased onto the new epoch's content.
  for (const sequence of oldSequences) {
    const oldEntry = before.window.segments.find((s) => s.sequence === sequence);
    const lookup = await getJson(kernelPort, `/api/sequence/${sequence}`);
    if (lookup.status === 200) {
      assert.notEqual(lookup.body.epoch, oldEntry.epoch, `sequence ${sequence} aliased across epochs`);
      assert.notEqual(lookup.body.playbackStart, oldEntry.playbackStart);
    } else {
      assert.equal(lookup.status, 410);
      assert.equal(lookup.body.code, 'UNKNOWN_SEQUENCE');
    }
  }
  // Requesting an old epoch's playback time inside the new window must not
  // produce the new epoch's segment for it unless the position genuinely maps.
  const stale = await getJson(
    kernelPort,
    `/api/playhead?t=${(before.window.segments[0].playbackStart + 0.01).toFixed(3)}`,
  );
  if (stale.status === 200) {
    assert.notEqual(stale.body.segment?.epoch, before.epoch);
  }
});

test('declared gaps are exposed as unplayable but keep the axis linear', async (t) => {
  const { source, kernelPort } = await harness(t, {
    segmentFrames: 10,
    retainSeconds: 100,
    scenarios: { gapSequences: [3] },
  });
  const body = await waitFor(async () => {
    const view = (await getJson(kernelPort, '/api/window')).body;
    return view.window.segments.length >= 6 ? view : null;
  });
  const gap = body.window.segments.find((s) => s.sequence === 3);
  assert.equal(gap.gap, true);
  const previous = body.window.segments.find((s) => s.sequence === 2);
  const next = body.window.segments.find((s) => s.sequence === 4);
  assert.equal(gap.playbackStart, previous.playbackEnd);
  assert.equal(next.playbackStart, gap.playbackEnd);
  const resolved = await getJson(
    kernelPort,
    `/api/playhead?t=${(gap.playbackStart + gap.playbackEnd) / 2}`,
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, 'gap');
  assert.ok(Math.abs(resolved.body.relocatedTo - next.playbackStart) < 1e-6);
  // The upstream does not have the object; the kernel must not invent one.
  const missing = await fetch(`http://127.0.0.1:${kernelPort}/replay/seg/3`);
  assert.notEqual(missing.status, 200);
  await source.advance(1);
});

test('delayed publication is visible as a hole, then fills without shifting time', async (t) => {
  const { source, kernelPort } = await harness(t, {
    segmentFrames: 10,
    retainSeconds: 100,
    autoAdvanceMs: 60,
    scenarios: { publishLagSegments: 2 },
  });
  const view = await waitFor(async () => {
    const body = (await getJson(kernelPort, '/api/window')).body;
    return body.window.segments.length >= 5 ? body : null;
  });
  const sequences = view.window.segments.map((s) => s.sequence);
  // The camera has captured further than the manifest has published, so the
  // window ends at the last published segment.
  assert.ok(sequences.length >= 5);
  const endBefore = view.window.end;
  await waitFor(async () => {
    const body = (await getJson(kernelPort, '/api/window')).body;
    return body.window.segments.length > sequences.length ? body : null;
  });
  const after = (await getJson(kernelPort, '/api/window')).body;
  // Sequence-to-time mapping for the earlier segments is unchanged.
  for (const sequence of sequences) {
    const before = view.window.segments.find((s) => s.sequence === sequence);
    const now = after.window.segments.find((s) => s.sequence === sequence);
    assert.deepEqual(
      [now.playbackStart, now.playbackEnd],
      [before.playbackStart, before.playbackEnd],
    );
  }
  assert.ok(after.window.end > endBefore);
  await source.advance(1);
});

test('replay manifest is generated from the kernel axis, not the upstream one', async (t) => {
  const { kernelPort } = await harness(t, { segmentFrames: 10 });
  const window = await waitFor(async () => {
    const { body } = await getJson(kernelPort, '/api/window');
    return body.window.segments.length >= 3 ? body : null;
  });
  const manifest = await (await fetch(`http://127.0.0.1:${kernelPort}/replay/index.m3u8`)).text();
  const extinf = [...manifest.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
  assert.equal(extinf.length, window.window.segments.length);
  extinf.forEach((duration, i) => {
    assert.ok(Math.abs(duration - window.window.segments[i].duration) < 1e-6);
  });
  const uris = [...manifest.matchAll(/^\/replay\/seg\/(\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(uris, window.window.segments.map((s) => s.sequence));
  assert.match(manifest, new RegExp(`#EXT-X-KERNEL-WINDOW:${window.window.start.toFixed(3)}-${window.window.end.toFixed(3)}`));
});

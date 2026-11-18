import { WindowPlayer } from './player.js';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'),
  toggle: $('toggle'),
  jumpBack: $('jumpBack'),
  jumpFwd: $('jumpFwd'),
  goLive: $('goLive'),
  tick: $('tick'),
  readout: $('readout'),
  track: $('track'),
  segs: $('segs'),
  playhead: $('playhead'),
  liveline: $('liveline'),
  evictedBand: $('evictedBand'),
  rangeLabel: $('rangeLabel'),
  evictedLabel: $('evictedLabel'),
  scaleStart: $('scaleStart'),
  scaleEnd: $('scaleEnd'),
  seek: $('seek'),
  seekLabel: $('seekLabel'),
  seqInput: $('seqInput'),
  seqGo: $('seqGo'),
  seqResult: $('seqResult'),
  freshness: $('freshness'),
  mode: $('mode'),
  clock: $('clock'),
  nowTime: $('nowTime'),
  nowDate: $('nowDate'),
  kvFresh: $('kvFresh'),
  kvRange: $('kvRange'),
  kvPlayhead: $('kvPlayhead'),
  kvSegment: $('kvSegment'),
  kvFrame: $('kvFrame'),
  kvPdt: $('kvPdt'),
  kvEpoch: $('kvEpoch'),
  kvBuffer: $('kvBuffer'),
  kvIndex: $('kvIndex'),
  kvHold: $('kvHold'),
  log: $('log'),
};

const player = (window.__player = new WindowPlayer(el.video, {
  onStatus: () => renderStatus(),
}));

let snapshot = null;
let indexStats = null;
let lastWindow = { start: null, end: null };
let segments = [];
let seeking = false;

function log(message, kind = '') {
  const at = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${at}</span> <span class="${kind}">${escapeHtml(message)}</span>`;
  el.log.prepend(line);
  while (el.log.childElementCount > 90) el.log.lastElementChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtClock(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${sign}${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
}

function fmtDate(ms) {
  if (!ms) return 'no date declared';
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

async function poll() {
  try {
    const response = await fetch('/api/window', { cache: 'no-store' });
    if (!response.ok) throw new Error(`window HTTP ${response.status}`);
    snapshot = await response.json();
    segments = snapshot.window.segments;
    player.setWindowSegments(segments);
    lastWindow = { start: snapshot.window.start, end: snapshot.window.end };
    renderWindow();
    await player.syncWindow(snapshot);
    renderStatus();
    // Real index/hold counters straight from the kernel; refreshed less often
    // than the window since they are diagnostic, not playback data.
    const statsResponse = await fetch('/api/index-stats', { cache: 'no-store' });
    if (statsResponse.ok) {
      indexStats = await statsResponse.json();
      renderIndexStats();
    }
  } catch (error) {
    log(`window poll failed: ${error.message}`, 'bad');
  }
}

function renderIndexStats() {
  if (!indexStats) return;
  el.kvIndex.textContent =
    `live ${indexStats.liveSegments} · tombstones ${indexStats.tombstoneRecords} · ` +
    `evicted ${indexStats.evictedRecords}/${indexStats.evictedTotal} · ` +
    `lookups ${indexStats.resolvePlayback.calls} (binary ${indexStats.resolvePlayback.binarySearchSteps})`;
  if (indexStats.hold) {
    el.kvHold.textContent = indexStats.hold.fresh
      ? `pinned @ ${indexStats.hold.position.toFixed(2)}s (age ${indexStats.hold.ageMs}ms)`
      : `stale @ ${indexStats.hold.position.toFixed(2)}s — edge will roll`;
  } else {
    el.kvHold.textContent = 'none (following live)';
  }
}

let lastFreshKey = '';
function renderStatus() {
  const status = player.status();
  el.readout.textContent = `t=${status.currentTime.toFixed(2)}s  win=${lastWindow.start?.toFixed(1) ?? '-'}→${lastWindow.end?.toFixed(1) ?? '-'}`;
  el.toggle.textContent = status.playing ? 'Pause' : 'Play';
  el.goLive.classList.toggle('active', status.followLive);
  el.mode.textContent = status.followLive ? 'LIVE EDGE' : 'REPLAY';
  el.mode.className = `badge ${status.followLive ? 'live' : 'replay'}`;
  el.kvPlayhead.textContent = `${status.currentTime.toFixed(2)} s`;
  const bufferText = status.ranges.map((r) => `${r.start}–${r.end}`).join(', ') || 'empty';
  el.kvBuffer.textContent = bufferText;
  renderPlayhead();
  if (!snapshot) return;
  const fresh = snapshot.freshness;
  const key = `${fresh.fresh}|${fresh.lastError?.message ?? ''}|${fresh.lastConfirmedAt}`;
  if (key !== lastFreshKey) {
    lastFreshKey = key;
    if (!fresh.fresh) {
      el.freshness.textContent = fresh.lastError
        ? `STALE · last confirmed ${fresh.lastConfirmedAt ? new Date(fresh.lastConfirmedAt).toISOString().slice(11, 19) : 'never'}`
        : 'stale';
      el.freshness.className = 'pill stale';
      log(`manifest stale — keeping last confirmed range (${fresh.lastError?.message ?? 'no fetch'})`, 'warn');
    } else {
      el.freshness.textContent = `FRESH · ${fresh.staleSeconds?.toFixed(2) ?? '?'}s ago`;
      el.freshness.className = 'pill fresh';
    }
  }
  el.kvFresh.textContent = fresh.fresh
    ? `${fresh.staleSeconds.toFixed(2)} s since confirmation`
    : `stale (last confirmed ${fresh.lastConfirmedAt ? new Date(fresh.lastConfirmedAt).toISOString().slice(11, 19) : 'never'})`;
  const current = segments.find(
    (s) => status.currentTime >= s.playbackStart && status.currentTime < s.playbackEnd,
  );
  if (current) {
    el.kvSegment.textContent = `seq ${current.sequence} · ${current.playbackStart.toFixed(1)}–${current.playbackEnd.toFixed(1)}s`;
    el.kvFrame.textContent = current.frameRange
      ? `${current.frameRange.first}–${current.frameRange.last}`
      : '—';
    el.kvPdt.textContent = current.declaredPdt
      ? `${new Date(current.declaredPdt).toISOString().slice(11, 23)} (source-declared)`
      : 'none';
    el.nowDate.textContent = current.declaredPdt
      ? `${fmtDate(current.declaredPdt)} (declared, not derived${current.epoch > 0 ? ', post-reset' : ''})`
      : 'no date declared';
  } else {
    el.kvSegment.textContent = status.currentTime < (lastWindow.start ?? 0) ? 'evicted / outside window' : '—';
    el.kvFrame.textContent = '—';
    el.kvPdt.textContent = '—';
    el.nowDate.textContent = 'outside window';
  }
  el.nowTime.textContent = fmtClock(status.currentTime);
  el.clock.textContent = new Date().toISOString().slice(11, 19);
}

function renderWindow() {
  if (!snapshot || snapshot.window.start === null) {
    el.rangeLabel.textContent = 'available —';
    el.segs.innerHTML = '';
    return;
  }
  const { start, end } = snapshot.window;
  const span = Math.max(0.001, end - start);
  el.rangeLabel.textContent = `available ${start.toFixed(2)} → ${end.toFixed(2)} s  (${span.toFixed(1)}s, ${segments.length} segments)`;
  el.scaleStart.textContent = `${start.toFixed(1)}s`;
  el.scaleEnd.textContent = `${end.toFixed(1)}s`;

  const evicted = snapshot.evictedRanges ?? [];
  if (evicted.length > 0) {
    const oldestStart = Math.min(...evicted.map((e) => e.playbackStart));
    const width = Math.max(0, Math.min(100, ((start - oldestStart) / span) * 100));
    el.evictedBand.style.display = width > 0.2 ? 'block' : 'none';
    el.evictedBand.style.left = '0%';
    el.evictedBand.style.width = `${width}%`;
    el.evictedLabel.textContent = `${evicted.length} evicted (${oldestStart.toFixed(1)}–${start.toFixed(1)}s) — replay there is refused`;
    el.evictedLabel.style.color = 'var(--bad)';
  } else {
    el.evictedBand.style.display = 'none';
    el.evictedLabel.textContent = 'no evictions yet';
    el.evictedLabel.style.color = 'var(--muted)';
  }

  el.segs.innerHTML = '';
  for (const segment of segments) {
    const left = ((segment.playbackStart - start) / span) * 100;
    const width = ((segment.playbackEnd - segment.playbackStart) / span) * 100;
    const bar = document.createElement('div');
    bar.className = 'ava' + (segment.gap ? ' evictedout' : '');
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(width, 0.4)}%`;
    bar.title = `sequence ${segment.sequence} · playback ${segment.playbackStart.toFixed(3)}–${segment.playbackEnd.toFixed(3)} · frames ${segment.frameRange?.first ?? '?'}–${segment.frameRange?.last ?? '?'}`;
    if (width > 2.5) {
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = segment.gap ? 'gap' : `s${segment.sequence}`;
      bar.appendChild(lbl);
    }
    if (segment.discontinuity) {
      bar.style.borderLeft = '3px solid var(--warn)';
    }
    el.segs.appendChild(bar);
  }

  el.liveline.style.display = 'block';
  el.liveline.style.left = '100%';
  void 0;

  el.kvRange.textContent = `${start.toFixed(2)} → ${end.toFixed(2)} s`;
  el.kvEpoch.textContent = `epoch ${snapshot.epoch} · ${snapshot.window.runs.length} run(s)`;
  el.seek.min = String(start);
  el.seek.max = String(Math.max(start + 0.1, end - 0.05));
  el.seek.step = '0.05';
  if (!seeking) el.seek.value = String(Math.min(Math.max(player.currentTime, start), end - 0.05));
  el.seekLabel.textContent = `${player.currentTime.toFixed(2)} s`;
}

function renderPlayhead() {
  if (!snapshot || snapshot.window.start === null) return;
  const { start, end } = snapshot.window;
  const span = Math.max(0.001, end - start);
  const t = player.currentTime;
  const pct = Math.min(100, Math.max(0, ((t - start) / span) * 100));
  el.playhead.style.left = `${pct}%`;
  el.seekLabel.textContent = `${t.toFixed(2)} s`;
}

el.toggle.addEventListener('click', () => {
  if (el.video.paused) player.play().catch(() => {}); else player.pause();
});
el.jumpBack.addEventListener('click', () => {
  player.setFollowLive(false);
  player.seek(player.currentTime - 10).catch(() => {});
});
el.jumpFwd.addEventListener('click', () => {
  player.setFollowLive(false);
  player.seek(player.currentTime + 10).catch(() => {});
});
el.goLive.addEventListener('click', () => {
  player.setFollowLive(!player.status().followLive);
});
el.tick.addEventListener('click', async () => {
  el.tick.disabled = true;
  try {
    await fetch('/api/scenario/advance?n=1', { cache: 'no-store' });
    await poll();
  } finally {
    el.tick.disabled = false;
  }
});
el.seek.addEventListener('input', () => {
  seeking = true;
  el.seekLabel.textContent = `${Number(el.seek.value).toFixed(2)} s`;
});
el.seek.addEventListener('change', async () => {
  seeking = false;
  const t = Number(el.seek.value);
  player.setFollowLive(false);
  await player.seek(t);
  await player.ensureBufferedAround(t);
  el.seekLabel.textContent = `${t.toFixed(2)} s`;
});
el.seqGo.addEventListener('click', async () => {
  const sequence = Number(el.seqInput.value);
  if (!Number.isInteger(sequence)) return;
  try {
    const response = await fetch(`/api/sequence/${sequence}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) {
      el.seqResult.textContent = `${body.code}: ${body.relocatedTo !== null ? `relocated to ${body.relocatedTo?.toFixed(2)}s` : 'no relocation available'}`;
      el.seqResult.style.color = 'var(--bad)';
      log(`sequence ${sequence} → ${body.code}: ${body.message}`, 'warn');
      if (body.relocatedTo !== null && body.relocatedTo !== undefined) {
        player.setFollowLive(false);
        await player.seek(body.relocatedTo);
      }
      return;
    }
    el.seqResult.textContent = `available at ${body.playbackStart.toFixed(2)}s`;
    el.seqResult.style.color = 'var(--accent)';
    player.setFollowLive(false);
    await player.seek(body.playbackStart);
  } catch (error) {
    el.seqResult.textContent = error.message;
    el.seqResult.style.color = 'var(--bad)';
  }
});

player.addEventListener('relocated', (event) => {
  log(`relocated: requested ${event.detail.requested?.toFixed?.(2)}s → ${event.detail.relocatedTo?.toFixed?.(2)}s (${event.detail.reason})`, 'warn');
});
player.addEventListener('evicted', (event) => {
  log(`segment ${event.detail.sequence} was evicted; kernel says move to ${event.detail.relocatedTo}`, 'warn');
});
player.addEventListener('error', (event) => {
  log(`player error: ${event.detail.message}`, 'bad');
});
player.addEventListener('playing', () => log('playing', 'ok'));
player.addEventListener('buffering', () => log('buffering…'));
player.addEventListener('segmentLoaded', (event) => {
  log(`appended seq ${event.detail.sequence} at playback ${event.detail.playbackStart.toFixed(2)}s`, 'ok');
});

// Expose a small hook for automated checks: the current picture's frame
// barcode, the kernel window, and the real playback position.
window.__replayProbe = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(el.video, 0, 0, 640, 360);
  const data = ctx.getImageData(0, 0, 640, 360).data;
  let value = 0;
  for (let module = 0; module < 32; module++) {
    const x = 20 + module * 14 + 7;
    const o = (320 * 640 + x) * 4;
    value = value * 2 + (data[o] > 128 ? 0 : 1);
  }
  const bits = [];
  for (let module = 0; module < 40; module++) {
    const x = 20 + module * 14 + 7;
    const o = (320 * 640 + x) * 4;
    bits.push(data[o] > 128 ? 0 : 1);
  }
  return {
    frameId: value >>> 0,
    status: player.status(),
    snapshot,
    currentSegmentId: segments.find(
      (s) => player.currentTime >= s.playbackStart && player.currentTime < s.playbackEnd,
    )?.sequence ?? null,
  };
};

poll();
setInterval(poll, 400);
setInterval(renderStatus, 150);

// UI binding. Renders the kernel snapshot exported by the player: available
// window, actual playhead, three clocks, freshness, and a timeline that marks
// evicted ranges rather than pretending old content is still reachable.

const $ = (id) => document.getElementById(id);

const FRESH_LABEL = {
  live: '清单新鲜 · 直播推进中',
  unconfirmed: '本次更新未确认 · 保留最后确认范围',
  stale: '清单已过期 · 非实时',
  stalled: '清单不再推进 · 边缘已冻结',
  'no-window': '尚未获得可用窗口',
};

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function fmtRel(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sec = ms / 1000;
  const sign = sec < 0 ? '−' : '+';
  const abs = Math.abs(sec);
  if (abs >= 3600) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    return `${sign}${h}:${pad(m)}:${s.toFixed(2).padStart(5, '0')}`;
  }
  if (abs >= 60) {
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  return `${sign}${abs.toFixed(2)}s`;
}

function fmtUtcDate(ms) {
  if (ms == null || !Number.isFinite(ms)) return '未声明';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}

function fmtClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function setRows(dl, rows) {
  dl.replaceChildren(
    ...rows.flatMap(([k, v, cls]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (cls) dd.className = cls;
      return [dt, dd];
    }),
  );
}

let latest = null;
let pinnedRange = null;
let userHoldingSeek = false;

function freshnessClass(state) {
  return state === 'live' ? 'live' : state === 'unconfirmed' ? 'unconfirmed' : state === 'stalled' ? 'stalled' : 'stale';
}

function render(snap) {
  latest = snap;
  const boot = $('bootError');
  if (snap.bootError) {
    boot.hidden = false;
    boot.textContent = snap.bootError;
    return;
  }
  boot.hidden = true;

  const fresh = snap.freshness?.state ?? 'no-window';
  const freshEl = $('freshness');
  freshEl.textContent = FRESH_LABEL[fresh] ?? fresh;
  freshEl.className = `badge ${freshnessClass(fresh)}`;

  const modeEl = $('modeBadge');
  modeEl.textContent = snap.mode === 'live' ? '跟随直播' : '回看中';
  modeEl.className = `badge mode ${snap.mode === 'live' ? '' : 'stale'}`;

  if (!snap.hasWindow) {
    $('rangeText').textContent = '—';
    $('seekLabel').textContent = '—';
    renderEvents(snap.events ?? []);
    return;
  }

  const w = snap.window;
  const ph = snap.playhead;
  $('rangeText').textContent = `窗口 ${fmtRel(w.startMs)} … ${fmtRel(w.endMs)}（${(w.durationMs / 1000).toFixed(1)}s，${snap.segmentsInWindow} 段）`;
  $('seekLabel').textContent = `${fmtRel(ph.mediaMs)} · ${ph.inWindow ? '窗口内' : ph.locatedStatus}`;

  renderTimeline(snap);
  renderSource(snap);
  renderPlayhead(snap);
  renderClocks(snap);
  renderEvents(snap.events ?? []);

  if (!userHoldingSeek) {
    const range = $('seekRange');
    const span = Math.max(1, w.durationMs);
    range.value = String(Math.round(((ph.mediaMs - w.startMs) / span) * 1000));
  }
}

function renderTimeline(snap) {
  const w = snap.window;
  const span = Math.max(1, w.durationMs);
  // Show a little context before the window so evicted content is visible.
  const contextMs = Math.max(12_000, span * 0.4);
  const t0 = w.startMs - contextMs;
  const t1 = w.endMs;
  const total = Math.max(1, t1 - t0);
  const pct = (t) => ((t - t0) / total) * 100;

  const bar = $('windowBar');
  bar.style.left = `${pct(w.startMs)}%`;
  bar.style.width = `${Math.max(1, pct(w.endMs) - pct(w.startMs))}%`;

  const head = $('playhead');
  const headPct = Math.min(100, Math.max(0, pct(snap.playhead.mediaMs)));
  head.style.left = `calc(${headPct}% - 1px)`;
  head.style.display = snap.playhead.inWindow ? 'block' : 'none';

  const edge = $('liveEdge');
  edge.style.left = `calc(${pct(w.endMs)}% - 1px)`;
  edge.style.background = snap.freshness.liveEdgeIsCurrent ? 'var(--live)' : 'var(--warn)';

  const marks = $('evictedMarks');
  marks.replaceChildren();
  const history = snap.evicted ?? [];
  for (const h of history.slice(-40)) {
    const start = Math.max(h.startMs, t0);
    const end = Math.min(h.endMs, t1);
    if (end <= start) continue;
    const div = document.createElement('div');
    div.className = 'evicted-mark';
    div.style.left = `${pct(start)}%`;
    div.style.width = `${Math.max(0.4, pct(end) - pct(start))}%`;
    div.title = `${h.reason} ${fmtRel(h.startMs)}…${fmtRel(h.endMs)}`;
    marks.append(div);
  }
}

function renderSource(snap) {
  const s = snap.source;
  const f = snap.freshness;
  setRows($('sourceInfo'), [
    ['清单 URL', s.url ?? '—'],
    ['媒体序号范围', `${snap.relation.minMsn} … ${snap.relation.maxMsn}`],
    ['关系 / 纪元', `${snap.relation.id} · epoch ${snap.relation.epoch}`],
    ['序号重置次数', String(snap.relation.resetCount)],
    ['目标时长', `${s.targetDurationSec ?? '—'}s`],
    ['帧率', `${s.frameRate ?? '—'} fps`],
    ['最后成功', fmtClock(f.lastSuccessAtMs)],
    ['内容推进', f.lastContentAdvanceAtMs ? fmtClock(f.lastContentAdvanceAtMs) : '—'],
    ['清单龄期', f.ageMs == null ? '—' : `${(f.ageMs / 1000).toFixed(1)}s`],
    ['连续失败', String(f.consecutiveFailures)],
  ]);

  const detail = $('freshnessDetail');
  if (f.state === 'live') {
    detail.textContent = '清单按目标时长持续更新，最后确认边缘可作为直播边缘。';
  } else if (f.state === 'unconfirmed') {
    detail.textContent = `最近一次获取失败（${f.error ?? '未知'}）。保留 ${fmtRel(snap.window.startMs)}…${fmtRel(snap.window.endMs)} 的最后确认范围，但不把它当作仍在持续直播。`;
  } else if (f.state === 'stalled') {
    detail.textContent = `清单仍可获取，但内容已 ${(f.contentAgeMs / 1000).toFixed(1)}s 未推进（阈值 ${(f.stallAfterMs / 1000).toFixed(1)}s）。最后确认边缘已冻结，不是实时直播边缘。`;
  } else {
    detail.textContent = `清单最后一次确认于 ${(f.ageMs / 1000).toFixed(1)}s 前，超过 ${(f.staleAfterMs / 1000).toFixed(1)}s 新鲜度预算。窗口仅作历史范围展示。`;
  }
}

function renderPlayhead(snap) {
  const ph = snap.playhead;
  const known = ph.segment;
  setRows($('playheadInfo'), [
    ['媒体时间', fmtRel(ph.mediaMs)],
    ['相对最后边缘', fmtRel(ph.relativeToEdgeMs)],
    ['窗口状态', ph.inWindow ? '可播放' : ph.locatedStatus],
    ['片段序号', known ? String(known.msn) : '—'],
    ['片段文件', known ? known.uri : '—'],
    ['片段媒体区间', known ? `${fmtRel(known.startMs)} … ${fmtRel(known.endMs)}` : '—'],
    ['已声明源时间', known?.declaredStartText ?? (known?.declaredStartMs != null ? fmtUtcDate(known.declaredStartMs) : '未声明')],
    ['播放编码纪元', known ? String(known.epoch) : '—'],
    ['当前帧号(预期)', ph.expectedFrame == null ? '—' : String(ph.expectedFrame)],
    ['缓冲区间', snap.buffer.startMs == null ? '—' : `${fmtRel(snap.buffer.startMs)} … ${fmtRel(snap.buffer.endMs)}`],
    ['已取片段 / 拒绝', `${snap.fetchStats.segments} / ${snap.fetchStats.refused}`],
    ['取片失败', String(snap.fetchStats.failures)],
  ]);

  const fc = snap.frameCheck;
  const el = $('frameResult');
  if (fc?.decodedFrame == null) {
    el.textContent = fc?.atMs ? '当前帧无法解码校验条码（可能尚未开始播放）' : '尚未采样';
    el.className = 'mono';
  } else if (fc.ok === true) {
    el.textContent = `画面帧 ${fc.decodedFrame} = 预期 ${fc.expectedFrame} ✓`;
    el.className = 'mono good';
  } else if (fc.ok === false) {
    el.textContent = `画面帧 ${fc.decodedFrame} ≠ 预期 ${fc.expectedFrame}`;
    el.className = 'mono bad';
  } else {
    el.textContent = `画面帧 ${fc.decodedFrame}（无预期可比）`;
    el.className = 'mono';
  }
}

function renderClocks(snap) {
  const ph = snap.playhead;
  const seg = ph.segment;
  const f = snap.freshness;
  const rows = [
    ['① 媒体序号', seg ? `msn ${seg.msn}` : '—'],
    ['② 播放时间', `${fmtRel(ph.mediaMs)}（由 EXTINF 时长累加，关系内稳定）`],
    ['③ 源声明日期', seg?.declaredStartText ?? (seg?.declaredStartMs != null ? fmtUtcDate(seg.declaredStartMs) : '该段未声明')],
  ];
  const issues = snap.issues ?? [];
  const drift = issues.filter((i) => i.code === 'declared-date-media-drift');
  const gaps = issues.filter((i) => i.code === 'segment-gap');
  const declaredGaps = issues.filter((i) => i.code === 'declared-gap');
  const dups = issues.filter((i) => i.code === 'duplicate-media-sequence');
  if (drift.length) rows.push(['日期/时长偏差', `${drift.length} 处，最近 ${drift[drift.length - 1].driftMs}ms（分别报告，不混合）`]);
  if (gaps.length) rows.push(['缺片断点', gaps.map((g) => `msn ${g.beforeMsn} 前缺 ${g.missing.join(',')}`).join('；')]);
  if (declaredGaps.length) rows.push(['源声明不可用', declaredGaps.map((g) => `msn ${g.msn}`).join(',')]);
  if (dups.length) rows.push(['重复序号', dups.map((d) => d.msn).join(',')]);
  if (f.state !== 'live') rows.push(['窗口新鲜度', `${f.state}（边缘${f.liveEdgeIsCurrent ? '当前' : '非当前'}）`]);
  setRows($('clocksInfo'), rows);
}

function eventClass(type) {
  if (['seek-refused', 'manifest-failed', 'manifest-unconfirmed', 'video-error', 'relation-reset'].includes(type)) return 'bad';
  if (['seek-relocated', 'stale', 'live-edge-frozen', 'playhead-evicted', 'sourcebuffer-error'].includes(type)) return 'warn';
  if (['follow-live', 'buffer-cleared', 'manifest-recovered'].includes(type)) return 'good';
  return '';
}

function renderEvents(events) {
  const ul = $('events');
  ul.replaceChildren(
    ...events.slice().reverse().map((e) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = fmtClock(e.atMs).slice(0, 8);
      const msg = document.createElement('span');
      msg.className = eventClass(e.type);
      msg.textContent = `${e.type} · ${e.message}`;
      li.append(t, msg);
      return li;
    }),
  );
}

// Seek slider maps to the current window, so the user cannot ask for content
// outside what is actually available.
$('seekRange').addEventListener('pointerdown', () => { userHoldingSeek = true; });
$('seekRange').addEventListener('pointerup', () => { userHoldingSeek = false; });
$('seekRange').addEventListener('change', async (ev) => {
  const snap = latest;
  if (!snap?.hasWindow) return;
  const w = snap.window;
  const frac = Number(ev.target.value) / 1000;
  const target = w.startMs + frac * w.durationMs;
  const decision = await window.__seek?.(target);
  if (decision && !decision.ok) {
    $('seekLabel').textContent = `已拒绝：${decision.reason}`;
  }
});

$('back10').addEventListener('click', () => window.__seekBack?.(10));
$('back30').addEventListener('click', () => window.__seekBack?.(30));
$('live').addEventListener('click', () => window.__jumpLive?.());
$('verifyFrame').addEventListener('click', () => {
  const check = window.__sampleFrame?.();
  if (check) render(latest);
});

window.__onPlayerUpdate = (snap) => render(snap);
window.__onPlayerEvent = () => {
  if (latest) render(latest);
};

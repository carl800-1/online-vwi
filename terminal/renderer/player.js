'use strict';
/* 终端播放器：只管"把文件放出来"，不碰网络、不碰磁盘。
 *
 * 三条硬约束，代码结构都是为它们让路的：
 *   1. 不许黑屏闪白（A2）—— 双缓冲：新内容先加载进隐藏层，加载完才换可见层
 *   2. 不许半新半旧（A9）—— 换队列是一次同步调用，中间没有 await
 *   3. 换完才能删旧文件（A8）—— 旧层的 src 在这一刻清空，主进程收到 ack 才动手删
 */
const $ = (id) => document.getElementById(id);

const LAYERS = [
  { box: $('layerA'), img: $('layerA').querySelector('img'), video: $('layerA').querySelector('video') },
  { box: $('layerB'), img: $('layerB').querySelector('img'), video: $('layerB').querySelector('video') }
];

const S = {
  queue: [],
  idx: 0,
  active: 0,
  token: 0,
  timer: null,
  modelCode: '',
  modelId: '',
  op: '',
  snap: null,
  appliedKey: ''
};

const PRELOAD_TIMEOUT = 4000;

// ───────────────────────── 适配与心跳 ─────────────────────────

function fit() {
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 1024);
  const el = $('screen');
  el.style.transform = `scale(${s})`;
  // 居中：屏不是 5:4 时两边留黑，不要拉伸变形
  el.style.left = Math.max(0, (window.innerWidth - 1280 * s) / 2) + 'px';
  el.style.top = Math.max(0, (window.innerHeight - 1024 * s) / 2) + 'px';
}

// 看门狗靠这个时间戳判断页面是不是卡死了（主进程每 10 秒读一次）
setInterval(() => { window.__vwiBeat = Date.now(); }, 1000);
window.__vwiBeat = Date.now();

// ───────────────────────── 媒体层 ─────────────────────────

function setSrcReady(L, item) {
  if (item.kind === 'video') {
    L.img.hidden = true;
    L.video.hidden = false;
    const v = L.video;
    v.onloadeddata = null;
    v.onerror = null;
    v.onended = null;
    if (v.getAttribute('src') !== item.url) v.src = item.url;
  } else {
    L.video.hidden = true;
    L.img.hidden = false;
    if (L.img.getAttribute('src') !== item.url) L.img.src = item.url;
  }
}

/** 预载到指定层，返回是否成功（失败也照样翻，不能因为一张图卡住整条线） */
function preload(li, item) {
  const L = LAYERS[li];
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (item.kind === 'video') { L.video.onloadeddata = null; L.video.onerror = null; }
      else { L.img.onload = null; L.img.onerror = null; }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), PRELOAD_TIMEOUT);

    if (item.kind === 'video') {
      const v = L.video;
      L.img.hidden = true;
      L.video.hidden = false;
      v.onloadeddata = () => done(true);
      v.onerror = () => done(false);
      if (v.getAttribute('src') !== item.url) v.src = item.url;
      else done(true);
      v.load();
    } else {
      const img = L.img;
      L.video.hidden = true;
      L.img.hidden = false;
      img.onload = () => done(true);
      img.onerror = () => done(false);
      if (img.getAttribute('src') === item.url) done(img.complete && img.naturalWidth > 0);
      else img.src = item.url;
    }
  });
}

/** 彻底放开一层：清 src、停解码、卸事件。旧文件的句柄在这一步才真正放掉。 */
function clearLayer(li) {
  const L = LAYERS[li];
  const img = L.img;
  const v = L.video;

  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');

  v.onloadeddata = null;
  v.onerror = null;
  v.onended = null;
  try { v.pause(); } catch { /* ignore */ }
  v.removeAttribute('src');
  try { v.load(); } catch { /* ignore */ }   // load() 才会真正释放文件句柄

  img.hidden = true;
  v.hidden = true;
}

// ───────────────────────── 播放 ─────────────────────────

function startPlaying(li, item) {
  clearTimeout(S.timer);
  S.timer = null;
  const L = LAYERS[li];

  if (item.kind === 'video') {
    L.img.hidden = true;
    L.video.hidden = false;
    const v = L.video;
    v.onended = () => { v.onended = null; advance(); };
    v.onerror = () => {
      v.onerror = null;
      log('warn', `视频播放失败，跳过：${item.name}`);
      setTimeout(advance, 400);
    };
    try { v.currentTime = 0; } catch { /* 有些容器不支持 seek，忽略 */ }
    const p = v.play();
    if (p && p.catch) {
      p.catch((e) => {
        log('warn', `play() 被拒：${e.message}`);
        setTimeout(advance, 1200);
      });
    }
  } else {
    L.video.hidden = true;
    L.img.hidden = false;
    const dwell = Math.max(2, Number(item.dwellSec) || 10) * 1000;
    S.timer = setTimeout(advance, dwell);
  }
}

function advance() {
  const n = S.queue.length;
  if (!n) return;

  if (n === 1) {
    // 只有一项：图片重新计时，视频从头再播（不能靠 goto，否则会清掉自己）
    const it = S.queue[0];
    const L = LAYERS[S.active];
    if (it.kind === 'video') {
      try { L.video.currentTime = 0; } catch { /* ignore */ }
      const p = L.video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      clearTimeout(S.timer);
      S.timer = setTimeout(advance, Math.max(2, it.dwellSec || 10) * 1000);
    }
    return;
  }

  goto((S.idx + 1) % n);
}

async function goto(i) {
  const item = S.queue[i];
  if (!item) return;
  const target = 1 - S.active;
  const myToken = ++S.token;

  await preload(target, item);
  if (myToken !== S.token) return;      // 期间换了整个队列，这一跳作废

  const old = S.active;
  S.active = target;
  S.idx = i;

  LAYERS.forEach((L, k) => L.box.classList.toggle('on', k === target));
  startPlaying(target, item);
  clearLayer(old);                      // 画面已经翻过去，旧层的句柄现在放掉
  updateChrome();
}

/**
 * 换整套内容。
 * 只有这里会接受"新队列"，并且 swap 是同步的 —— 队列和画面永远一起变，不存在半新半旧。
 */
async function applyView(view) {
  const items = (view.items || []).filter((it) => it && it.url);
  const key = (view.modelId || '') + '|' + items.map((it) => it.url).join(',');
  if (key && key === S.appliedKey && S.queue.length) {
    ack(view.id, true);                 // 同一套内容重复下发（快照与推送撞车），不必重翻
    return;
  }

  if (!items.length) {
    // 空清单：绝不翻成黑屏。保持旧画面，只让状态条去告警。
    const hadContent = S.queue.length > 0;
    if (!hadContent) {
      S.modelCode = view.modelCode || S.modelCode;
      S.modelId = view.modelId || S.modelId;
      renderWait();
    }
    S.appliedKey = key;
    ack(view.id, true);
    return;
  }

  const target = 1 - S.active;
  const myToken = ++S.token;
  await preload(target, items[0]);
  if (myToken !== S.token) { ack(view.id, true); return; }

  // ── 以下全部同步 ──
  const old = S.active;
  S.active = target;
  S.queue = items;
  S.idx = 0;
  S.modelCode = view.modelCode || '';
  S.modelId = view.modelId || '';
  S.appliedKey = key;

  LAYERS.forEach((L, k) => L.box.classList.toggle('on', k === target));
  $('wait').hidden = true;
  startPlaying(target, items[0]);
  clearLayer(old);
  updateChrome();

  ack(view.id, true);
}

function ack(id, ok, error) {
  if (!id || !window.vwi) return;
  window.vwi.flipped({ id, ok, error: error || '' });
}

// ───────────────────────── 界面 ─────────────────────────

function updateChrome() {
  $('mCode').textContent = S.modelCode || '——';
  const n = S.queue.length;
  $('cur').textContent = n ? S.idx + 1 : 0;
  $('total').textContent = n;
  refreshDots();
}

function refreshDots() {
  const dots = $('dots');
  const n = S.queue.length;
  if (n > 0 && n <= 12) {
    if (dots.children.length !== n) {
      dots.textContent = '';
      for (let i = 0; i < n; i++) dots.appendChild(document.createElement('i'));
    }
    for (let i = 0; i < n; i++) dots.children[i].className = i === S.idx ? 'on' : '';
  } else {
    dots.textContent = '';
  }
}

function renderStatus(snap) {
  if (!snap) return;
  S.snap = snap;
  S.op = snap.op || S.op;
  if (snap.modelCode && !S.modelCode) S.modelCode = snap.modelCode;

  const st = snap.status;
  const right = $('right');
  const text = $('stateText');

  right.className = 'right';
  document.body.classList.toggle('stale', st === 'stale');

  const hasContent = S.queue.length > 0;
  const hint = $('hint');
  const hintText = $('hintText');

  if (st === 'stale') {
    text.textContent = '内容未就绪 · 请勿作业';
    hint.hidden = true;
  } else if (st === 'preparing') {
    right.className = 'right warn';
    text.textContent = `准备中 ${snap.done}/${snap.total}`;
    // 有画面时只挂角标，不动画面（画面照旧播旧内容）
    hint.hidden = !hasContent;
    hint.className = 'blue';
    hintText.textContent = `正在切换到 ${snap.pendingCode || '新型号'} · ${snap.done}/${snap.total}　准备完成后整屏切换`;
  } else if (st === 'offline') {
    right.className = 'right off';
    text.textContent = '离线';
    hint.hidden = true;
  } else if (st === 'incomplete') {
    right.className = 'right warn';
    text.textContent = `内容不全 ${snap.done || S.queue.length} 项`;
    // 屏上还有内容时才挂角标；屏是空的，中央那张等待页已经把话说完了，不必重复
    hint.hidden = !hasContent;
    hint.className = 'warn';
    hintText.textContent = '该型号本工序内容不全，请联系工程部补齐';
  } else if (st === 'no-model') {
    right.className = 'right off';
    text.textContent = '等待型号';
    hint.hidden = true;
  } else if (st === 'boot') {
    right.className = 'right off';
    text.textContent = '启动中';
    hint.hidden = true;
  } else {
    text.textContent = '在线';
    hint.hidden = true;
  }

  $('pCode').textContent = (snap.op || '') ;
  if (snap.modelCode) $('mCode').textContent = snap.modelCode;
  renderWait();
}

/** 只在"屏上什么都没有"时出现，且永远不是纯黑 */
function renderWait() {
  const w = $('wait');
  if (S.queue.length > 0) { w.hidden = true; return; }
  w.hidden = false;

  const st = S.snap?.status || 'boot';
  const title = $('waitTitle');
  const txt = $('waitText');
  const bar = $('waitBar');
  const wh = $('waitHint');

  if (st === 'preparing') {
    title.textContent = '正在获取内容';
    txt.textContent = `${S.snap.pendingCode || S.modelCode || ''}　${S.snap.done}/${S.snap.total}`;
    const pct = S.snap.total ? Math.round((S.snap.done / S.snap.total) * 100) : 8;
    bar.style.width = Math.max(6, pct) + '%';
    wh.textContent = '首次启动需要把作业指导书存到本机，之后换型只需几秒';
  } else if (st === 'offline') {
    title.textContent = '离线 · 本地无内容';
    txt.textContent = '网络恢复后会自动开始播放';
    bar.style.width = '0%';
    wh.textContent = '画面保持在这一页，不会黑屏';
  } else if (st === 'incomplete') {
    title.textContent = '该型号本工序暂无作业指导书';
    txt.textContent = `${S.snap?.modelCode || S.modelCode} · ${S.snap?.op || S.op}`;
    bar.style.width = '0%';
    wh.textContent = '工程部配置内容后，本屏会自动开始播放，不需要人操作';
  } else if (st === 'no-model') {
    title.textContent = '等待服务器指定型号';
    txt.textContent = '班长在服务器上选择型号后，本屏自动开始播放';
    bar.style.width = '0%';
    wh.textContent = '';
  } else {
    title.textContent = '正在获取内容';
    txt.textContent = '正在连接服务器…';
    bar.style.width = '8%';
    wh.textContent = '';
  }
}

function hideWait() {
  $('wait').hidden = true;
}

// ───────────────────────── 时钟 ─────────────────────────

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const el = $('clock');
  if (el) el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function log(level, msg) {
  if (window.vwi) window.vwi.log(level, msg);
  else console[level === 'error' ? 'error' : 'log']('[player]', msg);
}

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  fit();
  setInterval(fit, 2000);            // 换屏/改分辨率后自动重新适配
  setInterval(tickClock, 1000);
  tickClock();

  if (!window.vwi) {
    // 用浏览器直接打开这个文件时的兜底提示（正常不会走到）
    $('waitTitle').textContent = '请从终端程序启动';
    $('waitText').textContent = '这个页面是接收端 exe 的内部界面';
    return;
  }

  window.vwi.onView(applyView);
  window.vwi.onStatus(renderStatus);

  try {
    const snap = await window.vwi.snapshot();
    if (snap.status) renderStatus(snap.status);
    if (snap.view && snap.view.items && snap.view.items.length) {
      applyView({ id: 0, ...snap.view });
    } else {
      renderWait();
    }
  } catch (e) {
    log('error', '初始化失败：' + e.message);
    renderWait();
  }
}

boot();

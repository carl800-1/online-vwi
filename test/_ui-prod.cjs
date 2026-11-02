// 生产概况 / 生产输入的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8095 electron test/_ui-prod.cjs
//
// ⚠️ 必须从外面先起好服务（VWI_UI_BASE 指过去），别在这里用 process.execPath
// 去 spawn —— Electron 里它指向 electron.exe，spawn 出去会开一个永不退出的窗口。
//
// 现场按这次要验的样子铺：一条线一天分三段做三个型号（小批量来回换型），
// 另一条线标「不开线」——作业内容页的生产概况里只该出现第一条。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8095';
const OUT = path.join(ROOT, 'docs');
const PNG_INPUT = path.join(OUT, 'ui-4.2.2-prod-multiseg.png');
const PNG_CLOSED = path.join(OUT, 'ui-4.2.2-prod-board.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + '\n');

// 本机系统代理会把 127.0.0.1 也劫持走（502），必须显式关代理；
// 再关掉 GPU —— 沙箱里没有显示设备，走硬件加速会直接起不来。
app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

const api = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});
const put = (p, body) => api(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

/** 铺一份"一线三段在跑 + 另一条今天不开线"的现场 */
async function seed() {
  const models = (await api('/api/models')).d.models || [];
  const find = (c) => models.find((m) => m.code === c);
  const x200 = find('X200');
  const x210 = find('X210');
  const x220 = find('X220');
  await put('/api/models/' + x200.id, { stdRate: 120 });
  await put('/api/models/' + x210.id, { stdRate: 100 });
  await put('/api/models/' + x220.id, { stdRate: 60 });

  const board = (await api('/api/board')).d;
  const l1 = board.lines[0];
  await post('/api/board/current', { lineId: l1.id, modelCode: 'X220' });

  // 第二条线：已有就复用，没有就建。今天没排产 —— 正好验「不开线」
  let l2 = board.lines.find((x) => x.code === 'T2');
  if (!l2) {
    l2 = (await post('/api/lines', { code: 'T2', name: '二线', slots: 5, status: 'running' })).d;
  } else if (l2.status !== 'running') {
    await put('/api/lines/' + l2.id, { status: 'running' });
  }
  await post('/api/board/current', { lineId: l2.id, modelCode: 'X210' });

  // 一线三段：4h−20min（3.67h×120=440）、2h−5min（1.92h×100=192）、1h（×60=60）
  await post('/api/prod/input', {
    rows: [
      { lineId: l1.id, modelId: x200.id, shiftHours: 4, planQty: 500, doneQty: 420, hourQty: 100, downMin: 20 },
      { lineId: l1.id, modelId: x210.id, shiftHours: 2, planQty: 200, doneQty: 185, hourQty: 40, downMin: 5 },
      { lineId: l1.id, modelId: x220.id, shiftHours: 1, planQty: 60, doneQty: 45, hourQty: 20, downMin: 0 },
      { lineId: l2.id, isOpen: false }
    ]
  });
  return { l1, l2 };
}

app.whenReady().then(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(BASE + '/api/status')).ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }

  const { l1, l2 } = await seed();

  const win = new BrowserWindow({ width: 1440, height: 1180, show: false });
  const errs = [];
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    const level = (e && e.level) || '';
    if ((level === 'error' || level === 2 || level === 'warning') && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  await win.loadURL(BASE);
  await sleep(2400);
  const js = (s) => win.webContents.executeJavaScript(s, true);
  const out = {};

  // ---------- 1) 生产概况：不开线的那条不该出现 ----------
  out.board = await js(`(() => {
    const txt = (sel) => [...document.querySelectorAll(sel)].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
    return {
      sub: (document.getElementById('pSub') || {}).textContent,
      kpis: txt('#pBody .pkpi'),
      live: txt('#pBody .pg-line'),
      models: txt('#pBody .pg-mdl'),
      kvs: txt('#pBody .p-kv'),
      segTitle: (document.querySelector('#pBody .pg-mdl-sec') || {}).textContent
    };
  })()`);

  // ---------- 2) 生产输入：三段 + 一条不开线 ----------
  await js(`document.querySelector('.nav-item[data-view="prod"]').click()`);
  await sleep(1700);

  const readInput = () => js(`(() => {
    const wrap = document.querySelector('#view-prod .pt-wrap');
    const rows = [...document.querySelectorAll('#piTable tbody tr[data-g]')].map((tr) => {
      const ln = tr.querySelector('.pt-ln');
      return {
        g: Number(tr.dataset.g), s: Number(tr.dataset.s),
        isSeg: tr.classList.contains('pt-seg'),
        off: tr.getAttribute('data-off') === '1',
        line: ln ? ln.innerText.replace(/\\s+/g, ' ').trim() : null,
        rowspan: ln ? ln.rowSpan : null,
        model: tr.querySelector('.pt-sel').selectedOptions[0].textContent.trim(),
        vals: [...tr.querySelectorAll('.pt-in')].map((i) => i.value),
        disabled: tr.querySelector('.pt-in').disabled,
        rate: tr.querySelector('.pt-rate').innerText.replace(/\\s+/g, ' ').trim()
      };
    });
    const card = document.querySelector('#view-prod > .card');
    const cb = card.getBoundingClientRect();
    return {
      ths: [...document.querySelectorAll('#view-prod .pt th')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
      rows,
      foot: (document.getElementById('piTfoot') || {}).innerText.replace(/\\s+/g, ' ').trim(),
      calc: (document.getElementById('piCalc') || {}).innerText.replace(/\\s+/g, ' ').trim(),
      saved: (document.getElementById('piSaved') || {}).textContent,
      sub: (document.getElementById('piSub') || {}).textContent,
      cardLeft: Math.round(cb.left), cardWidth: Math.round(cb.width),
      overflow: wrap ? wrap.scrollWidth - wrap.clientWidth : -1,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);

  out.input = await readInput();

  // 组索引不写死：现场可能还有别的 running 线（补空行）混在表里，
  // 靠线体编码定位才稳
  const groupOf = (code) => js(`(() => {
    const td = [...document.querySelectorAll('#piTable td.pt-ln')]
      .find((t) => ((t.querySelector('b') || {}).textContent || '').trim() === ${JSON.stringify(code)});
    return td ? Number(td.closest('tr').dataset.g) : -1;
  })()`);
  const g1 = await groupOf(l1.code);
  const g2 = await groupOf(l2.code);
  out.groups = { l1: l1.code, g1, l2: l2.code, g2 };

  fs.mkdirSync(OUT, { recursive: true });
  await win.webContents.capturePage();
  await sleep(420);
  fs.writeFileSync(PNG_INPUT, (await win.webContents.capturePage()).toPNG());
  out.pngInput = PNG_INPUT;

  // ---------- 3) 改一段的累计产量：那一段的效率当场变 ----------
  const rateBefore = await js(`document.querySelector('#piTable tbody tr[data-g="${g1}"][data-s="0"] .pt-rate b').textContent.trim()`);
  await js(`(() => {
    const el = document.querySelector('#piTable tbody tr[data-g="${g1}"][data-s="1"] input[data-f="doneQty"]');
    el.value = '192';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  out.rateLive = {
    seg1Before: rateBefore,
    seg2After: await js(`document.querySelector('#piTable tbody tr[data-g="${g1}"][data-s="1"] .pt-rate b').textContent.trim()`),
    foot: await js(`document.getElementById('piTfoot').innerText.replace(/\\s+/g,' ').trim()`)
  };

  // ---------- 4) 「+ 型号」：跟在 ✕ 后面，点第 2 段就插在第 2 段之后 ----------
  const before = (await readInput()).rows.filter((r) => r.g === g1).map((r) => r.model);
  await js(`document.querySelector('#piTable tbody tr[data-g="${g1}"][data-s="1"] .pt-addseg').click()`);
  await sleep(600);
  const grew = await readInput();
  const g1rows = grew.rows.filter((r) => r.g === g1);
  out.addSeg = {
    rowCount: grew.rows.length,
    segs: g1rows.length,
    rowspan: g1rows[0].rowspan,
    modelsBefore: before,
    modelsAfter: g1rows.map((r) => r.model),
    insertedAt: g1rows.findIndex((r, i) => r.model !== before[i]),
    sub: grew.sub
  };

  // ---------- 5) 「不开线」→ 再开回来（内存里切，界面立刻变） ----------
  await js(`document.querySelector('#piTable tbody tr[data-g="${g2}"] .pt-open').click()`);
  await sleep(600);
  const reopened = await readInput();
  const g2rows = reopened.rows.filter((r) => r.g === g2);
  out.toggleOpen = {
    l2Disabled: g2rows.map((r) => r.disabled),
    l2Rate: g2rows.map((r) => r.rate),
    openLabel: await js(`document.querySelector('#piTable tbody tr[data-g="${g2}"] .pt-open').textContent.trim()`),
    foot: reopened.foot
  };
  // 再点回去（保持"不开线"，并存库）
  await js(`document.querySelector('#piTable tbody tr[data-g="${g2}"] .pt-open').click()`);
  await sleep(500);

  // ---------- 6) 保存 → 生产概况跟着变 ----------
  await js(`document.getElementById('piSave').click()`);
  await sleep(1800);
  out.savedAfter = await js(`document.getElementById('piSaved').textContent`);

  await js(`document.querySelector('.nav-item[data-view="board"]').click()`);
  await sleep(1500);
  out.boardAfterSave = await js(`(() => {
    const txt = (sel) => [...document.querySelectorAll(sel)].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
    return { sub: (document.getElementById('pSub') || {}).textContent, live: txt('#pBody .pg-line'), kvs: txt('#pBody .p-kv') };
  })()`);

  fs.mkdirSync(OUT, { recursive: true });
  await win.webContents.capturePage();
  await sleep(420);
  fs.writeFileSync(PNG_CLOSED, (await win.webContents.capturePage()).toPNG());
  out.pngBoard = PNG_CLOSED;

  // ---------- 7) 「去录入」跳到独立页 ----------
  await js(`document.getElementById('pInputBtn').click()`);
  await sleep(1500);
  out.gotoInput = await js(`(() => {
    const act = document.querySelector('.nav-item.active');
    return {
      tab: act ? act.dataset.view : null,
      prodVisible: !document.getElementById('view-prod').classList.contains('hide'),
      rowCount: document.querySelectorAll('#piTable tbody tr[data-g]').length
    };
  })()`);

  out.errors = errs;
  log(JSON.stringify(out, null, 2));
  app.exit(0);
}).catch((e) => { log('UI 检查失败：' + ((e && e.stack) || e)); app.exit(1); });

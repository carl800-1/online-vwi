// 工时列 + 全量导出对话框的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8095 electron test/_ui-cfg.cjs
//
// ⚠️ 必须从外面先起好服务（VWI_UI_BASE 指过去），别在这里 spawn 服务 ——
// Electron 里 process.execPath 是 electron.exe，会开一个永不退出的窗口。
//
// 验四件事（4.3.0）：
//   1) 机种设置工序表多了一列「工时」，可编辑、数字右对齐
//   2) 工时填了之后，副标题冒出「工时合计 / 瓶颈」
//   3) 媒体库那道工序的卡片里也有同一格（data-f="cycleSec"）
//   4) 线体设置「导出 Excel」的对话框给的是「全量五页」而不是旧的四列
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8095';
const PNG = path.join(ROOT, 'docs', 'ui-4.3.0-models-time.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(BASE + '/api/status')).ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }

  const win = new BrowserWindow({ width: 1440, height: 1100, show: false });
  const errs = [];
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    const level = (e && e.level) || '';
    if ((level === 'error' || level === 2) && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  await win.loadURL(BASE);
  await sleep(2200);
  const js = (s) => win.webContents.executeJavaScript(s, true);
  const out = { errors: errs };

  // ---------- 1) 机种设置：工序表多一列工时 ----------
  await js(`document.querySelector('.nav-item[data-view="models"]').click()`);
  await sleep(1200);
  // 没选机种时表是空的，点第一个机种
  await js(`(() => { const b = document.querySelector('.md-item, .md-chip, [data-md]'); if (b) b.click(); })()`);
  await sleep(1500);

  out.models = await js(`(() => {
    const th = [...document.querySelectorAll('.st-table thead th')].map((x) => x.innerText.trim());
    const rows = [...document.querySelectorAll('#stTbody tr[data-row]')];
    const first = rows[0];
    const inp = first && first.querySelector('input[data-f="cycleSec"]');
    return {
      th, colCount: th.length,
      rowCount: rows.length,
      hasTimeInput: !!inp,
      inputValue: inp ? inp.value : null,
      numClass: inp ? inp.className : null,
      sub: (document.getElementById('stTableSub') || {}).innerText
    };
  })()`);

  // 填一个工时，副标题应该冒出「工时合计 / 瓶颈」
  await js(`(() => {
    const el = document.querySelector('#stTbody input[data-f="cycleSec"]');
    if (!el) return;
    el.value = '8.5';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(1200);
  out.afterTime = await js(`(() => {
    const el = document.querySelector('#stTbody input[data-f="cycleSec"]');
    return { sub: (document.getElementById('stTableSub') || {}).innerText, value: el ? el.value : null };
  })()`);

  // 拍照（隐藏窗口要先空捕一次，否则拿到上一帧）
  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());

  // ---------- 2) 媒体库：同一格也在 ----------
  await js(`document.querySelector('.nav-item[data-view="media"]').click()`);
  await sleep(1600);
  out.media = await js(`(() => {
    const inp = document.querySelector('#stations input[data-f="cycleSec"]');
    const lbl = [...document.querySelectorAll('#stations .st-lbl')].map((x) => x.innerText.trim());
    return { hasTimeInput: !!inp, value: inp ? inp.value : null, labels: lbl };
  })()`);

  // ---------- 3) 线体设置：导出对话框 ----------
  await js(`document.querySelector('.nav-item[data-view="lines"]').click()`);
  await sleep(1200);
  await js(`document.getElementById('lnExportBtn').click()`);
  await sleep(900);
  out.exportDlg = await js(`(() => {
    const sel = document.getElementById('lnExpWhat');
    const tip = document.querySelector('#dialog .tip');
    return {
      open: !!document.querySelector('#dialog:not(.hide)'),
      options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
      tip: tip ? tip.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : ''
    };
  })()`);
  // 关掉对话框，别真触发下载
  await js(`(() => { const b = document.querySelector('#dialog .dlg-cancel, #dialog [data-act="cancel"]'); if (b) b.click(); })()`);
  await sleep(400);

  out.errors = errs;
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  win.destroy();
  app.quit();
});

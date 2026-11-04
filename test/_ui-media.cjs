// 媒体库卡片显示「文件在盘上的位置」的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8103 electron test/_ui-media.cjs
//
// ⚠️ 服务要在外面先起好（这里不 spawn，Electron 的 process.execPath 是 electron.exe）。
// 验三件事（4.4.0）：
//   1) 卡片多一行灰色等宽路径（rel_path），老文件显示「（老文件，未归档）」
//   2) PDF 原件显示「PDF 原件」，不再错标成「PDF 页」
//   3) 页面没有 console 报错
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8103';
const PNG = path.join(ROOT, 'docs', 'ui-4.4.0-media-paths.png');

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

  // 「文件查询」才是全库列表（媒体库那页是按工序配内容），卡片就在 #mediagrid
  await js(`document.querySelector('.nav-item[data-view="files"]').click()`);
  await sleep(2000);

  const out = await js(`(() => {
    const cards = [...document.querySelectorAll('#mediagrid .mediacard')];
    const paths = cards.map((c) => (c.querySelector('.s.path') || {}).innerText || '');
    const labels = [...new Set(cards.map((c) => (c.querySelector('.thumb') || {}).innerText || ''))]
      .filter(Boolean);
    return {
      cards: cards.length,
      paths: paths.slice(0, 6),
      withPath: paths.filter((p) => p && p.indexOf('未归档') < 0).length,
      legacy: paths.filter((p) => p.indexOf('未归档') >= 0).length,
      labels,
      gridText: (document.getElementById('mediaTxt') || {}).textContent
    };
  })()`);
  out.errors = errs;

  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());

  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  win.destroy();
  app.quit();
});

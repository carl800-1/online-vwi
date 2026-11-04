// 媒体库里「播放方式 / 播放内容」那一行的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8108 electron test/_ui-playkinds.cjs
//
// ⚠️ 服务要在外面先起好（Electron 的 process.execPath 是 electron.exe，起不了 node 服务）。
// 验四件事（4.5.0）：
//   1) 工序卡上「播放内容」按钮显示当前勾选（三类全勾显示「全部」）
//   2) 点开是三项复选框，勾选状态和库里一致
//   3) 没勾的那一类内容会标「不放」
//   4) 页面没有 console 报错
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8108';
const PNG = path.join(ROOT, 'docs', 'ui-4.5.0-play-kinds.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(BASE + '/api/status')).ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }

  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const errs = [];
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    const level = (e && e.level) || '';
    if ((level === 'error' || level === 2) && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  await win.loadURL(BASE);
  await sleep(2000);
  const js = (s) => win.webContents.executeJavaScript(s, true);

  // 进「媒体库」→ 选机种 → 点第一道工序
  await js(`document.querySelector('.nav-item[data-view="media"]').click()`);
  await sleep(1200);
  await js(`(() => {
    const sel = document.getElementById('mlModelPick');
    if (!sel || !sel.options.length) return 'no-model';
    if (!sel.value) { sel.selectedIndex = 0; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return sel.value;
  })()`);
  await sleep(1600);
  await js(`(() => {
    const it = document.querySelector('#stList [data-spick]');
    if (it) it.click();
    return !!it;
  })()`);
  await sleep(1200);

  // 点开「播放内容」下拉
  const before = await js(`(() => {
    const btn = document.querySelector('[data-kddbtn]');
    return btn ? { text: (btn.querySelector('.kdd-txt') || {}).textContent || '', hasPop: !!btn.parentElement.querySelector('.kdd-pop') } : null;
  })()`);
  await js(`(() => { const b = document.querySelector('[data-kddbtn]'); if (b) b.click(); })()`);
  await sleep(400);

  const open = await js(`(() => {
    const pop = document.querySelector('.kdd-pop');
    const box = pop && pop.getBoundingClientRect();
    const cs = pop ? getComputedStyle(pop) : {};
    const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + 8) : null;
    const opts = [...document.querySelectorAll('.kdd-opt')].map((l) => ({
      label: (l.innerText || '').trim(),
      checked: !!l.querySelector('input').checked
    }));
    const offTags = [...document.querySelectorAll('.sitem .offtag')].length;
    const items = [...document.querySelectorAll('.sitem')].map((x) => (x.querySelector('.sm') || {}).innerText || '');
    return {
      visible: !!pop && !pop.classList.contains('hide'),
      rect: box ? { w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top) } : null,
      paint: { bg: cs.backgroundColor, z: cs.zIndex, pos: cs.position },
      onTop: hit ? (hit.className || hit.tagName) : '',
      opts,
      offTags,
      items
    };
  })()`);

  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());

  process.stdout.write(JSON.stringify({ before, open, errors: errs }, null, 1) + '\n');
  win.destroy();
  app.quit();
});

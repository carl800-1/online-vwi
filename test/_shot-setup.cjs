// 给「终端设置页」截图：证明线体/工序两块藏在「检测」之后，并量出内容总高度。
// 只读，不改任何配置（mock preload 的 saveConfig 是空的）。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'docs');
const BASE = process.env.SETUP_SHOT_SERVER || 'http://127.0.0.1:8114';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  await win.webContents.capturePage();       // 隐藏窗口先空捕一次，否则拿到的是上一帧
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  const s = img.getSize();
  console.log('  截图', name, s.width + 'x' + s.height);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 760, height: 620, show: false, frame: true, resizable: false,
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: path.join(__dirname, '_shot-setup-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const js = (code) => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(__dirname, '..', 'terminal', 'renderer', 'setup.html'));
  await sleep(700);

  // ① 初始状态：圈出「检测」按钮
  const btn = await js(`(() => {
    const b = document.getElementById('probe');
    b.style.outline = '3px solid #e24b4a';
    b.style.outlineOffset = '2px';
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log('  检测按钮位置', JSON.stringify(btn));
  await sleep(300);
  await shot(win, 'setup-0-detect-btn.png');

  // ② 填地址 + 点检测
  await js(`(() => {
    const b = document.getElementById('probe');
    b.style.outline = '';
    document.getElementById('server').value = ${JSON.stringify(BASE)};
    b.click();
    return 'clicked';
  })()`);
  await sleep(2000);
  const after = await js(`(() => ({
    msg: (document.getElementById('probeMsg') || {}).innerText || '',
    linesShown: document.getElementById('lines').classList.contains('show'),
    lineCards: document.querySelectorAll('#linegrid .proc').length,
    procsShown: document.getElementById('procs').classList.contains('show'),
    saveDisabled: document.getElementById('save').disabled
  }))()`);
  console.log('  检测后', JSON.stringify(after));
  await shot(win, 'setup-1-probed.png');

  // ③ 选第一条线体 → 工序出来
  await js(`(() => {
    const b = document.querySelector('#linegrid .proc');
    if (b) b.click();
    return b ? b.dataset.code : 'none';
  })()`);
  await sleep(2000);
  const after2 = await js(`(() => ({
    procsShown: document.getElementById('procs').classList.contains('show'),
    procCards: document.querySelectorAll('#procgrid .proc').length,
    saveDisabled: document.getElementById('save').disabled,
    msg: (document.getElementById('probeMsg') || {}).innerText || ''
  }))()`);
  console.log('  选线体后', JSON.stringify(after2));
  await shot(win, 'setup-2-line-picked.png');

  // ④ 量高度：窗口内高 vs 内容总高
  const box = await js(`(() => ({
    inner: window.innerHeight,
    scroll: document.documentElement.scrollHeight,
    body: document.body.scrollHeight
  }))()`);
  console.log('  高度', JSON.stringify(box), '→ 需要滚动', box.scroll - box.inner, 'px');

  // ⑤ 拉高窗口截一张完整图（看清全貌 + 保存按钮的位置）
  win.setContentSize(760, Math.max(620, box.scroll + 40));
  await sleep(700);
  await shot(win, 'setup-3-full.png');

  console.log('完成');
  win.destroy();
  app.exit(0);
}).catch((e) => {
  console.error('失败', e && e.stack || e);
  app.exit(1);
});

// 给「终端设置页」截图（1.8.0：固定页脚 + 未检测占位 + 4 列工序 + 自报结果）。
// 只读，不改任何配置（mock preload 的 saveConfig 不落盘）。
//
// 用法：
//   SETUP_SHOT_SERVER=http://127.0.0.1:8116 node_modules/electron/dist/electron.exe test/_shot-setup.cjs
//   SETUP_SHOT_STATE=assigned ...   # 截图里的自报结果（pending / confirmed / assigned / conflict）
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'docs');
const BASE = process.env.SETUP_SHOT_SERVER || 'http://127.0.0.1:8114';
const STATE = process.env.SETUP_SHOT_STATE || 'pending';
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
    // 和 main.js 里 createSetupWindow() 的参数一致
    width: 820, height: 760, show: false, frame: true, resizable: true,
    minWidth: 640, minHeight: 520,
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

  // ① 初始状态：占位提示必须在
  const init = await js(`(() => {
    const b = document.getElementById('probe');
    b.style.outline = '3px solid #e24b4a';
    b.style.outlineOffset = '2px';
    const r = b.getBoundingClientRect();
    return {
      hint: getComputedStyle(document.getElementById('hintEmpty')).display !== 'none',
      linesShown: document.getElementById('lines').classList.contains('show'),
      footerVisible: document.getElementById('save').getBoundingClientRect().bottom <= window.innerHeight + 1,
      btn: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  })()`);
  console.log('  初始', JSON.stringify(init));
  await sleep(300);
  await shot(win, 'setup-1.8.0-a-empty.png');

  // ② 填地址 + 点检测
  await js(`(() => {
    const b = document.getElementById('probe');
    b.style.outline = '';
    document.getElementById('server').value = ${JSON.stringify(BASE)};
    b.click();
    return 'clicked';
  })()`);
  await sleep(2500);
  const after = await js(`(() => ({
    msg: (document.getElementById('probeMsg') || {}).innerText || '',
    hint: getComputedStyle(document.getElementById('hintEmpty')).display !== 'none',
    lineCards: document.querySelectorAll('#linegrid .proc').length,
    procsShown: document.getElementById('procs').classList.contains('show'),
    saveDisabled: document.getElementById('save').disabled,
    footerVisible: document.getElementById('save').getBoundingClientRect().bottom <= window.innerHeight + 1
  }))()`);
  console.log('  检测后', JSON.stringify(after));
  await shot(win, 'setup-1.8.0-b-probed.png');

  // ③ 选第一条线体 → 工序出现
  await js(`(() => {
    const b = document.querySelector('#linegrid .proc');
    if (b) b.click();
    return b ? b.dataset.code : 'none';
  })()`);
  await sleep(2500);
  const after2 = await js(`(() => ({
    procCards: document.querySelectorAll('#procgrid .proc').length,
    saveDisabled: document.getElementById('save').disabled,
    msg: (document.getElementById('probeMsg') || {}).innerText || ''
  }))()`);
  console.log('  选线体后', JSON.stringify(after2));
  await shot(win, 'setup-1.8.0-c-line.png');

  // ④ 选一道工序 + 保存 → 自报结果（不落盘，mock）
  await js(`(() => {
    const b = document.querySelectorAll('#procgrid .proc')[2];
    if (b) b.click();
    return true;
  })()`);
  await sleep(600);
  const box = await js(`(() => {
    const s = document.querySelector('.scroll');
    return {
      inner: window.innerHeight,
      scrollRegion: s.scrollHeight,
      regionHeight: s.clientHeight,
      overflow: s.scrollHeight - s.clientHeight,
      footerVisible: document.getElementById('save').getBoundingClientRect().bottom <= window.innerHeight + 1
    };
  })()`);
  console.log('  高度', JSON.stringify(box), '→ 中间区需滚动', box.overflow, 'px');

  await js(`document.getElementById('save').click()`);
  await sleep(1500);
  const after3 = await js(`(() => ({
    hello: (document.getElementById('helloMsg') || {}).innerText || '',
    saveText: document.getElementById('save').textContent
  }))()`);
  console.log('  保存后', JSON.stringify(after3), 'state=' + STATE);
  await shot(win, 'setup-1.8.0-d-saved.png');

  console.log('完成');
  win.destroy();
  app.exit(0);
}).catch((e) => {
  console.error('失败', e && e.stack || e);
  app.exit(1);
});

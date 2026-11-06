// 播放页「管理端改派」提示条截图。
// 不走真终端（那会占满整个屏幕），直接加载 player.html，再调一次 showAssign()。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    backgroundColor: '#0f1319',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'terminal', 'renderer', 'player.html'));
  await sleep(600);

  await win.webContents.executeJavaScript(
    `showAssign({ line: 'L1', op: 'OP30', fromLine: 'L2', fromOp: 'OP05' })`
  );
  await sleep(300);

  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-1.8.0-assign-notice.png'), img.toPNG());
  console.log('截图 ui-1.8.0-assign-notice.png', img.getSize().width + 'x' + img.getSize().height);

  const text = await win.webContents.executeJavaScript(
    `({ shown: !document.getElementById('assignNotice').hidden,
        text: document.getElementById('assignNotice').textContent })`
  );
  console.log('提示条', JSON.stringify(text));

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('失败', e && e.stack || e); app.exit(1); });

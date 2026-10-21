// GUI 探针：只回答一个问题——这台机器（或这个沙盒）能不能真的建出 Electron 窗口并渲出画面。
// 输出全部落到 probe-out/ 目录，不依赖控制台（GUI 进程在 Windows 上常常没有 stdout）。
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'probe-out');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'probe.log'), '');
const log = (s) => fs.appendFileSync(path.join(OUT, 'probe.log'), `${new Date().toISOString()} ${s}\n`);

process.on('uncaughtException', (e) => log('CRASH ' + (e.stack || e.message)));

log(`start pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node}`);
log(`RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || '(unset)'}`);

app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    log(`display ${d.size.width}x${d.size.height} scale=${d.scaleFactor} bounds=${JSON.stringify(d.bounds)}`);

    const win = new BrowserWindow({
      width: 900, height: 640, show: true, title: 'probe',
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    log('window created');

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <body style="margin:0;background:#0f1319;color:#e8eef7;font:600 34px/1.4 system-ui;display:grid;place-items:center;height:100vh">
        <div>Electron GUI 可用<br><span style="font-size:20px;opacity:.7">${new Date().toLocaleString('zh-CN')}</span></div>
      </body>`));
    log('page loaded');

    await new Promise((r) => setTimeout(r, 700));
    const img = await win.capturePage();
    const size = img.getSize();
    fs.writeFileSync(path.join(OUT, 'probe.png'), img.toPNG());
    log(`captured ${size.width}x${size.height} bytes=${fs.statSync(path.join(OUT, 'probe.png')).size}`);
    log('OK');
    app.exit(0);
  } catch (e) {
    log('ERROR ' + (e.stack || e.message));
    app.exit(2);
  }
});

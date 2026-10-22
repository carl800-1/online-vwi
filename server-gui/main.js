// ESOP 发布系统 · 服务端桌面程序主进程
//
// 这个文件的定位：把原来"双击 bat → 弹黑框 → 还要自己开浏览器"这套动作
// 收进一个窗口里。双击 exe → 服务起来 + 界面打开，全程不碰浏览器。
//
// 三条设计上的硬约定：
//  1. 服务逻辑不复制 —— 直接 import ../src/server-core.js，和 `node server.js`
//     跑的是同一份代码。所以升级服务端逻辑不用改这里，行为也绝不可能分叉。
//  2. 关窗口 ≠ 关服务 —— 点 X 只隐藏窗口，服务继续跑、终端照常连。
//     真退出只能从托盘右键菜单点。误关一次就断线的代价太大。
//  3. 一切异常都要看得见 —— 桌面程序没有控制台，出了事现场只能靠日志和
//     对话框。所以日志写 data\server.log（自动轮转），致命错误弹窗不静默退出。
// 两个坑叠在一起，都必须绕开：
//  1. `import { app } from 'electron'` —— Electron 的 electron 模块用 getter 逐个挂导出，
//     cjs-module-lexer 静态扫不到具名导出，直接具名导入会报
//     "does not provide an export named 'BrowserWindow'"。
//     即便写成 `import electron from 'electron'`，CJS→ESM 的 default 绑定也是**快照**，
//     在 Electron 还没填充导出对象的时机取出来会是 undefined。
//  2. BrowserWindow / ipcMain / Tray / dialog 这些要到 app ready 之后才挂上，
//     顶层解构出来必然是 undefined。
// 解法：用 createRequire 拿 CJS 的 require（CJS 是活对象，没有快照问题），
// 只提前取 app，其余等 whenReady 里再从同一个对象上取。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;
let BrowserWindow, Tray, Menu, dialog, shell, nativeImage, ipcMain;
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { listen, summary, lanAddresses, portFromArgv } from '../src/server-core.js';
import { int } from '../src/util.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEV = process.argv.includes('--dev') || !app.isPackaged;
// 开机自启拉起时不弹窗口：这是常驻服务，没人会坐在机器前等它开界面
const SILENT = process.argv.includes('--autostart');
const WANT_PORT = int(process.env.ESOP_PORT || process.env.VWI_PORT || portFromArgv() || 8092, 8092);
const LOG_MAX = 2 * 1024 * 1024;
const POLL_MS = 5000;

let win = null;
let tray = null;
let inst = null;          // 核心服务实例；null 表示端口上是别处已在跑的服务
let dataDir = '';
let logFile = '';
let port = WANT_PORT;
let closingHintShown = false;
let quitting = false;
let pollTimer = null;
let snap = { online: [], phase: '', model: '', items: 0, mediaCount: 0 };

// ───────────────────────── 日志 ─────────────────────────

function log(level, msg) {
  const line = new Date().toISOString() + '  ' + level + '  ' + msg;
  try {
    if (logFile) {
      let fresh = !fs.existsSync(logFile) || fs.statSync(logFile).size === 0;
      // 现场机器可能常年不关，日志无限长会把盘写满
      if (!fresh && fs.statSync(logFile).size > LOG_MAX) {
        fs.renameSync(logFile, logFile + '.1');
        fresh = true;
      }
      // 写 UTF-8 BOM：中文 Windows 的记事本默认按 ANSI 解码，没有 BOM 会整篇乱码。
      // 现场排障第一步就是双击这个日志，不能让它变成一堆方块。
      if (fresh) fs.writeFileSync(logFile, '\uFEFF', 'utf8');
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    }
  } catch { /* 日志本身写不进去也不能让程序挂掉 */ }
  if (level === 'ERROR') process.stderr.write(line + '\n');
}

function fatal(err, where) {
  const msg = (err && err.message) || String(err);
  log('ERROR', where + '：' + msg + '\n' + ((err && err.stack) || ''));
  try {
    dialog?.showErrorBox('ESOP 服务端 无法启动', (where ? where + '\n\n' : '') + msg +
      '\n\n如果日志里有更多信息，请把这个文件发给维护人员：\n' + (logFile || '(尚未确定数据目录)'));
  } catch { /* 连对话框都弹不出来就算了 */ }
  quitting = true;
  app.exit(1);
}

// ───────────────────────── 数据目录 ─────────────────────────

/**
 * 找一个真正能写的目录。
 * 优先 exe 同级（portable 包用 PORTABLE_EXECUTABLE_DIR），现场备份就是拷 data 文件夹；
 * 万一装到了没写权限的位置（Program Files / 只读桌面），退回用户数据目录。
 */
function resolveDataDir() {
  const cands = [];
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    cands.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
  }
  cands.push(path.join(app.getAppPath(), 'data'));
  cands.push(path.join(app.getPath('userData'), 'data'));

  const why = [];
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, '.write-probe');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return d;
    } catch (e) {
      why.push(d + ' 不可写（' + e.code + '）');
    }
  }
  throw new Error('找不到可用的数据目录，已尝试：\n  ' + why.join('\n  '));
}

// ───────────────────────── 端口协商 ─────────────────────────

function probeStatus(p, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/status', timeout }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          // phase + ts 是本服务状态接口独有的字段，用来确认不是别的程序恰好也在 8092
          resolve(j && j.phase && j.ts ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function isPortFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '0.0.0.0');
  });
}

function getJson(p, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: urlPath, timeout: 4000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
  });
}

/** 端口被陌生程序占了：让用户自己选，不能默默改端口（终端会连不上而且没人知道） */
async function askFreePort(taken) {
  const free = [];
  for (let p = taken + 1; p <= taken + 20 && free.length < 3; p++) {
    if (await isPortFree(p)) free.push(p);
  }
  if (!free.length) {
    await dialog.showErrorBox('ESOP 服务端 无法启动',
      '端口 ' + taken + ' 被占用，而且往后连查 20 个端口都被占用了。\n请先关掉占端口的程序再启动。');
    return null;
  }
  const labels = free.map((p) => '改用端口 ' + p);
  const res = await dialog.showMessageBox({
    type: 'error',
    title: '端口被占用',
    message: '端口 ' + taken + ' 已被其它程序占用，服务端起不来。',
    detail: '占用它的不是 ESOP 服务端。\n\n' +
      '可以改用一个空闲端口：' + free.join('、') + '\n\n' +
      '注意：改端口后，5 台终端的「服务端地址」必须同步改成新端口，否则全部连不上。\n' +
      '如果能腾出 ' + taken + '，保持原端口最省事。',
    buttons: [...labels, '取消启动'],
    defaultId: 0,
    cancelId: labels.length,
    noLink: true
  });
  return res.response < labels.length ? free[res.response] : null;
}

// ───────────────────────── 启动 ─────────────────────────

async function boot() {
  try {
    dataDir = resolveDataDir();
    logFile = path.join(dataDir, 'server.log');
    log('INFO', '启动 electron=' + process.versions.electron +
      ' node=' + process.versions.node + ' chromium=' + process.versions.chrome +
      ' packaged=' + app.isPackaged + ' 期望端口=' + WANT_PORT + ' 数据目录=' + dataDir);

    try {
      inst = await listen({ data: dataDir, port: WANT_PORT });
      port = inst.server.address().port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      const alive = await probeStatus(WANT_PORT);
      if (alive) {
        // 同一个服务的另一个进程还活着：它已经在服务了，本次只把界面接管过来
        inst = null;
        port = WANT_PORT;
        log('INFO', '端口 ' + WANT_PORT + ' 上已有本服务在运行，本次只接管管理界面');
      } else {
        const next = await askFreePort(WANT_PORT);
        if (next == null) { quitting = true; app.exit(0); return; }
        inst = await listen({ data: dataDir, port: next });
        port = inst.server.address().port;
        log('WARN ', '原端口 ' + WANT_PORT + ' 被占用，已改用 ' + port);
      }
    }

    const s = summary(inst || { data: dataDir });
    log('INFO', '服务已就绪 端口=' + port + ' 型号=' + s.models + ' 工序=' + s.processes +
      ' 清单项=' + s.items + ' 媒体=' + s.mediaCount + ' 个');
    if (inst && inst.seeded.created) {
      log('INFO', '首次运行，已生成 ' + inst.seeded.models + ' 个型号 × ' + inst.seeded.processes + ' 道工序（内容为空，等工程部填）');
    }

    createWindow();
    createTray();
    startPolling();
    refreshTray();
  } catch (err) {
    fatal(err, '启动服务端失败');
  }
}

// ───────────────────────── 窗口 ─────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'ESOP 服务端',
    icon: path.join(APP_DIR, 'assets', 'icon-256.png'),
    backgroundColor: '#eef1f6',   // 与 style.css 的 --bg 一致，避免加载瞬间白闪
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadURL('http://127.0.0.1:' + port + '/');

  win.once('ready-to-show', () => {
    if (!SILENT) win.show();
    else win.hide();
  });

  // 点 X = 收进托盘，服务继续跑。这是刻意设计，不是偷懒。
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!closingHintShown) {
      closingHintShown = true;
      tray?.displayBalloon({
        title: '服务仍在运行',
        content: '窗口已收进右下角托盘，5 台终端照常工作。\n双击托盘图标可以重新打开；真要退出请右键托盘图标。',
        iconType: 'info'
      });
    }
  });

  // 界面里点到外部链接（比如文档地址）交给系统浏览器，不要在管理界面里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ───────────────────────── 托盘 ─────────────────────────

function selfExePath() {
  // portable 包自解压到 %TEMP%，process.execPath 指向临时目录里的副本。
  // 用它注册开机自启，等于开机去找一个随时会被清掉的临时文件 —— 必须用用户手上那个原件。
  const p = process.env.PORTABLE_EXECUTABLE_FILE;
  if (p && fs.existsSync(p)) return p;
  return process.execPath;
}

function isAutoStartOn() {
  // 开发模式下 process.execPath 是 electron.exe，注册它等于开机跑一个没有 app 参数的
  // 空壳。宁可如实回答"关着"，也别往注册表里写这种脏东西。
  if (DEV) return false;
  try { return app.getLoginItemSettings({ path: selfExePath() }).openAtLogin; }
  catch { return false; }
}

function setAutoStartOn(on) {
  if (DEV) {
    log('WARN ', '开发模式不写开机自启（避免把 electron.exe 注册进开机项）');
    return false;
  }
  app.setLoginItemSettings({ openAtLogin: on, path: selfExePath(), args: ['--autostart'] });
  log('INFO', '开机自启 ' + (on ? '开启' : '关闭') + ' → ' + selfExePath());
  refreshTray();
  return true;
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function refreshTray() {
  if (!tray) return;
  const s = inst ? summary(inst) : null;
  const version = (s && s.version) || app.getVersion();
  const n = snap.online.length;
  const phaseCn = { idle: '空闲', preparing: '准备中', activating: '翻屏中', done: '已生效' }[snap.phase] || snap.phase || '—';

  tray.setToolTip('ESOP 服务端 v' + version + ' · 端口 ' + port + ' · 在线终端 ' + n);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ESOP 服务端 v' + version, enabled: false },
    { label: '服务运行中 · 端口 ' + port, enabled: false },
    { label: '在线终端 ' + n + ' 台' + (n ? '（' + snap.online.join('、') + '）' : ''), enabled: false },
    { label: '当前 ' + (snap.model || '未指定') + ' · ' + phaseCn, enabled: false },
    { type: 'separator' },
    { label: '显示管理界面', click: showWindow },
    { label: '打开数据目录', click: () => shell.openPath(dataDir) },
    { label: '打开日志文件', click: () => shell.showItemInFolder(logFile) },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: isAutoStartOn(), click: (mi) => setAutoStartOn(mi.checked) },
    { type: 'separator' },
    { label: '退出（会断开所有终端）', click: quitForReal }
  ]));
}

async function startPolling() {
  const tick = async () => {
    try {
      const st = await getJson(port, '/api/status');
      snap = {
        online: st.online || [],
        phase: st.phase || '',
        model: st.modelCode || '',
        items: st.items || 0,
        mediaCount: st.media?.count || 0
      };
      refreshTray();
      broadcast('vwi:state', snap);
    } catch { /* 轮询失败不打扰用户，托盘下次刷新 */ }
  };
  await tick();
  pollTimer = setInterval(tick, POLL_MS);
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ───────────────────────── 退出 ─────────────────────────

function quitForReal() {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  try { inst?.server.close(); } catch { /* 已经关了就算了 */ }
  log('INFO', '用户退出，服务停止');
  app.quit();
}

// ───────────────────────── 给界面的接口 ─────────────────────────

function registerIpc() {
  ipcMain.handle('vwi:info', () => ({
    isDesktop: true,
    version: inst ? summary(inst).version : app.getVersion(),
    port,
    dataDir,
    logFile,
    lan: lanAddresses().map((x) => ({ url: 'http://' + x.address + ':' + port, name: x.name })),
    packaged: app.isPackaged,
    dev: DEV,
    autoStart: isAutoStartOn(),
    exePath: selfExePath()
  }));

  ipcMain.handle('vwi:open-data', () => shell.openPath(dataDir));
  ipcMain.handle('vwi:open-log', () => shell.showItemInFolder(logFile));
  ipcMain.handle('vwi:auto-start', (_e, on) => { setAutoStartOn(!!on); return isAutoStartOn(); });
  ipcMain.handle('vwi:hide', () => win?.hide());
  ipcMain.handle('vwi:quit', () => quitForReal());
  ipcMain.handle('vwi:refresh-tray', () => { refreshTray(); return true; });
}

// ───────────────────────── 生命周期 ─────────────────────────

if (!app.requestSingleInstanceLock()) {
  // 已经有一个在跑了：把这个进程交出去就完事，别开第二个服务抢端口
  app.exit(0);
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // ready 之后这些才真的挂在 electron 导出对象上
    ({ BrowserWindow, Tray, Menu, dialog, shell, nativeImage, ipcMain } = electron);
    // 干掉 Electron 自带的英文菜单（File / Edit / View / Window / Help）。
    // 这是中文产线工具，误按 Alt 弹出一排英文菜单既没用又显得不像个正经程序；
    // 它提供的功能全部在界面「系统」面板和托盘里。开发模式保留，方便开 DevTools。
    if (!DEV) Menu.setApplicationMenu(null);
    registerIpc();
    await boot();
  }).catch((err) => fatal(err, '启动失败'));

  // macOS 习惯关窗口不退出，这里保持一致：真退出只认托盘菜单
  app.on('window-all-closed', () => { /* 故意留空，服务要常驻 */ });

  app.on('before-quit', () => {
    quitting = true;
    if (pollTimer) clearInterval(pollTimer);
    try { inst?.server.close(); } catch { /* 忽略 */ }
  });

  app.on('activate', () => showWindow());

  process.on('uncaughtException', (e) => {
    log('ERROR', '未捕获异常：' + (e && e.stack ? e.stack : e));
    try {
      dialog?.showErrorBox('ESOP 服务端 出错了',
        '发生了未处理的错误（服务可能还能用，但建议重启）。\n\n' +
        (e && e.message ? e.message : String(e)) + '\n\n日志：' + logFile);
    } catch { /* 忽略 */ }
  });

  process.on('unhandledRejection', (r) => {
    log('ERROR', '未处理的 Promise 拒绝：' + (r && r.stack ? r.stack : r));
  });
}
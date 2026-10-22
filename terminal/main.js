// 终端主进程：窗口、kiosk、看门狗、开机自启、托盘，以及唯一的文件/网络出口。
//
// 为什么网络和文件都放主进程：
//   exe 加载的是本地页面（file://），页面本身不能跨源 fetch 服务器；
//   断网时如果页面从 http 加载，连界面都起不来，A3/A4 直接不成立。
//   所以渲染层只管"显示"，进程只拿 IPC 送过来的一串 file:// 路径。
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./src/config');
const cache = require('./src/cache');
const net = require('./src/net');
const { Syncer } = require('./src/sync');

const DEV = process.argv.includes('--dev') || process.argv.includes('-d');

// 日志尽早接管：GUI 进程在 Windows 上不连控制台，出问题时只能靠这个文件。
installLogger();
process.on('uncaughtException', (e) => {
  console.error('[main] 未捕获异常：', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[main] 未处理的 Promise 拒绝：', e);
});

app.setAppUserModelId('com.frank.esop-client');

// userData 必须在抢单实例锁之前定下来：Electron 的锁文件就放在 userData 里。
// 顺序反了会出现两种毛病——缓存/lib 落到默认的 %APPDATA%\Electron，
// 以及用 ESOP_TERMINAL_ROOT 起测试实例时互相抢同一把锁、第二台直接退出。
config.ensureDirs();                                 // setPath 前先建好，避免首启找不到目录
app.setPath('userData', config.PATHS.root);          // %LOCALAPPDATA%\esop-client（1.7.0 起改名）

// 目录改名是有代价的动作，必须留痕：现场出"配置没了"时，先看这一行。
// 成功走 INFO，失败才走 ERR —— 成功记成错误会让排查方向上反。
const mig = config.MIGRATION;
if (mig.migrated) {
  console.log('[config] 配置目录已迁移（' + mig.how + '）：' + mig.legacy + ' -> ' + mig.root);
} else if (mig.error) {
  console.error('[config] 配置目录迁移失败，继续使用旧目录 ' + mig.root + '：' + mig.error);
}

// 单实例：双击第二次不再开一个窗口，而是把已有窗口顶出来
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // 防被判定为遮挡而降帧

let win = null;
let setupWin = null;
let tray = null;
let syncer = null;
let cfg = null;
let allowQuit = false;
let flipSeq = 0;
const pendingFlips = new Map();     // flipId -> resolve
let watchdogTimer = null;
let watchdogFails = 0;

// ───────────────────────── 日志 ─────────────────────────

function installLogger() {
  if (installLogger.done) return;          // 被调用两次会把 console 包两层，日志里每行都重复
  installLogger.done = true;
  config.ensureDirs();
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const write = (level, args) => {
    const line = `${new Date().toISOString()} [${level}] ` + args
      .map((a) => (typeof a === 'string' ? a : safeStr(a)))
      .join(' ');
    try {
      if (fs.existsSync(config.PATHS.log) && fs.statSync(config.PATHS.log).size > 5 * 1024 * 1024) {
        try { fs.renameSync(config.PATHS.log, config.PATHS.log + '.1'); } catch { /* ignore */ }
      }
      fs.appendFileSync(config.PATHS.log, line + '\n', 'utf8');
    } catch { /* 日志写不进去不能影响播放 */ }
  };
  console.log = (...a) => { write('INFO', a); if (DEV) orig.log(...a); };
  console.warn = (...a) => { write('WARN', a); if (DEV) orig.warn(...a); };
  console.error = (...a) => { write('ERR', a); if (DEV) orig.error(...a); };

  console.log(`[boot] pid=${process.pid} electron=${process.versions.electron || '?'} ` +
    `node=${process.versions.node} packaged=${app.isPackaged} argv=${process.argv.slice(1).join(' ')}`);
}

function safeStr(v) {
  try { return v instanceof Error ? v.stack || v.message : JSON.stringify(v); } catch { return String(v); }
}

// ───────────────────────── 窗口 ─────────────────────────

function baseWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    backgroundThrottling: false,       // 失焦后不降频，否则翻页会卡住
    devTools: DEV || Boolean(cfg?.allowDevTools)
  };
}

function harden(w) {
  // 车间里不该出现浏览器行为：不给右键菜单、不许开新窗口、不许离开本地页面
  w.webContents.on('context-menu', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;

    // 维护逃生门：Ctrl+Alt+Shift+Q 直接退出。
    // kiosk 下任务栏可能被盖住、托盘点不到，没有这个组合键就只能拔电源或进任务管理器。
    if (input.control && input.alt && input.shift && String(k).toLowerCase() === 'q') {
      e.preventDefault();
      console.log('[win] 收到维护退出快捷键');
      quit();
      return;
    }

    const block =
      k === 'F11' || k === 'F12' || k === 'F5' || k === 'F7' ||
      (input.control && ['r', 'w', 'n', 'p', 'o', 'u', '+', '-', '0'].some((x) => x === String(k).toLowerCase())) ||
      (input.control && input.shift && ['i', 'j', 'c'].includes(String(k).toLowerCase())) ||
      (input.alt && k === 'F4');
    if (block) e.preventDefault();
  });
  w.on('close', (e) => {
    if (!allowQuit) {
      e.preventDefault();        // 关不掉，只能从托盘退出
      console.log('[win] 拦截关闭请求（Alt+F4 / 系统关闭）');
    }
  });
}

function createPlayerWindow() {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    kiosk: !DEV && cfg.kiosk !== false,
    fullscreen: !DEV && cfg.kiosk !== false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1319',
    title: `ESOP 客户端 · ${cfg.line ? cfg.line + ' / ' : ''}${cfg.op}`,
    webPreferences: baseWebPreferences()
  });

  harden(win);
  // 置顶只在正式 kiosk 下开：开发调试时它会盖住 IDE 和任务栏
  if (!DEV && cfg.kiosk !== false) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'player.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (!DEV && cfg.kiosk !== false) win.setKiosk(true);
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[win] 播放页已加载');
    startSync();
  });

  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[win] 渲染进程异常退出：', d.reason);
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 800);
  });

  win.webContents.on('unresponsive', () => {
    console.warn('[win] 页面无响应，准备重载');
    if (win && !win.isDestroyed()) win.reload();
  });
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 760,
    height: 620,
    resizable: false,
    frame: true,
    backgroundColor: '#f6f8fb',
    title: 'ESOP 客户端 · 设置',
    webPreferences: baseWebPreferences()
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => {
    setupWin = null;
    // 配置还是不全就说明装机没完成，进程留着没有意义（也不会有人看到托盘）
    if (!config.isValid(cfg)) {
      console.log('[boot] 装机向导被关闭且配置不完整，退出');
      quit();
    } else if (win && !win.isDestroyed()) {
      win.show();
    }
  });
}

// ───────────────────────── 同步 ─────────────────────────

/**
 * 采集本机参数给管理端右栏用：分辨率 / 版本 / 磁盘剩余。
 * 分辨率取主显示器的**物理像素**（size × scaleFactor）——
 * 现场有 1080p 也有 4K 屏，只报逻辑像素会让人以为两台机器一样。
 */
function collectMeta() {
  let res = '';
  try {
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * (d.scaleFactor || 1));
    const h = Math.round(d.size.height * (d.scaleFactor || 1));
    res = `${w}x${h}`;
  } catch { /* 无图形环境（无头测试）就没有分辨率 */ }

  let free = 0;
  try {
    // statfs 在 Node 18.15+ 才有；老运行时降级为 0（界面显示"—"）
    const st = fs.statfsSync(cache.PATHS.root);
    free = Number(st.bavail) * Number(st.bsize);
  } catch { /* ignore */ }

  return { res, ver: app.getVersion(), free };
}

function startSync() {
  if (syncer) return;
  syncer = new Syncer({ line: cfg.line || '', op: cfg.op, server: cfg.server }, { flipHandler });
  syncer.setMeta(collectMeta());
  // 磁盘剩余会变，30 秒刷一次就够；分辨率不变但也一起刷，代码简单
  setInterval(() => syncer && syncer.setMeta(collectMeta()), 30_000).unref?.();

  // 主进程 → 渲染层：请求翻转，等渲染层确认后才算生效
  function flipHandler(view) {
    return new Promise((resolve, reject) => {
      if (!win || win.isDestroyed()) return reject(new Error('窗口不存在'));
      const id = ++flipSeq;
      pendingFlips.set(id, resolve);
      const payload = {
        id,
        modelCode: view.modelCode,
        modelId: view.modelId,
        reason: view.reason || 'switch',
        items: view.items.map((it) => ({
          url: it.url,
          kind: it.kind,
          dwellSec: it.dwellSec,
          // fit/zoom 必须显式透传：这里是白名单式拷贝，漏一个字段渲染层就永远收不到，
          // 表现为"清单里改了铺满/放大，屏上没反应"（排查过一轮）。
          fit: it.fit || 'contain',
          zoom: it.zoom || 100,
          name: it.name,
          mediaId: it.mediaId
        }))
      };
      win.webContents.send('vwi:view', payload);
      setTimeout(() => {
        if (pendingFlips.has(id)) {
          pendingFlips.delete(id);
          reject(new Error('渲染层未在 9 秒内确认'));
        }
      }, 9000);
    });
  }

  syncer.on('status', (snap) => {
    if (win && !win.isDestroyed()) win.webContents.send('vwi:status', snap);
    if (tray) refreshTrayMenu(snap);
  });

  syncer.start();
  startWatchdog();
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogFails = 0;
  watchdogTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const beat = await win.webContents.executeJavaScript('window.__vwiBeat || 0', true);
      const age = Date.now() - Number(beat || 0);
      // 页面每 1 秒打一次点；超过 30 秒没动说明 JS 卡死了
      if (!beat || age > 30_000) watchdogFails++;
      else watchdogFails = 0;
    } catch {
      watchdogFails++;                 // 执行失败通常意味着渲染进程已经卡死
    }
    if (watchdogFails >= 3) {
      console.warn(`[watchdog] 连续 ${watchdogFails} 次无心跳，重载页面`);
      watchdogFails = 0;
      if (win && !win.isDestroyed()) win.reload();
    }
  }, 10_000);
  watchdogTimer.unref?.();
}

// ───────────────────────── 托盘 ─────────────────────────

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip(`ESOP 客户端 · ${cfg.line ? cfg.line + ' / ' : ''}${cfg.op}`);
  console.log(`[tray] 托盘已创建${img.isEmpty() ? '（图标缺失，使用空图标）' : ''}`);
  refreshTrayMenu(syncer ? syncer.snapshot() : null);
  tray.on('double-click', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });
}

function refreshTrayMenu(snap) {
  if (!tray) return;
  const line = snap
    ? `${cfg.line ? cfg.line + ' / ' : ''}${cfg.op} · ${snap.modelCode || '—'}　${statusText(snap)}`
    : `${cfg.line ? cfg.line + ' / ' : ''}${cfg.op}　启动中`;
  tray.setToolTip('ESOP 客户端 · ' + line);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: line, enabled: false },
    { label: `服务器 ${cfg.server}`, enabled: false },
    { type: 'separator' },
    { label: '重新加载画面', click: () => win && !win.isDestroyed() && win.reload() },
    { label: '重新同步内容', click: () => { stopSync(); startSync(); } },
    { label: '打开内容目录', click: () => shell.openPath(cache.PATHS.current) },
    { label: '打开日志', click: () => shell.openPath(cache.PATHS.log) },
    { label: '更改设置…', click: openSetupFromTray },
    { type: 'separator' },
    { label: '退出', click: () => quit() }
  ]));
}

function statusText(s) {
  switch (s.status) {
    case 'play': return '播放中';
    case 'preparing': return `准备中 ${s.done}/${s.total}`;
    case 'offline': return '离线';
    case 'stale': return '内容未就绪';
    case 'incomplete': return '内容不全';
    case 'no-model': return '等待型号';
    default: return s.status;
  }
}

function stopSync() {
  if (syncer) { syncer.stop(); syncer.removeAllListeners(); syncer = null; }
}

function quit() {
  allowQuit = true;
  if (watchdogTimer) clearInterval(watchdogTimer);
  stopSync();
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
}

// ───────────────────────── 设置 ─────────────────────────

function openSetupFromTray() {
  if (setupWin) { setupWin.focus(); return; }
  stopSync();
  createSetupWindow();
  if (win && !win.isDestroyed()) win.hide();
}

// ───────────────────────── IPC ─────────────────────────

function registerIpc() {
  // 渲染层启动时问一次，避免错过第一条 vwi:view（主进程可能已经推过冷启动画面）
  ipcMain.handle('vwi:snapshot', () => ({
    line: cfg.line || '',
    op: cfg.op,
    kiosk: cfg.kiosk,
    dev: DEV,
    status: syncer ? syncer.snapshot() : null,
    view: syncer ? syncer.lastView : null
  }));

  // 渲染层翻完页，回报结果 —— 这是"可以删旧文件了"的唯一信号
  ipcMain.on('vwi:flipped', (_e, { id, ok, error }) => {
    const resolve = pendingFlips.get(id);
    if (!resolve) return;
    pendingFlips.delete(id);
    if (ok) resolve(true);
    else {
      console.warn('[flip] 渲染层翻转失败：', error);
      resolve(false);
    }
  });

  ipcMain.on('vwi:log', (_e, { level, msg }) => {
    if (level === 'error') console.error('[renderer]', msg);
    else if (level === 'warn') console.warn('[renderer]', msg);
    else console.log('[renderer]', msg);
  });

  // 装机向导：探服务器，拿线体与工序清单
  // 为什么要拿线体：一台屏属于「某条线的某道工序」，只报 op 在多线现场会串内容。
  ipcMain.handle('vwi:probe', async (_e, server) => {
    const s = String(server || '').trim().replace(/\/+$/, '');
    const url = /^https?:\/\//i.test(s) ? s : 'http://' + s;
    try {
      const [lines, st] = await Promise.all([
        net.getJson(url, '/api/lines', { timeoutMs: 8000 }),
        net.getJson(url, '/api/status', { timeoutMs: 8000 }).catch(() => null)
      ]);
      const list = lines.lines || [];
      const active = list.find((l) => l.enabled) || list[0] || null;
      const procs = active
        ? await net.getJson(url, '/api/processes?lineId=' + encodeURIComponent(active.id), { timeoutMs: 8000 })
        : { processes: [] };
      return {
        ok: true,
        server: url,
        lines: list.map((l) => ({
          id: l.id, code: l.code, name: l.name, enabled: !!l.enabled,
          processes: l.processes, coverage: l.coverage
        })),
        activeLineCode: active?.code || '',
        processes: procs.processes || [],
        version: st?.version || '',
        modelCode: st?.modelCode || ''
      };
    } catch (e) {
      return { ok: false, error: e.message, server: url };
    }
  });

  // 换了线体要重新取工序：不同线体的工序数、名字都可能不一样
  ipcMain.handle('vwi:line-processes', async (_e, { server, lineId }) => {
    try {
      const r = await net.getJson(server, '/api/processes?lineId=' + encodeURIComponent(lineId), { timeoutMs: 8000 });
      return { ok: true, processes: r.processes || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('vwi:save-config', (_e, input) => {
    const next = config.save(input);
    if (!config.isValid(next)) return { ok: false, error: '工序或服务器地址不完整' };
    cfg = next;
    applyAutoStart();
    console.log(`[config] 已保存 line=${cfg.line || '(跟随服务端)'} op=${cfg.op} server=${cfg.server}`);

    // 配置变了就重开播放窗口
    stopSync();
    if (setupWin) { setupWin.close(); setupWin = null; }
    if (win && !win.isDestroyed()) { win.destroy(); win = null; }
    createPlayerWindow();
    return { ok: true };
  });

  ipcMain.handle('vwi:open-content-dir', () => shell.openPath(cache.PATHS.current));
  ipcMain.handle('vwi:open-log', () => shell.openPath(cache.PATHS.log));
  ipcMain.handle('vwi:cache-stats', () => cache.stats());
  ipcMain.handle('vwi:quit', () => quit());
}

// ───────────────────────── 自启 ─────────────────────────

function applyAutoStart() {
  if (DEV) return;                       // 开发模式不写注册表，否则注册的是 electron.exe
  const on = cfg.autoStart !== false;
  try {
    app.setLoginItemSettings({
      openAtLogin: on,
      path: process.execPath,
      args: ['--autostart']
    });
    console.log(`[boot] 开机自启 ${on ? '已开启' : '已关闭'}`);
  } catch (e) {
    console.warn('[boot] 设置自启失败：', e.message);
  }
}

// ───────────────────────── 生命周期 ─────────────────────────

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

app.whenReady().then(() => {
  installLogger();
  cfg = config.load();
  console.log('──────── 终端启动 ────────');
  console.log(`line=${cfg.line || '(跟随服务端)'} op=${cfg.op || '(未配置)'} server=${cfg.server || '(未配置)'} config=${config.PATHS.config}`);
  console.log(`内容目录 ${cache.PATHS.current}`);

  registerIpc();

  if (!config.isValid(cfg)) {
    console.log('[boot] 配置不完整，进入设置向导');
    createSetupWindow();
  } else {
    createPlayerWindow();
    createTray();
    applyAutoStart();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (config.isValid(cfg)) createPlayerWindow();
      else createSetupWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // kiosk 终端不允许"关掉窗口就退出"，托盘还在就继续跑
  if (allowQuit) app.quit();
});

app.on('before-quit', () => {
  allowQuit = true;
  if (watchdogTimer) clearInterval(watchdogTimer);
});

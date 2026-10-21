// 配置与路径。终端只有两种身份信息：op（本机是哪道工序）和 server（服务器地址）。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 路径全部用 ASCII，且放在 %LOCALAPPDATA%，避免 Program Files 只读、
// 也避免中文目录在 file:// 里编码出错（屏幕上的参数只影响显示，不影响磁盘）。
// VWI_TERMINAL_ROOT 仅用于自动化测试，让它跑到临时目录里，不碰真机数据。
const ROOT = process.env.VWI_TERMINAL_ROOT ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'online-vwi-terminal');

const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  content: path.join(ROOT, 'content'),
  current: path.join(ROOT, 'content', 'current'),
  index: path.join(ROOT, 'content', 'index.json'),
  logs: path.join(ROOT, 'logs'),
  log: path.join(ROOT, 'logs', 'terminal.log')
};

const DEFAULTS = {
  op: '',                        // 必填：OP10..OP50
  server: '',                    // 必填：http://192.168.x.x:8092
  kiosk: true,
  autoStart: true,               // 开机自启
  pollFallbackMs: 30000,         // 长轮询断线后的兜底间隔
  allowDevTools: false
};

function ensureDirs() {
  for (const p of [PATHS.root, PATHS.content, PATHS.current, PATHS.logs]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  c.op = String(c.op || '').trim().toUpperCase();
  c.server = String(c.server || '').trim().replace(/\/+$/, '');
  if (c.server && !/^https?:\/\//i.test(c.server)) c.server = 'http://' + c.server;
  c.kiosk = c.kiosk !== false;
  c.autoStart = c.autoStart !== false;
  return c;
}

function isValid(c) {
  return Boolean(c && c.op && /^https?:\/\/[^\s]+/i.test(c.server));
}

/**
 * 部署包所在目录（"exe 旁边"到底在哪）。
 * portable 单文件包运行时会把程序解到 %TEMP%\<unpackDirName>，process.execPath 指向临时目录，
 * 真正的 exe 所在目录由 electron-builder 通过 PORTABLE_EXECUTABLE_DIR 告诉我们；
 * 免安装解压版 / 安装版则直接取 execPath 的目录。
 */
function exeDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

/**
 * 读配置。优先级：
 *   1. exe 同级目录的 config.json —— 部署包自带，运维批量改这一份最方便
 *   2. %LOCALAPPDATA% 里的 config.json —— 装机向导写出来的
 * 1 存在时会覆盖 2，这样"改部署包里的 config.json 再重启"就能换配置。
 */
function load() {
  ensureDirs();
  const portable = path.join(exeDir(), 'config.json');
  const fromPortable = readJson(portable, null);
  if (fromPortable) {
    const c = normalize(fromPortable);
    if (isValid(c)) {
      save(c);                     // 同步一份到本地，避免以后找不到部署包就丢配置
      return { ...c, from: 'portable' };
    }
  }
  const local = readJson(PATHS.config, null);
  if (local) return { ...normalize(local), from: 'local' };
  return { ...normalize({}), from: 'none' };
}

function save(c) {
  ensureDirs();
  const clean = normalize(c);
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = clean[k];
  fs.writeFileSync(PATHS.config, JSON.stringify(out, null, 2), 'utf8');
  return clean;
}

module.exports = { PATHS, DEFAULTS, load, save, isValid, normalize, ensureDirs, readJson, exeDir };

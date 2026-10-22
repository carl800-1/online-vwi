// 配置与路径。终端只有三种身份信息：line（哪条线体）、op（哪道工序）、server（服务器地址）。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 路径全部用 ASCII，且放在 %LOCALAPPDATA%，避免 Program Files 只读、
// 也避免中文目录在 file:// 里编码出错（屏幕上的参数只影响显示，不影响磁盘）。
// ESOP_TERMINAL_ROOT / VWI_TERMINAL_ROOT 仅用于自动化测试，让它跑到临时目录里，不碰真机数据。
const ROOT_NAME = 'esop-client';          // 1.7.0 起叫这个
const LEGACY_NAME = 'online-vwi-terminal'; // 1.6.0 及以前

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/**
 * 定配置目录，并把老目录搬过来。
 *
 * 1.7.0 把目录名从 online-vwi-terminal 改成 esop-client。**这一步不能把现场的屏搞成空配置**：
 * 5 台屏都是装机向导填过地址和工序的，配置丢了就得逐台重装，所以这里自动迁移。
 *
 * 迁移顺序：
 *   ① rename —— 同一个盘符、同一个父目录，瞬间完成，连 content 缓存一起搬，不复制字节
 *   ② 整目录 cpSync —— rename 失败（被杀软锁、跨卷）时兜底
 *   ③ 都失败 —— **退回继续用老目录**，宁可名字难看也不能让屏变成"未装机"
 */
function resolveRoot() {
  const forced = process.env.ESOP_TERMINAL_ROOT || process.env.VWI_TERMINAL_ROOT;
  if (forced) return { root: forced, migrated: false, from: 'env' };

  const base = localAppData();
  const root = path.join(base, ROOT_NAME);
  const legacy = path.join(base, LEGACY_NAME);

  if (!fs.existsSync(legacy)) return { root, migrated: false };
  if (fs.existsSync(path.join(root, 'config.json'))) return { root, migrated: false };

  // rename 的目标必须是"不存在或空"的目录，先把可能残留的空目录清掉
  try { fs.rmSync(root, { recursive: false, force: true }); } catch { /* 非空就留着，走 copy */ }

  try {
    fs.renameSync(legacy, root);
    return { root, migrated: true, how: 'rename', legacy };
  } catch { /* 继续兜底 */ }

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(legacy, root, { recursive: true, errorOnExist: false, force: false });
    return { root, migrated: true, how: 'copy', legacy };
  } catch (e) {
    return { root: legacy, migrated: false, error: e.message };
  }
}

const RESOLVED = resolveRoot();
const ROOT = RESOLVED.root;

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
  line: '',                      // 线体编码（L1…）。留空 = 跟随服务端当前启用的线体
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
  c.line = String(c.line || '').trim().toUpperCase();
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

module.exports = { PATHS, DEFAULTS, load, save, isValid, normalize, ensureDirs, readJson, exeDir, MIGRATION: RESOLVED };

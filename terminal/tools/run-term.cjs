// 终端启动器（自动化验收用）：脱离父进程拉起 electron，输出落盘，父进程立即返回。
// 用法：node tools/run-term.cjs <实例名> [electron 参数...]
//   - 每个实例名对应一个独立的数据根目录（probe-out/roots/<实例名>），
//     所以同一个 exe 可以同时跑多台"终端"，用来验收 A1 的"同时切"。
//   - 日志与 pid 落在 probe-out/<实例名>.log / .pid。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const name = process.argv[2] || 'default';
const rest = process.argv.slice(3);
// --op/--server/--kiosk/--autostart 用于直接写一份配置，省得每台都手工点装机向导
const cfgArgs = {};
const extra = [];
for (const a of rest) {
  const m = /^--(op|server|kiosk|autostart)=(.*)$/i.exec(a);
  if (m) cfgArgs[m[1].toLowerCase()] = m[2];
  else extra.push(a);
}
const root = path.join(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const outDir = path.join(__dirname, 'probe', 'probe-out');
const dataRoot = path.join(outDir, 'roots', name);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });

if (Object.keys(cfgArgs).length) {
  const cfgFile = path.join(dataRoot, 'config.json');
  const base = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const next = {
    kiosk: true, autoStart: false, pollFallbackMs: 30000, allowDevTools: true,
    ...base
  };
  if (cfgArgs.op) next.op = cfgArgs.op.toUpperCase();
  if (cfgArgs.server) next.server = cfgArgs.server;
  if (cfgArgs.kiosk) next.kiosk = cfgArgs.kiosk !== 'false';
  if (cfgArgs.autostart) next.autoStart = cfgArgs.autostart !== 'false';
  fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2), 'utf8');
  console.log(`实例 ${name} 配置：op=${next.op} server=${next.server} kiosk=${next.kiosk}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.VWI_TERMINAL_ROOT = dataRoot;

const logFd = fs.openSync(path.join(outDir, `${name}.log`), 'w');
const child = spawn(exe, [root, ...extra], {
  cwd: root,
  env,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  windowsHide: false
});
child.unref();
fs.writeFileSync(path.join(outDir, `${name}.pid`), String(child.pid));
console.log(`实例 ${name} 已启动 pid=${child.pid} root=${dataRoot} args=${extra.join(' ') || '(无)'}`);

// 探针启动器：用干净环境拉起 electron.exe，并把 stdout/stderr 落盘。
// 直接双击/命令行启动时，环境里可能带 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node、不开窗口。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const outFile = path.join(__dirname, 'probe-out', 'spawn.log');
fs.mkdirSync(path.join(__dirname, 'probe-out'), { recursive: true });

if (!fs.existsSync(exe)) {
  console.error('缺少 Electron：请先在 terminal 目录执行 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // 关键：必须删掉，而不是设成空串
delete env.VWI_TERMINAL_ROOT;

const args = [__dirname];
const child = spawn(exe, args, { env, windowsHide: false });
let buf = '';
const sink = (d) => { buf += d.toString(); fs.writeFileSync(outFile, buf); };
child.stdout.on('data', sink);
child.stderr.on('data', sink);
child.on('exit', (code) => {
  sink(`\n[spawn] 子进程退出 code=${code}\n`);
  const probe = path.join(__dirname, 'probe-out', 'probe.log');
  if (fs.existsSync(probe)) sink('\n[probe.log]\n' + fs.readFileSync(probe, 'utf8'));
  console.log(`退出码 ${code}，详见 tools/probe/probe-out/`);
});

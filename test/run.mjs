// 测试运行器：起一个"干净数据目录"的服务实例，跑完自动关掉并清理
//
// 为什么不复用开发实例：测试会切型号、删媒体，跑在开发数据上会把工程部正在用的
// 内容搞乱。每次给一个全新目录，测完即焚。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8093);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-test-'));
const BASE = `http://127.0.0.1:${PORT}`;

const log = (s) => process.stdout.write(s + '\n');

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: DATA, VWI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (b) => {
    const s = b.toString();
    if (/error|Error/.test(s)) process.stderr.write(s);
  });
  child.stderr.on('data', (b) => process.stderr.write(b.toString()));
  return child;
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/status');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function runE2e() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e.mjs')], {
      cwd: ROOT,
      env: { ...process.env, BASE },
      stdio: 'inherit'
    });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

(async () => {
  log(`\n临时数据目录：${DATA}`);
  log(`测试端口：${PORT}\n`);

  const server = startServer();
  let code = 1;
  try {
    if (!await waitReady()) {
      log('服务未能启动，测试中止');
      process.exitCode = 1;
      return;
    }
    code = await runE2e();
  } finally {
    server.kill();
    setTimeout(() => {
      try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 文件还被占用就留给系统清理 */ }
    }, 300);
    process.exitCode = code;
  }
})();

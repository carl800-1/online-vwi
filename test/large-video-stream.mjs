// 大视频并发拉流压测：5 台屏同时下整段视频 + 2 台拖进度条，看服务端撑不撑得住。
//
//   node test/large-video-stream.mjs
//   SRC_DATA=D:\project\09.ESOP\v5.0.1\ESOP-Server\data node test/large-video-stream.mjs
//
// 为什么单独一个脚本：现场报「130M 的视频一播服务端就崩」，而单元测试里全是几 KB 的假图，
// 根本走不到大文件那条路。这里直接拿交付库的真实视频（只读复制一份，不动原库）。
//
// 判定标准：
//   · 进程不能退出（exit 事件一旦触发就是复现了）
//   · 每一轮全部请求都要 200/206
//   · 结束后 /api/status 还得能应答
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8096);
const BASE = `http://127.0.0.1:${PORT}`;
const SRC = process.env.SRC_DATA || 'D:\\project\\09.ESOP\\v5.0.1\\ESOP-Server\\data';
const CLIENTS = Number(process.env.CLIENTS || 5);
const ROUNDS = Number(process.env.ROUNDS || 3);

const log = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (c, m, d) => {
  if (c) { pass++; log('  ✓ ' + m); }
  else { fails.push(m); log('  ✗ ' + m + (d ? '　→ ' + d : '')); }
};

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-video-'));

function prepareData() {
  // 只复制库 + 媒体（现场那份别动）
  fs.mkdirSync(DATA, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'vwi.db'), path.join(DATA, 'vwi.db'));
  const media = path.join(SRC, 'media');
  if (fs.existsSync(media)) fs.cpSync(media, path.join(DATA, 'media'), { recursive: true });
}

function pickVideo() {
  const db = new DatabaseSync(path.join(DATA, 'vwi.db'));
  const row = db.prepare("SELECT id, name, bytes, mime FROM media WHERE kind = 'video' ORDER BY bytes DESC LIMIT 1").get();
  db.close();
  return row;
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: DATA, VWI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (b) => {
    const s = b.toString();
    if (/error|Error|崩/.test(s)) process.stderr.write('[server] ' + s);
  });
  child.stderr.on('data', (b) => process.stderr.write('[server] ' + b.toString()));
  return child;
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/status');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

/** 整段下载（屏首次拿内容的真实路径） */
async function fullPull(url) {
  const r = await fetch(BASE + url);
  if (r.status !== 200) return { status: r.status, bytes: 0 };
  let n = 0;
  for await (const chunk of r.body) n += chunk.length;
  return { status: r.status, bytes: n };
}

/** 拖进度条：随机一段，有时读到一半就断开（屏切内容时就是这样） */
async function seekPull(url, total, abortMid) {
  const start = Math.floor(Math.random() * Math.max(1, total - 1024 * 1024));
  const end = Math.min(total - 1, start + 1024 * 1024 - 1);
  const ac = new AbortController();
  const r = await fetch(BASE + url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: ac.signal
  });
  if (r.status !== 206) return { status: r.status, bytes: 0 };
  let n = 0;
  try {
    for await (const chunk of r.body) {
      n += chunk.length;
      if (abortMid && n > 128 * 1024) { ac.abort(); break; }
    }
  } catch { /* 主动 abort，属预期 */ }
  return { status: r.status, bytes: n };
}

(async () => {
  log('\n大视频并发压测');
  log('源数据：' + SRC);
  log('临时副本：' + DATA + '\n');

  prepareData();
  const v = pickVideo();
  if (!v) {
    log('库里没有视频，先传一个再跑。');
    process.exit(2);
  }
  log(`视频：${v.name}　${(v.bytes / 1048576).toFixed(1)} MB　${v.mime}\n`);

  const child = startServer();
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  try {
    if (!await waitReady()) {
      ok(false, '服务起不来');
      return;
    }
    const url = '/m/' + v.id;

    for (let round = 1; round <= ROUNDS; round++) {
      const t0 = Date.now();
      const jobs = [];
      for (let i = 0; i < CLIENTS; i++) jobs.push(fullPull(url));
      for (let i = 0; i < 2; i++) jobs.push(seekPull(url, v.bytes, true));
      const rs = await Promise.all(jobs);
      const ms = Date.now() - t0;
      const bad = rs.filter((r) => ![200, 206].includes(r.status));
      const bytes = rs.reduce((a, r) => a + r.bytes, 0);
      ok(bad.length === 0 && !exited,
        `第 ${round} 轮：${CLIENTS} 台整段 + 2 台拖动，共 ${(bytes / 1048576).toFixed(0)} MB / ${(ms / 1000).toFixed(1)} 秒` +
        (exited ? `　← 进程已退出 code=${exited.code}` : ''),
        bad.map((r) => 'HTTP ' + r.status).join(','));
      if (exited) break;
      await sleep(300);
    }

    if (!exited) {
      const r = await fetch(BASE + '/api/status');
      ok(r.ok, '压完服务端还在应答 /api/status');
      const pl = await fetch(BASE + '/display/playlist?line=&op=');
      ok(pl.status === 200 || pl.status === 400, `压完 /display/playlist 应答 ${pl.status}`);
    }
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(200);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
    log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
    if (exited) log(`⚠ 服务端退出：code=${exited.code} signal=${exited.sig}`);
    if (fails.length) { log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  }
})().catch((e) => {
  console.error('压测脚本自身出错：', e);
  process.exit(3);
});

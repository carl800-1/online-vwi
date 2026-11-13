// 多终端并发压测：模拟 N 台屏同时对着一个服务端跑，回答"一台服务端能带多少台"。
//
// 为什么要有它：现场是 1 对 25，而平时测试都只模拟 2 台。
// 这里刻意复刻终端的真实行为，不是造并发 HTTP：
//   · 每台独立 keep-alive agent（maxSockets 4，与 terminal/src/net.js 一致）
//   · 素材**串行**下载（与 terminal/src/cache.js 一致，不是一个文件开 4 条）
//   · 心跳 5 秒一次（与 terminal/src/sync.js 的 setInterval 一致）
//   · 长轮询挂 25 秒，服务端不超时就不回
// 这三条决定了真实压力远小于"25 × 并发下载"，所以不能用 ab / autocannon 代替。
//
// 运行：
//   BASE=http://127.0.0.1:8092 N=25 LINE=L1 OP=OP3 node test/load.mjs
//   STEADY_SEC=120 node test/load.mjs          # 稳态多跑两分钟
//   SKIP_COLD=1 node test/load.mjs             # 跳过冷启动，只量稳态
//
// 服务端要先有内容（见 test/e2e.mjs）；空库只验连通，不能验带宽。

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8092';
const N = Math.max(1, Number(process.env.N || 25));
const LINE = process.env.LINE || 'L1';
const OP = process.env.OP || 'OP3';
const STEADY_SEC = Math.max(0, Number(process.env.STEADY_SEC ?? 60));
const SKIP_COLD = process.env.SKIP_COLD === '1';
const HB_MS = 5000;          // 与终端一致

const base = new URL(BASE);
const lib = base.protocol === 'https:' ? https : http;

/** 每台独立的 agent：真实终端各是独立进程，不会共享 socket 池 */
function makeAgent() {
  const Ctor = base.protocol === 'https:' ? https.Agent : http.Agent;
  return new Ctor({ keepAlive: true, maxSockets: 4, timeout: 60_000 });
}

function request(agent, path, { method = 'GET', body = null, timeoutMs = 40_000 } = {}) {
  const u = new URL(path, base.href);
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = lib.request(
      u,
      { agent, method, timeout: timeoutMs, headers: { connection: 'keep-alive' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            buffer: Buffer.concat(chunks),
            ms: Number(process.hrtime.bigint() - t0) / 1e6
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function getJson(agent, path, opt) {
  const r = await request(agent, path, opt);
  let data = null;
  try { data = JSON.parse(r.buffer.toString('utf8')); } catch { data = null; }
  if (r.status >= 400) {
    const err = new Error('HTTP ' + r.status + ' ' + path);
    err.status = r.status;
    throw err;
  }
  return { data, ms: r.ms };
}

async function postJson(agent, path, obj, opt) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  return getJson(agent, path, {
    ...opt,
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json', 'content-length': payload.length }
  });
}

/** 下载一个文件并算 sha256 —— 与终端 net.download 一样边下边算 */
function download(agent, path, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base.href);
    const t0 = process.hrtime.bigint();
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const req = lib.request(u, { agent, timeout: timeoutMs, headers: { connection: 'keep-alive' } }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' ' + path));
      }
      res.on('data', (c) => { bytes += c.length; hash.update(c); });
      res.on('end', () => {
        resolve({ bytes, sha: hash.digest('hex'), ms: Number(process.hrtime.bigint() - t0) / 1e6 });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.end();
  });
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
const now = () => Date.now();

function summarize(label, arr, unit = 'ms') {
  if (!arr.length) return `${label}：无样本`;
  return `${label}：平均 ${avg(arr).toFixed(0)}${unit}　P95 ${pct(arr, 95).toFixed(0)}${unit}　最大 ${Math.max(...arr).toFixed(0)}${unit}`;
}

// ───────────────────────── 阶段 A：25 台同时冷启动 ─────────────────────────

async function coldStart() {
  console.log('');
  console.log(`【阶段 A】${N} 台同时冷启动（自报 → 取清单 → 串行下载 → 心跳）`);
  console.log('─'.repeat(72));

  const t0 = now();
  const stats = [];

  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const name = `load-${String(i + 1).padStart(2, '0')}`;
      const agent = makeAgent();
      const s = { name, hello: 0, playlist: 0, dl: 0, bytes: 0, files: 0, shaBad: 0, err: '' };
      try {
        // ① 自报（1.8.0 才有；老服务端回 404 也不影响播放）
        const h = await postJson(agent, '/api/clients/hello',
          { line: LINE, op: OP, res: '1920x1080', ver: '1.8.0', name }, { timeoutMs: 15_000 });
        s.hello = h.ms;

        // ② 取清单
        const pl = await getJson(agent, `/display/playlist?line=${encodeURIComponent(LINE)}&op=${encodeURIComponent(OP)}`,
          { timeoutMs: 30_000 });
        s.playlist = pl.ms;
        const items = (pl.data && pl.data.items) || [];

        // ③ 串行下载（与终端一致：一个文件完成再下一个）
        const d0 = now();
        for (const it of items) {
          const d = await download(agent, it.url);
          s.files++;
          s.bytes += d.bytes;
          if (it.sha256 && d.sha !== it.sha256) s.shaBad++;
        }
        s.dl = now() - d0;

        // ④ 首次心跳
        await postJson(agent, '/api/telemetry',
          { line: LINE, op: OP, done: items.length, total: items.length, st: 'play', res: '1920x1080', ver: '1.8.0', free: 51200, name },
          { timeoutMs: 10_000 });
      } catch (e) {
        s.err = e.status ? `HTTP ${e.status}` : (e.message || String(e));
      } finally {
        agent.destroy();
        stats.push(s);
      }
    })
  );

  const wall = now() - t0;
  const ok = stats.filter((s) => !s.err);
  const bad = stats.filter((s) => s.err);
  const totalBytes = ok.reduce((a, s) => a + s.bytes, 0);
  const totalFiles = ok.reduce((a, s) => a + s.files, 0);

  console.log(`  完成 ${ok.length}/${N} 台　总墙钟 ${(wall / 1000).toFixed(1)}s`);
  console.log(`  下载 ${totalFiles} 个文件　${mb(totalBytes)}　平均吞吐 ${(totalBytes / 1048576 / (wall / 1000)).toFixed(1)} MB/s`);
  console.log('  ' + summarize('单台总耗时', ok.map((s) => s.hello + s.playlist + s.dl)));
  console.log('  ' + summarize('  自报', ok.map((s) => s.hello)));
  console.log('  ' + summarize('  取清单', ok.map((s) => s.playlist)));
  console.log('  ' + summarize('  下载', ok.map((s) => s.dl)));
  const shaBad = ok.reduce((a, s) => a + s.shaBad, 0);
  console.log(`  sha 校验：${shaBad === 0 ? '全部一致' : shaBad + ' 个不符'}　失败 ${bad.length} 台`);
  if (bad.length) {
    const seen = new Map();
    for (const s of bad) seen.set(s.err, (seen.get(s.err) || 0) + 1);
    for (const [e, c] of seen) console.log(`    × ${c} 台　${e}`);
  }
  return { wall, totalBytes, ok: ok.length, bad: bad.length };
}

// ───────────────────────── 阶段 B：稳态长轮询 + 心跳 ─────────────────────────

async function steady() {
  console.log('');
  console.log(`【阶段 B】${N} 台稳态 ${STEADY_SEC} 秒（长轮询 + 5 秒心跳）`);
  console.log('─'.repeat(72));

  const agents = Array.from({ length: N }, () => makeAgent());
  const polls = [];       // 每台的长轮询耗时
  const beats = [];       // 心跳耗时
  const errs = [];
  let rounds = 0;
  let beatsCount = 0;

  const stop = { v: false };
  const deadline = now() + STEADY_SEC * 1000;

  // 心跳：每台独立 5 秒节拍，错开相位，避免 25 台同一毫秒醒来
  const hbTimers = agents.map((agent, i) => {
    const tick = async () => {
      if (stop.v) return;
      try {
        const r = await postJson(agent, '/api/telemetry',
          { line: LINE, op: OP, done: 3, total: 3, st: 'play', res: '1920x1080', ver: '1.8.0', free: 51200, name: `load-${String(i + 1).padStart(2, '0')}` },
          { timeoutMs: 10_000 });
        beats.push(r.ms);
        beatsCount++;
      } catch (e) {
        errs.push('心跳 ' + (e.message || e));
      }
    };
    const id = setInterval(tick, HB_MS);
    setTimeout(tick, Math.floor((HB_MS / N) * i));   // 相位错开
    return id;
  });

  // 长轮询：每台一个循环
  // since 必须带「上一轮的 rev」，不能写 0 —— 服务端发现 rev 已变会立刻返回，
  // 那样测出来的 3ms 是"首轮快返回"，不是真实挂起。真终端就是这么带的。
  await Promise.all(agents.map(async (agent) => {
    let since = 0;
    try {
      const first = await getJson(agent, `/api/state?op=${encodeURIComponent(OP)}&since=0&line=${encodeURIComponent(LINE)}`,
        { timeoutMs: 20_000 });
      since = Number(first.data && first.data.rev) || 0;
    } catch (e) {
      errs.push('首轮 ' + (e.message || e));
    }
    while (!stop.v && now() < deadline) {
      try {
        const r = await getJson(agent, `/api/state?op=${encodeURIComponent(OP)}&since=${since}&line=${encodeURIComponent(LINE)}`,
          { timeoutMs: 45_000 });
        polls.push(r.ms);
        since = Number(r.data && r.data.rev) || since;
        rounds++;
      } catch (e) {
        if (!stop.v) errs.push('长轮询 ' + (e.message || e));
      }
    }
  }));

  stop.v = true;
  hbTimers.forEach(clearInterval);
  agents.forEach((a) => a.destroy());

  console.log(`  长轮询 ${rounds} 轮　心跳 ${beatsCount} 次　错误 ${errs.length}`);
  console.log('  ' + summarize('长轮询响应', polls));
  console.log('  ' + summarize('心跳响应', beats));
  if (errs.length) {
    const seen = new Map();
    for (const e of errs) seen.set(e, (seen.get(e) || 0) + 1);
    for (const [e, c] of seen) console.log(`    × ${c}　${e}`);
  }
  return { rounds, beatsCount, errs: errs.length, pollP95: pct(polls, 95), pollMax: Math.max(0, ...polls) };
}

// ───────────────────────── 阶段 C：一次改动，25 台同时醒 ─────────────────────────

/**
 * 现场最高频的操作是"改了张图 → 屏上要跟着变"。
 * 服务端 bump() 是遍历 waiters 一次性 resolve（广播），所以理论上 25 台应当
 * 在**同一时刻**醒来，而不是排队。如果这里是阶梯状（比如每台差几百毫秒），
 * 说明有串行瓶颈，现场表现就是"有的屏先变、有的屏后变"。
 */
async function broadcast() {
  console.log('');
  console.log(`【阶段 C】一次内容改动，${N} 台同时醒`);
  console.log('─'.repeat(72));

  const admin = makeAgent();
  let modelId = '';
  let processId = '';
  let items = [];
  try {
    const b = await getJson(admin, '/api/board', { timeoutMs: 15_000 });
    const L = (b.data.lines || []).find((x) => x.code === LINE);
    if (!L) throw new Error('找不到线体 ' + LINE);
    modelId = (L.model && L.model.id) || L.currentModelId || '';
    const c = (L.clients || []).find((x) => x.op === OP);
    processId = c && c.processId;
    if (!modelId || !processId) throw new Error('线体/工序信息不全，跳过阶段 C');
    const pl = await getJson(admin, `/api/playlist?modelId=${encodeURIComponent(modelId)}&processId=${encodeURIComponent(processId)}`,
      { timeoutMs: 15_000 });
    items = (pl.data.items || []).map((it) => ({ mediaId: it.mediaId, dwellSec: it.dwellSec }));
    if (!items.length) throw new Error('清单为空，跳过阶段 C');
  } catch (e) {
    console.log('  跳过：' + (e.message || e));
    admin.destroy();
    return null;
  }

  const agents = Array.from({ length: N }, () => makeAgent());
  const wakes = [];
  const t0 = now();

  // 各台先对齐到当前 rev，然后挂上（since = 当前 rev 才会真挂起）
  await Promise.all(agents.map(async (a) => {
    try {
      const r = await getJson(a, `/api/state?op=${encodeURIComponent(OP)}&since=0&line=${encodeURIComponent(LINE)}`, { timeoutMs: 20_000 });
      a._rev = Number(r.data && r.data.rev) || 0;
    } catch { a._rev = 0; }
  }));

  const pending = agents.map((a) =>
    getJson(a, `/api/state?op=${encodeURIComponent(OP)}&since=${a._rev}&line=${encodeURIComponent(LINE)}`, { timeoutMs: 45_000 })
      .then(() => wakes.push(now() - t0))
      .catch(() => {})
  );

  await new Promise((r) => setTimeout(r, 1500));   // 等 1.5 秒，确保 25 台都挂上了

  const before = now() - t0;
  items[0].dwellSec = items[0].dwellSec === 9 ? 8 : 9;   // 改一个无关紧要的字段，制造一次 rev++
  let putMs = 0;
  try {
    const r = await request(admin, '/api/playlist', {
      method: 'PUT',
      body: Buffer.from(JSON.stringify({ modelId, processId, items }), 'utf8'),
      timeoutMs: 30_000
    });
    putMs = r.ms;
    if (r.status >= 400) console.log('  ⚠ 保存清单失败 HTTP ' + r.status + ' ' + r.buffer.toString('utf8').slice(0, 120));
  } catch (e) {
    console.log('  ⚠ 保存清单出错：' + (e.message || e));
  }

  await Promise.all(pending);
  agents.forEach((a) => a.destroy());
  admin.destroy();

  const spread = wakes.length ? Math.max(...wakes) - Math.min(...wakes) : 0;
  const afterPut = (wakes.length ? Math.max(...wakes) : before) - before;
  console.log(`  保存清单耗时 ${putMs.toFixed(0)}ms　唤醒 ${wakes.length}/${N} 台`);
  console.log(`  保存后 ${afterPut.toFixed(0)}ms 内全部醒来（跨度 ${spread.toFixed(0)}ms）`);
  if (wakes.length && spread > 500) console.log('  ⚠ 唤醒跨度超过 500ms，说明是排队而非广播');
  else console.log('  广播正常：25 台几乎同时醒，不是排队');
  return { wakes: wakes.length, afterPut, spread };
}

// ───────────────────────── 主流程 ─────────────────────────

(async () => {
  console.log('ESOP 多终端并发压测');
  console.log(`  服务端 ${BASE}　终端 ${N} 台　线体 ${LINE} 工序 ${OP}`);
  console.log(`  心跳 ${HB_MS / 1000}s　长轮询上限 25s（服务端）`);

  // 先拿一份清单，把"这次要压多少数据"报出来
  const agent = makeAgent();
  let items = [];
  try {
    const pl = await getJson(agent, `/display/playlist?line=${encodeURIComponent(LINE)}&op=${encodeURIComponent(OP)}`, { timeoutMs: 15_000 });
    items = (pl.data && pl.data.items) || [];
    const bytes = items.reduce((a, it) => a + (it.bytes || 0), 0);
    console.log(`  清单 ${items.length} 项　${mb(bytes)}　× ${N} 台 = ${mb(bytes * N)} 下载量`);
    if (!items.length) console.log('  ⚠ 清单为空：只能验连通，验不出带宽。先跑 test/e2e.mjs 造内容。');
  } catch (e) {
    console.log('  ✗ 服务端不可达：' + (e.message || e));
    process.exit(1);
  } finally {
    agent.destroy();
  }

  const cold = SKIP_COLD ? null : await coldStart();
  const st = STEADY_SEC > 0 ? await steady() : null;
  const bc = process.env.SKIP_BROADCAST === '1' ? null : await broadcast();

  console.log('');
  console.log('【结论】');
  console.log('─'.repeat(72));
  if (cold) {
    console.log(`  冷启动：${cold.ok}/${N} 台成功，${(cold.wall / 1000).toFixed(1)}s 下完 ${mb(cold.totalBytes)}`);
  }
  if (st) {
    console.log(`  稳态：长轮询 P95 ${st.pollP95.toFixed(0)}ms（上限 25000ms）　最大 ${st.pollMax.toFixed(0)}ms　错误 ${st.errs}`);
    if (st.pollMax > 26_000) console.log('  ⚠ 有长轮询超过了 25 秒上限，说明服务端事件循环被拖住过');
  }
  if (bc) {
    console.log(`  改内容：保存后 ${bc.afterPut.toFixed(0)}ms 内 ${bc.wakes}/${N} 台全部醒来，跨度 ${bc.spread.toFixed(0)}ms`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('压测脚本自身出错：', e);
  process.exit(1);
});

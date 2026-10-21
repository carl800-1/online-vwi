/**
 * 终端数据层的集成测试（不需要 Electron）。
 *
 * 为什么要单独测这一层：exe 里真正会出事的地方不是画面，是
 *   ① 内容有没有真的落到磁盘、sha 校验过没有
 *   ② 切换之后旧文件到底删没删（A8，最容易在真机上翻车）
 *   ③ 断网/重启后能不能不看网络就把画面放出来（A3/A4/A5 的底座）
 * 这三件事全在主进程里，用假渲染层就能验，不必等真机。
 *
 * 跑法：node test/sync-test.cjs
 * 需要一个正在运行的服务器；默认 127.0.0.1:8092，可用 SERVER 环境变量覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const SERVER = (process.env.SERVER || 'http://127.0.0.1:8092').replace(/\/+$/, '');
const OP = process.env.OP || 'OP30';
const ROOT = path.join(os.tmpdir(), 'vwi-term-test-' + Date.now());

process.env.VWI_TERMINAL_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'config.json'),
  JSON.stringify({ op: OP, server: SERVER, kiosk: false, autoStart: false }), 'utf8');

const config = require('../src/config');
const cache = require('../src/cache');
const { Syncer } = require('../src/sync');

// ───────────────────────── 小工具 ─────────────────────────

let pass = 0;
const failures = [];

function ok(cond, msg, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail ? '　→ ' + detail : ''}`);
  }
}

function eq(a, b, msg) {
  ok(a === b, msg, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
}

function waitFor(fn, ms, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('超时：' + label + `（${ms}ms）`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function req(method, apiPath, body) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const url = new URL(apiPath, SERVER);
  return new Promise((resolve, reject) => {
    const r = http.request(url, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        try { resolve(JSON.parse(t)); } catch { resolve({ raw: t, status: res.statusCode }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const filesNow = () => {
  try { return fs.readdirSync(cache.PATHS.current).sort(); } catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 假渲染层 ─────────────────────────

function makeFlipLog() {
  const events = [];
  const handler = async (view) => {
    // 模拟 exe 里"渲染层要真的能读到这些文件"这一步。
    // 文件不存在或读不了，就当作翻转失败 —— 和真实渲染层行为一致。
    for (const it of view.items) {
      if (!fs.existsSync(it.file)) throw new Error('文件不存在：' + it.file);
      fs.accessSync(it.file, fs.constants.R_OK);
    }
    events.push({
      modelCode: view.modelCode,
      modelId: view.modelId,
      count: view.items.length,
      reason: view.reason,
      files: view.items.map((i) => path.basename(i.file)),
      at: Date.now()
    });
    return true;
  };
  return { events, handler };
}

async function switchTo(code) {
  // 服务端若已在这个型号，先切走再切回来，否则 switchTo 会返回 already-pending
  return req('POST', '/api/switch', { modelCode: code });
}

// ───────────────────────── 用例 ─────────────────────────

async function main() {
  console.log(`\n终端数据层集成测试　server=${SERVER} op=${OP}`);
  console.log(`临时数据目录：${ROOT}\n`);

  const st0 = await req('GET', '/api/status');
  console.log(`服务器当前：${st0.modelCode}　seq=${st0.seq}　phase=${st0.phase}`);
  console.log(`本机已有缓存：${cache.stats().files} 个文件\n`);

  // ── S1 冷启动：本地空 → 下载 → 起播 ──
  console.log('S1 首次装载（盘上为空）');
  await switchTo(st0.modelCode || 'X200');
  await sleep(300);

  const log1 = makeFlipLog();
  const s1 = new Syncer({ op: OP, server: SERVER }, { flipHandler: log1.handler });
  s1.start();

  await waitFor(() => s1.snapshot().status === 'play' && cache.stats().files > 0, 25_000, 'S1 起播');
  const snap1 = s1.snapshot();
  ok(Boolean(snap1.modelCode), `拿到型号：${snap1.modelCode}`);
  ok(cache.stats().files > 0, `文件已落盘：${cache.stats().files} 个 / ${(cache.stats().bytes / 1024).toFixed(0)}KB`);
  eq(log1.events.filter((e) => e.reason === 'switch').length >= 1, true, '首次装载走的是 flip（不是冷启动直出）');
  const firstFiles = filesNow();
  eq(cache.stats().files, cache.stats().expectFiles, '磁盘文件数 = 清单条数（没有多余文件）');
  ok(firstFiles.every((f) => !f.endsWith('.part')), '没有残留的 .part 半截文件');

  // ── S2 切换：下载新内容 → 翻转 → 旧文件被删（A8） ──
  console.log('\nS2 切换型号（A8：旧文件必须删掉）');
  const before = new Set(firstFiles);
  const target = snap1.modelCode === 'X210' ? 'X200' : 'X210';
  const expect = await req('GET', `/display/playlist?op=${OP}&model=${target}`);
  const expectNames = expect.items.map((i) => `${i.mediaId}.${i.ext}`).sort();

  const t0 = Date.now();
  await switchTo(target);
  await waitFor(
    () => s1.snapshot().modelCode === target && s1.snapshot().status !== 'preparing',
    40_000,
    'S2 切换完成'
  );
  const cost = Date.now() - t0;
  const after = filesNow();
  const snap2 = s1.snapshot();

  eq(snap2.modelCode, target, `屏上型号已变成 ${target}`);
  eq(after.length, expectNames.length, `磁盘只剩 ${expectNames.length} 个文件（当前这一套）`);
  eq(JSON.stringify(after), JSON.stringify(expectNames), '文件集合与目标清单完全一致');
  ok(cost < 60_000, `切换耗时 ${(cost / 1000).toFixed(1)} 秒（验收上限 5 分钟）`);

  const removed = [...before].filter((f) => !expectNames.includes(f));
  const stillThere = removed.filter((f) => after.includes(f));
  if (removed.length) {
    eq(stillThere.length, 0, `旧型号独有的 ${removed.length} 个文件已删除（${removed.join(', ')}）`);
  } else {
    ok(true, '两个型号内容完全重合，本项不适用（换一对内容不重合的型号可验证）');
  }
  eq(snap2.status, 'play', '状态回到正常播放');

  // ── S3 重启恢复：不连服务器也能出画面（A5 / A4 的底座） ──
  console.log('\nS3 断电重启（本地有内容，先出画面）');
  s1.stop();
  await sleep(400);

  const log2 = makeFlipLog();
  const s2 = new Syncer({ op: OP, server: SERVER }, { flipHandler: log2.handler });
  const tCold = Date.now();
  s2.start();
  await waitFor(() => log2.events.length > 0, 3000, 'S3 冷启动出画面');
  const coldCost = Date.now() - tCold;
  eq(log2.events[0].reason, 'cold-start', '第一件事就是用本地内容起播');
  eq(log2.events[0].modelCode, target, `冷启动播的是 ${target}（上次的型号）`);
  ok(coldCost < 1000, `出画面耗时 ${coldCost}ms（不等网络）`);
  s2.stop();
  await sleep(300);

  // ── S4 断网：画面能起，状态变离线，不报错 ──
  console.log('\nS4 断网（服务器不可达）');
  const log3 = makeFlipLog();
  const s3 = new Syncer({ op: OP, server: 'http://127.0.0.1:9' }, { flipHandler: log3.handler });
  s3.start();
  await waitFor(() => log3.events.length > 0, 3000, 'S4 断网仍出画面');
  await waitFor(() => s3.snapshot().status === 'offline', 8000, 'S4 状态转离线');
  eq(log3.events[0].reason, 'cold-start', '断网时照样播本地内容');
  eq(s3.snapshot().linked, false, '链路标记为断开');
  ok(cache.stats().files > 0, '断网不影响磁盘上的内容');
  s3.stop();
  await sleep(300);

  // ── S5 连切三次，目录不增长（A8 的长期判据） ──
  console.log('\nS5 连续切换三次（磁盘不许越来越大）');
  const log4 = makeFlipLog();
  const s4 = new Syncer({ op: OP, server: SERVER }, { flipHandler: log4.handler });
  s4.start();
  await waitFor(() => log4.events.length > 0, 5000, 'S5 起播');

  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const code = s4.snapshot().modelCode === 'X210' ? 'X200' : 'X210';
    await switchTo(code);
    await waitFor(() => s4.snapshot().modelCode === code && s4.snapshot().status !== 'preparing', 40_000, `第 ${i + 1} 次切换`);
    sizes.push({ files: filesNow().length, bytes: cache.stats().bytes });
  }
  const maxFiles = Math.max(...sizes.map((s) => s.files));
  const maxBytes = Math.max(...sizes.map((s) => s.bytes));
  ok(maxFiles <= 4, `三轮切换后文件数稳定在 ${maxFiles}（未累积）`);
  ok(maxBytes < 60 * 1024 * 1024, `磁盘占用稳定在 ${(maxBytes / 1048576).toFixed(2)}MB（< 60MB）`);
  s4.stop();

  // ── 收尾 ──
  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  · ' + f);
  }

  // 清理临时目录（保留现场请注释掉下面两行）
  await sleep(300);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试中断：', e.message);
  process.exit(2);
});

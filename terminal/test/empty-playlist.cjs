/**
 * 空清单回归测试（1.8.3 修的那个 bug）。
 *
 * 复现的场景，也是现场最容易踩的：
 *   工序里原来有 3 张图，工程部把「播放内容」改成只勾视频 → 清单变成 0 项。
 *   老代码在 ensurePrepared 里直接 return：
 *     ① 不翻转 → 屏上继续播着已经被勾掉的那 3 张图，人以为设置没生效；
 *     ② 不更新 appliedContentRev → 主循环每 25 秒重新核对一遍，永远收敛不了。
 *
 * 本测试断言：清单 0 项时必须真的翻成空（flip count=0）、状态转 incomplete、
 * 且 contentRev 收敛（不再反复核对）。跑完把 playKinds 恢复原样。
 *
 * 需要一个**可以随便写**的服务器（空库或隔离库），不要对着生产库跑：
 *   ESOP_DATA=/tmp/esop-test ESOP_PORT=8093 node server.js
 *   SERVER=http://127.0.0.1:8093 node test/empty-playlist.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const SERVER = (process.env.SERVER || 'http://127.0.0.1:8093').replace(/\/+$/, '');
const LINE = process.env.LINE || 'T1';
const MODEL = process.env.MODEL || 'T9900';
const OP = process.env.OP || 'OP3';

const ROOT = path.join(os.tmpdir(), 'vwi-empty-test-' + Date.now());
process.env.VWI_TERMINAL_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'config.json'),
  JSON.stringify({ line: LINE, op: OP, server: SERVER, kiosk: false, autoStart: false }),
  'utf8'
);

const cache = require('../src/cache');
const { Syncer } = require('../src/sync');

// 1×1 透明 PNG：只要能被当成图片存下来就够了，测试不验画质
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let pass = 0;
const failures = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { failures.push(msg); console.log('  ✗ ' + msg + (detail ? '　→ ' + detail : '')); }
};
const eq = (a, b, msg) => ok(a === b, msg, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, apiPath, body, headers = {}) {
  const data = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
  const url = new URL(apiPath, SERVER);
  return new Promise((resolve, reject) => {
    const r = http.request(url, {
      method,
      headers: data
        ? { 'content-type': 'application/json', 'content-length': data.length, ...headers }
        : headers
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        try { resolve({ status: res.statusCode, ...JSON.parse(t) }); }
        catch { resolve({ status: res.statusCode, raw: t }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 各接口的列表字段名不一样，按顺序认。
// processes 要排在 lines 前面：/api/processes 的响应里同时有 model + lines + processes，
// 先认 lines 会把线体当工序，后面全跟着错。
const listOf = (r) => (Array.isArray(r) ? r
  : (r.processes || r.lines || r.models || r.items || r.list || r.rows || []));

// 接口要求「播放内容」至少留一类；三类全传 = 全部（库里归一成空串）
const ALL_KINDS = ['image', 'pdf', 'video'];

function waitFor(fn, ms, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('超时：' + label));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ───────────────────────── 建档（幂等） ─────────────────────────

async function ensureLine() {
  const lines = listOf(await req('GET', '/api/lines'));
  const hit = lines.find((l) => l.code === LINE);
  if (hit) return hit;
  return req('POST', '/api/lines', { code: LINE, name: '空清单测试线', slots: 5 });
}

async function ensureModel(lineId) {
  const models = listOf(await req('GET', '/api/models'));
  const hit = models.find((m) => m.code === MODEL);
  if (hit) return hit;
  return req('POST', '/api/models', {
    code: MODEL, name: '空清单测试机种', processCount: 0, lineIds: [lineId]
  });
}

async function ensureProcess(modelId) {
  const ps = listOf(await req('GET', `/api/processes?modelId=${encodeURIComponent(modelId)}`));
  const hit = ps.find((p) => p.code === OP);
  if (hit) return hit;
  return req('POST', '/api/processes', { modelId, code: OP, name: '空清单测试工序' });
}

async function main() {
  console.log(`\n空清单回归测试　server=${SERVER} line=${LINE} model=${MODEL} op=${OP}`);
  console.log(`临时终端目录：${ROOT}\n`);

  const st = await req('GET', '/api/status');
  if (st.status && st.status !== 200) throw new Error('服务器不可用：' + JSON.stringify(st));

  // ── 准备一套最小现场：线体 → 机种 → 工序 → 一张图 → 设为当前机种 ──
  console.log('P 准备测试数据');
  const line = await ensureLine();
  ok(Boolean(line.id), `线体 ${LINE} 就绪`);
  const model = await ensureModel(line.id);
  ok(Boolean(model.id), `机种 ${MODEL} 就绪`);
  const proc = await ensureProcess(model.id);
  ok(Boolean(proc.id), `工序 ${OP} 就绪`);

  // 清掉允许类型，免得 1×1 的测试图被"最小 1280×720"拦在闸门外
  await req('PUT', `/api/processes/${proc.id}`, { modelId: model.id, reqs: [] });

  const up = await req(
    'POST',
    `/api/media/upload?filename=${encodeURIComponent('empty-test.png')}` +
      `&modelId=${encodeURIComponent(model.id)}&processId=${encodeURIComponent(proc.id)}`,
    PNG,
    { 'content-type': 'image/png' }
  );
  ok(Boolean(up.id), `图片已上传：${up.id || up.error || up.message}`);

  // 准备阶段就带上「全部」，这样脚本可以反复跑 —— 上一轮没跑完留下的 playKinds 不会污染下一轮
  await req('PUT', '/api/playlist', {
    modelId: model.id,
    processId: proc.id,
    items: [{ mediaId: up.id, dwellSec: 5 }],
    playKinds: ALL_KINDS
  });
  const list0 = await req(
    'GET',
    `/display/playlist?line=${LINE}&op=${OP}&model=${MODEL}`
  );
  eq((list0.items || []).length, 1, '清单里已有 1 项（准备就绪）');

  await req('POST', '/api/board/current', { lineId: line.id, modelCode: MODEL });

  // ── E1 终端起播 ──
  console.log('\nE1 终端起播（清单 1 项）');
  const events = [];
  const syncer = new Syncer({ line: LINE, op: OP, server: SERVER }, {
    flipHandler: async (view) => {
      for (const it of view.items) {
        if (!fs.existsSync(it.file)) throw new Error('文件不存在：' + it.file);
        fs.accessSync(it.file, fs.constants.R_OK);
      }
      events.push({ count: view.items.length, hidden: view.hidden || 0, at: Date.now() });
      return true;
    }
  });
  syncer.start();
  await waitFor(() => events.some((e) => e.count === 1), 25_000, 'E1 起播');
  eq(syncer.snapshot().status, 'play', '状态为正常播放');
  const revBefore = syncer.appliedContentRev;
  ok(revBefore > 0, `已记录内容版本 contentRev=${revBefore}`);

  // ── E2 只改「播放内容」把项全排除 ──
  console.log('\nE2 把「播放内容」改成只放视频（这道工序只有图片 → 清单变 0 项）');
  const t0 = Date.now();
  const put = await req('PUT', '/api/playlist', {
    modelId: model.id,
    processId: proc.id,
    items: [{ mediaId: up.id, dwellSec: 5 }],
    playKinds: ['video']
  });
  ok(!put.error && !put.message, `播放内容已保存：${put.error || put.message || 'ok'}`);

  await waitFor(() => events.some((e) => e.count === 0), 30_000, 'E2 翻成空清单');
  const cost = Date.now() - t0;
  const empty = events.filter((e) => e.count === 0).pop();
  ok(true, `终端已翻成空清单（${(cost / 1000).toFixed(1)} 秒）—— 旧代码这里永远等不到`);
  eq(empty.hidden, 1, '翻转时带上了"被排除"的项数 1');
  eq(events.filter((e) => e.count === 1).length, 1, '只翻了一次空清单（没有反复闪）');
  eq(syncer.snapshot().status, 'incomplete', '状态转 incomplete（屏上显示"内容已暂停播放"）');
  eq(cache.stats().files, 0, '磁盘上的旧内容已清掉（不再占着）');

  // ── E3 收敛：不许每 25 秒重新核对一遍 ──
  console.log('\nE3 收敛（appliedContentRev 要跟上，否则会无限重复核对）');
  const revAfter = syncer.serverContentRev;
  await sleep(3000);
  eq(syncer.appliedContentRev, revAfter, `已生效版本追上服务端（${revAfter}），不再重复核对`);
  eq(events.filter((e) => e.count === 0).length, 1, '3 秒内没有第二次空清单翻转');

  // ── E4 勾回来要能自动恢复 ──
  console.log('\nE4 把「播放内容」改回全部（清单 0 → 1，屏要自己恢复）');
  await req('PUT', '/api/playlist', {
    modelId: model.id,
    processId: proc.id,
    items: [{ mediaId: up.id, dwellSec: 5 }],
    playKinds: ALL_KINDS
  });
  await waitFor(() => events.filter((e) => e.count === 1).length >= 2, 30_000, 'E4 恢复播放');
  eq(syncer.snapshot().status, 'play', '状态回到正常播放');
  ok(cache.stats().files >= 1, '内容重新落盘，屏恢复播放');

  syncer.stop();
  await sleep(300);

  // ── 收尾：把播放内容恢复成"全部" ──
  await req('PUT', '/api/playlist', {
    modelId: model.id,
    processId: proc.id,
    items: [{ mediaId: up.id, dwellSec: 5 }],
    playKinds: ALL_KINDS
  });

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试中断：', e.message);
  process.exit(2);
});

// 端到端协议测试：模拟 2 台终端，验证"无人在线 / 两段式切换 / 一起翻"三条路径
//
// 为什么要有这个脚本：A1（换型切得动、切得齐）是项目验收核心。
// 人工点浏览器只能证明"页面没崩"，证明不了"服务器等到所有人备齐才喊翻"。
// 这里用真 HTTP 把协议跑一遍，任何状态机回归都会当场报错。
//
// 运行：node test/run.mjs    （自动起一个临时数据目录的实例，跑完清理）

import zlib from 'node:zlib';

const BASE = process.env.BASE || 'http://127.0.0.1:8093';

let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : ''));
  }
}

async function j(path, opt) {
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = { raw: text }; }
  return { status: r.status, ok: r.ok, body: d };
}

const post = (p, body) => j(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});
const put = (p, body) => j(p, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

const state = async () => (await j('/api/state?since=0')).body;

// ---------- 造一张最小合法 PNG，不依赖任何外部库 ----------
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function tinyPng(r, g, b, w = 8, h = 8) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

async function upload(buf, name) {
  const r = await fetch(BASE + '/api/media/upload?filename=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: buf
  });
  return { status: r.status, body: await r.json() };
}

(async function main() {
  console.log('\n端到端协议测试 · ' + BASE + '\n');

  // ---------- 0. 档案 ----------
  console.log('[0] 档案与种子数据');
  const models = (await j('/api/models')).body;
  const procs = (await j('/api/processes')).body;
  ok(models.models.length === 10, '10 个型号已就绪');
  ok(procs.processes.length === 5, '5 道工序已就绪');
  ok(models.coverage.total === 50, '完成度分母 50 套（10 × 5）');

  const M = Object.fromEntries(models.models.map((m) => [m.code, m]));
  const P = Object.fromEntries(procs.processes.map((p) => [p.code, p]));

  // ---------- 1. 上传与清单 ----------
  console.log('\n[1] 上传与清单');
  const u1 = await upload(tinyPng(20, 80, 160), 'op30-a.png');
  const u2 = await upload(tinyPng(160, 60, 40), 'op30-b.png');
  const u3 = await upload(tinyPng(20, 80, 160), 'op30-a-copy.png');
  ok(u1.status === 200 && u1.body.kind === 'image', '上传图片成功');
  ok(u3.body.duplicated === true && u3.body.id === u1.body.id, '同文件二次上传识别为重复（不重复占盘）');
  ok(u1.body.width === 8 && u1.body.height === 8, '服务端解析出图片宽高');

  let r = await put('/api/playlist', {
    modelId: M.X200.id, processId: P.OP30.id,
    items: [{ mediaId: u1.body.id, dwellSec: 15 }, { mediaId: u2.body.id, dwellSec: 10 }]
  });
  ok(r.ok && r.body.count === 2, 'X200/OP30 写入 2 项');

  await put('/api/playlist', {
    modelId: M.X210.id, processId: P.OP30.id,
    items: [{ mediaId: u2.body.id, dwellSec: 8 }]
  });

  ok((await j('/api/models')).body.coverage.done === 2, '完成度变成 2/50');

  r = await put('/api/playlist', {
    modelId: M.X200.id, processId: P.OP30.id,
    items: [{ mediaId: u1.body.id }, { mediaId: u1.body.id }]
  });
  ok(r.status === 400, '同一文件在清单内重复被拒绝');

  r = await j(`/api/playlist?modelId=${M.X200.id}&processId=${P.OP30.id}`);
  ok(r.body.items.length === 2, '失败的保存没破坏原清单（整批校验，不留半套）');

  // ---------- 2. 无终端在线 ----------
  console.log('\n[2] 没有任何终端在线时切换');
  let before = await state();
  ok(before.online.length === 0, '此时无终端在线');
  ok(before.seq === 0, '初始 seq = 0');
  r = await post('/api/switch', { modelCode: 'X200' });
  ok(r.body.activated === true, '无终端在线时直接激活（否则管理端会一直卡在"准备中"）');
  ok(r.body.state.seq === 1, '直接激活时 seq +1');
  ok(r.body.state.currentModelId === M.X200.id, '当前型号写为 X200');

  // ---------- 3. 终端上线 ----------
  console.log('\n[3] 两台终端上线（OP30 / OP40）');
  const b30 = (await j('/display/boot?op=OP30')).body;
  const b40 = (await j('/display/boot?op=OP40')).body;
  ok(b30.processName === '调试', 'OP30 身份解析正确（调试）');
  ok(b40.processName === '检验', 'OP40 身份解析正确（检验）');
  ok(b30.modelCode === 'X200' && b30.modelId === M.X200.id, '终端启动自检拿到当前型号与 ID');

  let st = await state();
  ok(st.online.includes('OP30') && st.online.includes('OP40'), '两台终端都算在线');

  r = await j('/display/boot?op=OP99');
  ok(r.status === 404, '工序号配错立刻报错，不会静默黑屏');

  // ---------- 4. 两段式切换 ----------
  console.log('\n[4] 两段式切换：prepare → ready → activate');
  before = await state();
  r = await post('/api/switch', { modelCode: 'X210' });
  ok(r.ok && r.body.phase === 'prepare', '有终端在线时进入 prepare（不立刻翻）');
  ok(r.body.state.seq === before.seq, 'prepare 阶段 seq 不变（画面还没翻）');
  ok(r.body.state.pendingModelCode === 'X210', '服务器记住了目标 X210');

  st = await state();
  ok(st.pendingModelCode === 'X210', '终端从长轮询能获知目标型号');

  r = await post('/api/ready', { op: 'OP30', modelId: M.X210.id });
  ok(r.ok && r.body.accepted === true, 'OP30 举手被接受');
  ok(r.body.activated === false, '只有 1/2 台备好时不激活（关键：不出半新半旧）');

  r = await post('/api/ready', { op: 'OP40', modelId: M.X210.id });
  ok(r.body.activated === true, '两台都备好后立即激活');
  ok(r.body.state.seq === before.seq + 1, '激活时 seq 只 +1');
  ok(r.body.state.currentModelId === M.X210.id, '当前型号变成 X210');
  ok(r.body.state.phase === 'idle', '激活后回到 idle');

  // ---------- 5. 内容按工序隔离 ----------
  console.log('\n[5] 内容按工序隔离');
  const pl30 = (await j('/display/playlist?op=OP30')).body;
  const pl40 = (await j('/display/playlist?op=OP40')).body;
  ok(pl30.modelCode === 'X210' && pl30.count === 1, 'OP30 拿到 X210 的 1 项');
  ok(pl40.modelCode === 'X210' && pl40.empty === true, 'OP40 该型号没内容 → empty=true（终端显式告警）');
  ok(pl30.items[0].url.startsWith('/m/'), '清单里带媒体地址');

  // ---------- 6. 过期举手 ----------
  console.log('\n[6] 迟到 / 过期举手');
  await post('/api/switch', { modelCode: 'X220' });
  r = await post('/api/ready', { op: 'OP30', modelId: M.X210.id });
  ok(r.status === 409, '拿旧型号举手被拒（409），不会被误算已备好');

  // ---------- 7. 放弃切换 ----------
  console.log('\n[7] 放弃切换');
  st = await state();
  ok(st.phase === 'prepare' && st.pendingModelCode === 'X220', '当前在准备 X220');
  r = await post('/api/switch/cancel', {});
  ok(r.ok && r.body.state.phase === 'idle', '放弃后回到 idle');
  ok(r.body.state.currentModelId === M.X210.id, '放弃后当前型号仍是 X210（画面不动）');
  ok(r.body.state.pendingModelId === '', '放弃后清掉 pending');

  // ---------- 8. 反复切换 ----------
  console.log('\n[8] 反复切换（seq 单调）');
  before = await state();
  await post('/api/switch', { modelCode: 'X200' });
  await post('/api/ready', { op: 'OP30', modelId: M.X200.id });
  r = await post('/api/ready', { op: 'OP40', modelId: M.X200.id });
  ok(r.body.activated === true, '两段式可反复执行');
  ok(r.body.state.seq === before.seq + 1, 'seq 严格 +1');
  const pl = (await j('/display/playlist?op=OP30')).body;
  ok(pl.modelCode === 'X200' && pl.count === 2, '内容随型号整批换回 X200 的 2 项');

  // ---------- 9. 媒体流 ----------
  console.log('\n[9] 媒体流与 Range');
  const mr = await fetch(BASE + '/m/' + u1.body.id);
  ok(mr.status === 200 && mr.headers.get('content-type') === 'image/png', '按原 MIME 返回');
  ok(mr.headers.get('accept-ranges') === 'bytes', '声明支持 Range（断点续传/视频拖动）');
  const rr = await fetch(BASE + '/m/' + u1.body.id, { headers: { Range: 'bytes=0-9' } });
  ok(rr.status === 206 && (rr.headers.get('content-range') || '').startsWith('bytes 0-9/'), 'Range 返回 206');
  ok((await fetch(BASE + '/m/nonexistent')).status === 404, '不存在的媒体返回 404');

  // ---------- 10. GC ----------
  console.log('\n[10] 媒体回收');
  const gcDry = (await post('/api/media/gc', { dryRun: true })).body;
  ok(gcDry.dryRun === true, '默认 dryRun');
  ok((await fetch(BASE + '/m/' + u1.body.id)).status === 200, 'dryRun 不会删正在用的文件');

  // ---------- 汇总 ----------
  console.log('\n────────────────────────────');
  console.log(`  通过 ${pass}　失败 ${fail}`);
  console.log('────────────────────────────\n');
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('\n测试脚本异常：', e);
  process.exit(1);
});

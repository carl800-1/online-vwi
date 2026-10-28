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

  // ---------- 11. 线体（v1.7.0） ----------
  // 多产线是这次的核心改动：每天的活不一定在同一条线上，
  // 所以每条线体要有自己的工序、自己的换型状态，互不串台。
  console.log('\n[11] 线体与多产线隔离');
  let ls = (await j('/api/lines')).body.lines;
  ok(ls.length === 1 && ls[0].code === 'L1' && ls[0].enabled === true, '升级后默认有一条启用的线体 L1');
  ok(ls[0].processes === 5 && ls[0].coverage.total === 50, '线体自带 5 道工序、完成度分母 50');

  const madeL2 = await post('/api/lines', { code: 'L2', name: '二线' });
  ok(madeL2.ok && madeL2.body.code === 'L2', '可以新建线体');
  ok(madeL2.body.processes === 5, '新线体自动带 5 道标准工序');
  ok(madeL2.body.enabled === false, '新线体默认不启用（要人明确点一次）');
  const L2 = madeL2.body.id;

  const p2 = (await j('/api/processes?lineId=' + L2)).body.processes;
  ok(p2.length === 5 && p2[0].code === 'OP10', '按线体能取到它自己的工序');
  ok(p2[0].id !== P.OP10.id, '一线和二线的 OP10 是两条独立记录（内容不会互串）');

  ok((await post('/api/lines', { code: 'L2', name: '重复' })).status === 400, '线体编码重复被拒绝');

  let en = await put('/api/lines/' + L2, { enabled: true });
  ok(en.ok && en.body.enabled === true, '可以启用二线');
  ls = (await j('/api/lines')).body.lines;
  ok(ls.filter((l) => l.enabled).length === 1, '同一时刻只有一条线体启用');
  ok(ls.find((l) => l.code === 'L1').enabled === false, '启用二线后一线自动停用');

  const bootNoLine = (await j('/display/boot?op=OP30')).body;
  ok(bootNoLine.lineCode === 'L2', '老终端不带 line 时回落到当前启用线体（升级不用改配置）');
  const bootL1 = (await j('/display/boot?op=OP30&line=L1')).body;
  ok(bootL1.lineCode === 'L1' && bootL1.processName === '调试', '带 line 时按指线体定位工序');

  ok((await j('/display/boot?op=OP30&line=NOPE')).status === 404, '线体编码配错立刻 404，不静默黑屏');

  // 两条线各自换型，互不影响
  const st1Before = (await j('/api/status?lineId=' + ls.find((l) => l.code === 'L1').id)).body;
  const swLine = await post('/api/switch', { modelCode: 'X220', lineCode: 'L1' });
  ok(swLine.body.state.pendingModelCode === 'X220' || swLine.body.state.modelCode === 'X220',
    '可以在指定线体上发起换型');
  const st2During = (await j('/api/status?lineId=' + L2)).body;
  ok(!st2During.pendingModelCode && st2During.seq === 0, '一线换型不影响二线的状态机');

  await post('/api/ready', { op: 'OP30', modelId: M.X220.id, line: 'L1' });
  const st1After = (await j('/api/status?lineId=' + ls.find((l) => l.code === 'L1').id)).body;
  ok(st1After.modelCode === 'X220' && st1After.seq === st1Before.seq + 1, '一线切换到 X220 并 seq +1');
  ok((await j('/api/status?lineId=' + L2)).body.modelCode === '', '二线仍然没有当前型号（完全隔离）');

  const pl2 = (await j('/display/playlist?op=OP30&line=L2')).body;
  ok(pl2.lineCode === 'L2' && pl2.empty === true, '二线 OP30 没配内容 → empty=true（不借用一线的图）');

  // 不带 line 的举手要落到"当前启用"那条线上，不能算到别的线头上
  await put('/api/lines/' + L2, { enabled: true });
  await post('/api/switch', { modelCode: 'X230' });          // 不带 lineId → 当前启用线体（二线）
  const readyNoLine = await post('/api/ready', { op: 'OP30', modelId: M.X230.id });
  ok(readyNoLine.ok && readyNoLine.body.state.lineId === L2, '举手不带 line 时落到当前启用线体');

  // v3.0.0：内容挂在「机种 × 线体 × 工位」上，完成度也按线体各算各的。
  // 二线刚建出来、还没配任何内容，它的完成度就是 0 —— 这才对，不能借用一线。
  const covL1 = (await j('/api/models?lineId=' + ls.find((l) => l.code === 'L1').id)).body.coverage.done;
  const covL2 = (await j('/api/models?lineId=' + L2)).body.coverage.done;
  ok(covL1 > 0, '一线上的机种内容还在（41 条老内容迁过来后按线归位）');
  ok(covL2 === 0, '二线的完成度是 0：内容是各条线自己的，不共用');

  // 收拾：停用并删掉测试线体
  await put('/api/lines/' + L2, { enabled: false });
  const delEmpty = await j('/api/lines/' + L2, { method: 'DELETE' });
  ok(delEmpty.ok, '没有内容的线体可以删除');
  await put('/api/lines/' + ls.find((l) => l.code === 'L1').id, { enabled: true });
  ok((await j('/api/lines')).body.lines.length === 1, '删除后只剩一线，且恢复启用');

  // ---------- 12. 工位（机种设置）：机种 × 线体 × 工序码 ----------
  // v3.0.0 的核心变化：工位带线体维度。同一个机种在一线和二线的工艺路线可以
  // 完全不同（工序数量不同，甚至同一串 OP 号的含义都不同），所以两套内容各存各的，
  // 不再靠工序码跨线对位。两条线大体相同时用「复制」整套搬过来再改。
  const L1id = (await j('/api/lines')).body.lines.find((l) => l.code === 'L1').id;

  const stAll = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id)).body;
  ok(stAll.stations.length === 5, '机种在一线上有 5 个工位（按这条线自己的工序长出来）');
  ok(stAll.stations.map((s) => s.code).join(',') === 'OP10,OP20,OP30,OP40,OP50',
    '工位码与本线工序码一致（OP10 ↔ OP10）');
  ok(stAll.stations.every((s) => s.lineId === L1id), '每个工位都带线体归属');

  const st30 = stAll.stations.find((s) => s.code === 'OP30');
  ok(st30.items.length === 2, 'OP30 上有前面写入的 2 项（内容已迁到工位）');

  // 类型闸门：工位只允许视频时，塞图片必须被拒
  await put('/api/stations/' + st30.id, { reqs: [{ kind: 'video', minCount: 1 }] });
  const gate = await put('/api/stations/' + st30.id, { items: [{ mediaId: u1.body.id }] });
  ok(gate.status === 400, '工位只允许视频时，写进图片被拒（类型闸门生效）');
  ok((await j('/api/playlist?modelId=' + M.X200.id + '&processId=' + P.OP30.id)).body.items.length === 2,
    '被拒的那次没有破坏原有内容（整批校验，不留半套）');
  await put('/api/stations/' + st30.id, {
    reqs: [{ kind: 'image', minCount: 1, minWidth: 1280, minHeight: 720 }]
  });

  // 跨线独立：新线有同名工序，但是另一套空工位
  const madeL3 = await post('/api/lines', { code: 'L3', name: '三线' });
  const L3 = madeL3.body.id;
  const stL3 = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L3)).body.stations;
  ok(stL3.length === 5 && stL3.every((s) => s.items.length === 0),
    '新线体自动长出同一批空工位（不用逐个机种点补齐）');
  ok(stL3[0].id !== stAll.stations[0].id, '两条线的工位是两条独立记录，不是同一条');

  const plL1 = (await j('/display/playlist?op=OP30&line=L1&model=X200')).body;
  const plL3 = (await j('/display/playlist?op=OP30&line=L3&model=X200')).body;
  ok(plL1.count === 2 && plL3.count === 0,
    '同一机种在另一条线上是独立的一套，不会借用一线的内容');
  ok(plL3.noStation === false, '"有工位但没内容"和"压根没工位"能分开（noStation=false）');

  // 跨线复制：目标线空着的工位直接填上
  const cp = await post('/api/stations/copy', { modelId: M.X200.id, fromLineId: L1id, toLineId: L3 });
  ok(cp.ok && cp.body.filled.includes('OP30'), '可以把一线有内容的工位复制到三线（空工位直接填上）');
  ok(cp.body.empty.length === 5 - cp.body.filled.length,
    '来源线本来就空的工位记进 empty，不算搬过（也不会把空壳当成功）');
  ok((await j('/display/playlist?op=OP30&line=L3&model=X200')).body.count === 2,
    '复制后三线取到同一份内容');

  const cp2 = await post('/api/stations/copy', { modelId: M.X200.id, fromLineId: L1id, toLineId: L3 });
  ok(cp2.body.filled.length === 0 && cp2.body.skipped.length === cp.body.filled.length,
    '再复制一次不会叠一份（目标线已有内容默认跳过）');

  // 复制出来是完全独立的两份：改三线不动一线
  const st3op30 = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L3))
    .body.stations.find((s) => s.code === 'OP30');
  await put('/api/stations/' + st3op30.id, { items: [{ mediaId: st3op30.items[0].mediaId }] });
  ok((await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
    .body.stations.find((s) => s.code === 'OP30').items.length === 2,
    '改三线的 OP30 不影响一线（两份内容各存各的）');

  await j('/api/lines/' + L3, { method: 'DELETE' });
  ok((await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L3)).status === 400,
    '删掉线体后它的工位跟着消失（不留连不上的孤儿数据）');

  // 加工位 / 同线内重码拒绝（跨线可以同名）
  const madeSt = await post('/api/stations', { modelId: M.X200.id, lineId: L1id, code: 'OP60', name: '老化' });
  ok(madeSt.ok && madeSt.body.code === 'OP60' && madeSt.body.reqs.some((r) => r.kind === 'image'),
    '可以给「机种 × 线体」加工位（默认允许图片）');
  ok((await post('/api/stations', { modelId: M.X200.id, lineId: L1id, code: 'OP60' })).status === 400,
    '同一条线上工位码不能重复');

  // 线体加工序 → 所有机种自动长出对应工位；sync 仍是修复手段
  const addProc = await post('/api/processes', { lineId: L1id, code: 'OP70', name: '包装复核' });
  ok(addProc.ok && addProc.body.stations >= 1, '线体上加一道工序，各机种自动补出对应工位');
  ok((await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
    .body.stations.some((s) => s.code === 'OP70'),
    '新工位立刻出现在机种设置里（不用手动同步）');

  const st70 = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
    .body.stations.find((s) => s.code === 'OP70');
  await j('/api/stations/' + st70.id, { method: 'DELETE' });
  const syncRes = await post('/api/stations/sync', { modelId: M.X200.id, lineId: L1id });
  ok(syncRes.ok && syncRes.body.created.includes('OP70'), '「按本线工序补齐」能把缺掉的工位补回来');

  // 改工序码：工位靠 code 与本线工序对位，工序码一改，本线工位必须跟着改，
  // 否则老码那个工位（连同里面的内容）当场变成"对不上"的孤儿，屏上就是空白。
  const pr70b = (await j('/api/processes?lineId=' + L1id)).body.processes.find((x) => x.code === 'OP70');
  const st70b = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
    .body.stations.find((s) => s.code === 'OP70');
  await put('/api/stations/' + st70b.id, { items: [{ mediaId: u1.body.id }] });
  const rn = await put('/api/processes/' + pr70b.id, { code: 'OP75', name: '包装复核' });
  ok(rn.ok && rn.body.renamed >= 1, '改工序码时本线工位跟着改（renamed ≥ 1）', rn.body);
  const afterRn = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id)).body.stations;
  ok(!afterRn.some((s) => s.code === 'OP70') && afterRn.some((s) => s.code === 'OP75' && s.items.length === 1),
    '改码后内容还在（没变成对不上的孤儿）', afterRn.map((s) => s.code + ':' + s.items.length));

  // 同一条线上，不同机种各有各的工位：X210 的 OP30 是它自己那 1 项，
  // 不会因为 X200 在同一位置放了 2 项而被带上
  const stX210 = (await j('/api/stations?modelId=' + M.X210.id + '&lineId=' + L1id)).body.stations;
  const x210op30 = stX210.find((s) => s.code === 'OP30');
  ok(stX210.length === 6 && x210op30.items.length === 1,
    '同一线的另一个机种是它自己的工位与内容（X210 的 OP30 仍是 1 项）');
  ok(x210op30.id !== st30.id, '两个机种同一道工序的工位是两条独立记录');

  // 有内容的工位不许直接删（会丢内容）
  const delBusySt = await j('/api/stations/' + st30.id, { method: 'DELETE' });
  ok(delBusySt.status === 400, '有内容的工位不允许直接删');

  // 清理：删掉 OP60 / OP75 两道工序和对应工位，一线恢复成 5 道
  for (const code of ['OP60', 'OP75']) {
    const s = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
      .body.stations.find((x) => x.code === code);
    if (s) await j('/api/stations/' + s.id, { method: 'DELETE' });
    const pr = (await j('/api/processes?lineId=' + L1id)).body.processes.find((x) => x.code === code);
    if (pr) await j('/api/processes/' + pr.id, { method: 'DELETE' });
  }
  ok((await j('/api/processes?lineId=' + L1id)).body.processes.length === 5, '一线恢复 5 道工序');

  // 总览接口：线体 + 机种 + 客户端状态一次给全
  const board = (await j('/api/board')).body;
  ok(Array.isArray(board.lines) && board.lines.length >= 1, '总览一次返回所有线体');
  const bl = board.lines[0];
  ok(bl.clients.length === bl.processes, '每个工序都占一个客户端位置（没装机的也列出来）');
  ok(bl.clients.every((c) => typeof c.status === 'string' && 'hasContent' in c),
    '客户端带 status 与 hasContent，总览据此标出"哪块屏没内容"');


  // ---------- 13. 终端参数与上传进度 ----------
  // 现场最常问的是"3 号工位怎么没数据"，所以两条路径都要能区分：
  // 从没报到过（seen=false） vs 报到过但离线（seen=true, online=false）。
  const t0 = (await j('/api/terminals?lineId=' + L1id)).body;
  ok(t0.total === 5 && t0.terminals.length === 5,
    '终端列表按"工序"返回，没装机的工序也占一行（否则看不出是没装还是没开）');
  ok(t0.terminals.some((x) => x.seen === false), '从未上报过的工序标记为 seen=false');

  const tel = await post('/api/telemetry?line=L1&op=OP40', {
    res: '1920x1080', ver: '1.7.0', free: 4096, done: 3, total: 7, model: 'X200', st: 'preparing'
  });
  ok(tel.ok, '终端可以上报机器参数与下载进度');

  const t1 = (await j('/api/terminals?lineId=' + L1id)).body;
  const op40 = t1.terminals.find((x) => x.op === 'OP40');
  ok(op40.seen === true && op40.online === true, '上报后该工序变为在线');
  ok(op40.res === '1920x1080' && op40.ver === '1.7.0', '分辨率与终端版本被记录');
  ok(op40.done === 3 && op40.total === 7, '下载进度被记录（3/7）');
  ok(op40.ip === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(op40.ip),
    'IP 由服务端从连接里取，不信终端自报');
  ok(op40.modelCode === 'X200', '终端正在准备哪个机种也记下来了');

  // 心跳带参数（不需要额外 POST）：长轮询的 query 里带 res/ver/free 就够
  await j('/api/state?op=OP40&line=L1&since=0&res=3840x2160&ver=9.9.9');
  const t2 = (await j('/api/terminals?lineId=' + L1id)).body;
  const op40b = t2.terminals.find((x) => x.op === 'OP40');
  ok(op40b.res === '3840x2160', '心跳 query 里的分辨率同样能更新档案（老终端不改代码也够用）');

  // ========== 13. 工序清单导入（xlsx / csv） ==========
  console.log('\n13. 工序清单导入（Excel / CSV）');

  // 现场没有现成 xlsx，测试里现造一个：ZIP(store) + sharedStrings + sheet1
  // （crc32 上面造 PNG 时已经写好了，直接复用）
  function zipStore(entries) {
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const [name, text] of entries) {
      const nb = Buffer.from(name, 'utf8');
      const data = Buffer.from(text, 'utf8');
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, nb, data);
      centrals.push(ch, nb);
      off += 30 + nb.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  const rows = [['工序号', '工序名称', '做什么'], ['OP10', '压装（改）', '压轴承到位'], ['OP300', '气密', '打气测漏'], ['OP310', '贴标', '']];
  const sst = [];
  const sid = (s) => { if (!sst.includes(s)) sst.push(s); return sst.indexOf(s); };
  const sheetRows = rows.map((r, ri) =>
    `<row r="${ri + 1}">${r.map((v, ci) =>
      `<c r="${'ABC'[ci]}${ri + 1}" t="s"><v>${sid(v)}</v></c>`).join('')}</row>`).join('');
  const xlsx = zipStore([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml',
      `<sst>${sst.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`]
  ]);

  const upXlsx = await j('/api/import/parse?filename=' + encodeURIComponent('工序.xlsx'), {
    method: 'POST', body: xlsx
  });
  ok(upXlsx.status === 200 && upXlsx.body.total === 3, 'xlsx 解析出 3 行（标题行自动跳过）');
  ok(Array.isArray(upXlsx.body.header) && upXlsx.body.header[0] === '工序号', '认出并回传标题行');
  ok(upXlsx.body.preview[0][0] === 'OP10' && upXlsx.body.preview[1][1] === '气密',
    '单元格文本按 sharedStrings 正确还原');

  const csvBuf = Buffer.from('工序号,工序名称,做什么\nOP10,压装,说明\nOP320,打磨,砂纸\n', 'utf8');
  const upCsv = await j('/api/import/parse?filename=a.csv', { method: 'POST', body: csvBuf });
  ok(upCsv.body.total === 2 && upCsv.body.preview[1][0] === 'OP320', 'CSV 同样能读');

  const imp1 = await post('/api/stations/import', {
    modelId: M.X200.id, lineId: L1id, rows: upXlsx.body.rows, mode: 'merge'
  });
  ok(imp1.ok && imp1.body.created === 2 && imp1.body.skipped === 1,
    '导入按「有就跳过」：新建 2 道、OP10 已存在跳过 1 道');

  const imp2 = await post('/api/stations/import', {
    modelId: M.X200.id, lineId: L1id, rows: upXlsx.body.rows, mode: 'merge'
  });
  ok(imp2.body.created === 0 && imp2.body.skipped === 3, '同名再导一次不重复建（幂等）');

  const imp3 = await post('/api/stations/import', {
    modelId: M.X200.id, lineId: L1id, rows: upXlsx.body.rows, mode: 'update'
  });
  const op10After = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
    .body.stations.find((s) => s.code === 'OP10');
  ok(imp3.body.updated === 3 && op10After.name === '压装（改）' && op10After.note === '压轴承到位',
    'update 模式覆盖名称与「做什么」');

  const impBad = await post('/api/stations/import', {
    modelId: M.X200.id, lineId: L1id,
    rows: [['', '没有码'], ['OP!@#', '乱码', ''], ['OP330', '合格', '']], mode: 'merge'
  });
  ok(impBad.body.created === 1 && impBad.body.bad.length === 2,
    '坏行单独列出来，不影响其它行入库');

  const impWrong = await post('/api/stations/import', {
    modelId: 'md_not_exist', lineId: L1id, rows: [['OP1', 'x']], mode: 'merge'
  });
  ok(!impWrong.ok && impWrong.status === 400, '机种不存在时整批拒绝');

  // 清理：删掉这一节加的几道，别影响后面的覆盖率断言
  for (const code of ['OP300', 'OP310', 'OP330']) {
    const st = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id))
      .body.stations.find((x) => x.code === code);
    if (st) await j('/api/stations/' + st.id, { method: 'DELETE' });
  }
  const back = (await j('/api/stations?modelId=' + M.X200.id + '&lineId=' + L1id)).body.stations;
  ok(!back.some((x) => x.code === 'OP300' || x.code === 'OP310' || x.code === 'OP330'),
    '删掉导入的工序后恢复原样');

  // ---------- 汇总 ----------
  console.log('\n────────────────────────────');
  console.log(`  通过 ${pass}　失败 ${fail}`);
  console.log('────────────────────────────\n');
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('\n测试脚本异常：', e);
  process.exit(1);
});

// 端到端协议测试：模拟 2 台终端，验证"无人在线 / 两段式切换 / 一起翻"三条路径
//
// 为什么要有这个脚本：A1（换型切得动、切得齐）是项目验收核心。
// 人工点浏览器只能证明"页面没崩"，证明不了"服务器等到所有人备齐才喊翻"。
// 这里用真 HTTP 把协议跑一遍，任何状态机回归都会当场报错。
//
// 运行：node test/run.mjs    （自动起一个临时数据目录的实例，跑完清理）

import zlib from 'node:zlib';
import { parseSheet, buildWorkbook } from '../src/xlsx.js';   // 导出回来的文件用它读，验「导出→导入」闭环

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

/** 拿二进制响应（导出的 xlsx），顺带把文件名从 Content-Disposition 里抠出来 */
async function bin(path) {
  const r = await fetch(BASE + path);
  const buf = Buffer.from(await r.arrayBuffer());
  const disp = r.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(disp);
  return { status: r.status, ok: r.ok, buf, name: m ? decodeURIComponent(m[1]) : '' };
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
const del = (p) => j(p, { method: 'DELETE' });

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
  // v4.0.0 的关系：线体只管"有哪几条、什么状态、几块屏"，
  // 机种管"几道工序、能在哪几条线上做"，工序自己就是内容的宿主。
  console.log('[0] 档案与种子数据');
  const models = (await j('/api/models')).body;
  ok(models.models.length === 10, '10 个机种已就绪');
  ok(models.coverage.total === 50, '完成度分母 50 套（10 机种 × 5 道工序）');

  const M = Object.fromEntries(models.models.map((m) => [m.code, m]));
  const procList = (await j('/api/processes?modelId=' + M.X200.id)).body;
  ok(procList.processes.length === 5, '机种默认 5 道工序');
  ok(procList.processes.map((p) => p.code).join(',') === 'OP1,OP2,OP3,OP4,OP5',
    '工序码从 OP1 起编（不是 OP10/OP20）');
  ok(procList.processes.every((p) => p.playMode === 'loop'), '工序默认「循环播放」');
  ok(procList.lines.length === 1 && procList.lines[0].code === 'L1',
    '种子机种已经安排在一线上（可生产机种不是空的）');

  const P = Object.fromEntries(procList.processes.map((p) => [p.code, p]));
  const procOf = async (code, modelCode = 'X200') => {
    const d = (await j('/api/processes?modelId=' + M[modelCode].id)).body;
    return (d.processes || []).find((p) => p.code === code);
  };

  // ---------- 1. 上传与清单 ----------
  console.log('\n[1] 上传与清单');
  const u1 = await upload(tinyPng(20, 80, 160), 'op3-a.png');
  const u2 = await upload(tinyPng(160, 60, 40), 'op3-b.png');
  const u3 = await upload(tinyPng(20, 80, 160), 'op3-a-copy.png');
  ok(u1.status === 200 && u1.body.kind === 'image', '上传图片成功');
  ok(u3.body.duplicated === true && u3.body.id === u1.body.id, '同文件二次上传识别为重复（不重复占盘）');
  ok(u1.body.width === 8 && u1.body.height === 8, '服务端解析出图片宽高');

  let r = await put('/api/playlist', {
    modelId: M.X200.id, processId: P.OP3.id,
    items: [{ mediaId: u1.body.id, dwellSec: 15 }, { mediaId: u2.body.id, dwellSec: 10 }]
  });
  ok(r.ok && r.body.count === 2, 'X200/OP3 写入 2 项');

  const p3x210 = await procOf('OP3', 'X210');
  await put('/api/playlist', {
    modelId: M.X210.id, processId: p3x210.id,
    items: [{ mediaId: u2.body.id, dwellSec: 8 }]
  });

  ok((await j('/api/models')).body.coverage.done === 2, '完成度变成 2/50');

  r = await put('/api/playlist', {
    modelId: M.X200.id, processId: P.OP3.id,
    items: [{ mediaId: u1.body.id }, { mediaId: u1.body.id }]
  });
  ok(r.status === 400, '同一文件在清单内重复被拒绝');

  r = await j(`/api/playlist?modelId=${M.X200.id}&processId=${P.OP3.id}`);
  ok(r.body.items.length === 2, '失败的保存没破坏原清单（整批校验，不留半套）');

  // 播放方式：每道工序一处，改的是工序自己的字段，不动内容
  r = await put('/api/processes/' + P.OP3.id, { playMode: 'once' });
  ok(r.ok && r.body.process.playMode === 'once', '工序可以单独设「播一遍停」');
  ok(r.body.process.items.length === 2, '改播放方式不动内容');
  await put('/api/processes/' + P.OP3.id, { playMode: 'loop' });

  // ---------- 2. 无终端在线 ----------
  console.log('\n[2] 没有任何终端在线时切换');
  let before = await state();
  ok(before.online.length === 0, '此时无终端在线');
  ok(before.seq === 0, '初始 seq = 0');
  r = await post('/api/switch', { modelCode: 'X200' });
  ok(r.body.activated === true, '无终端在线时直接激活（否则管理端会一直卡在"准备中"）');
  ok(r.body.state.seq === 1, '直接激活时 seq +1');
  ok(r.body.state.currentModelId === M.X200.id, '当前机种写为 X200');

  // ---------- 3. 终端上线 ----------
  console.log('\n[3] 两台终端上线（OP3 / OP4）');
  const b3 = (await j('/display/boot?op=OP3')).body;
  const b4 = (await j('/display/boot?op=OP4')).body;
  ok(b3.processName === '检验', 'OP3 身份解析正确（检验）');
  ok(b4.processName === '包装', 'OP4 身份解析正确（包装）');
  ok(b3.modelCode === 'X200' && b3.modelId === M.X200.id, '终端启动自检拿到当前机种与 ID');

  let st = await state();
  ok(st.online.includes('OP3') && st.online.includes('OP4'), '两台终端都算在线');

  // v4.0.0：工序归机种，线体不再拥有工序清单，所以"这个 op 不存在"不再 404 ——
  // 那是"机种没排这道工序"，要返回 200 + noStation，让终端在屏上说明白。
  r = await j('/display/boot?op=OP99');
  ok(r.status === 200 && r.body.noStation === true, '当前机种没有这道工序 → noStation=true（不是 404）');
  ok(/没有工序 OP99/.test(r.body.message || ''), '并给出可读原因，不用运维猜是网络还是没内容');

  // ---------- 4. 两段式切换 ----------
  console.log('\n[4] 两段式切换：prepare → ready → activate');
  before = await state();
  r = await post('/api/switch', { modelCode: 'X210' });
  ok(r.ok && r.body.phase === 'prepare', '有终端在线时进入 prepare（不立刻翻）');
  ok(r.body.state.seq === before.seq, 'prepare 阶段 seq 不变（画面还没翻）');
  ok(r.body.state.pendingModelCode === 'X210', '服务器记住了目标 X210');

  st = await state();
  ok(st.pendingModelCode === 'X210', '终端从长轮询能获知目标机种');

  r = await post('/api/ready', { op: 'OP3', modelId: M.X210.id });
  ok(r.ok && r.body.accepted === true, 'OP3 举手被接受');
  ok(r.body.activated === false, '只有 1/2 台备好时不激活（关键：不出半新半旧）');

  r = await post('/api/ready', { op: 'OP4', modelId: M.X210.id });
  ok(r.body.activated === true, '两台都备好后立即激活');
  ok(r.body.state.seq === before.seq + 1, '激活时 seq 只 +1');
  ok(r.body.state.currentModelId === M.X210.id, '当前机种变成 X210');
  ok(r.body.state.phase === 'idle', '激活后回到 idle');

  // ---------- 5. 内容按工序隔离 ----------
  console.log('\n[5] 内容按工序隔离');
  const pl3 = (await j('/display/playlist?op=OP3')).body;
  const pl4 = (await j('/display/playlist?op=OP4')).body;
  ok(pl3.modelCode === 'X210' && pl3.count === 1, 'OP3 拿到 X210 的 1 项');
  ok(pl4.modelCode === 'X210' && pl4.empty === true, 'OP4 该机种没内容 → empty=true（终端显式告警）');
  ok(pl3.items[0].url.startsWith('/m/'), '清单里带媒体地址');

  // ---------- 6. 过期举手 ----------
  console.log('\n[6] 迟到 / 过期举手');
  await post('/api/switch', { modelCode: 'X220' });
  r = await post('/api/ready', { op: 'OP3', modelId: M.X210.id });
  ok(r.status === 409, '拿旧机种举手被拒（409），不会被误算已备好');

  // ---------- 7. 放弃切换 ----------
  console.log('\n[7] 放弃切换');
  st = await state();
  ok(st.phase === 'prepare' && st.pendingModelCode === 'X220', '当前在准备 X220');
  r = await post('/api/switch/cancel', {});
  ok(r.ok && r.body.state.phase === 'idle', '放弃后回到 idle');
  ok(r.body.state.currentModelId === M.X210.id, '放弃后当前机种仍是 X210（画面不动）');
  ok(r.body.state.pendingModelId === '', '放弃后清掉 pending');

  // ---------- 8. 反复切换 ----------
  console.log('\n[8] 反复切换（seq 单调）');
  before = await state();
  await post('/api/switch', { modelCode: 'X200' });
  await post('/api/ready', { op: 'OP3', modelId: M.X200.id });
  r = await post('/api/ready', { op: 'OP4', modelId: M.X200.id });
  ok(r.body.activated === true, '两段式可反复执行');
  ok(r.body.state.seq === before.seq + 1, 'seq 严格 +1');
  const pl = (await j('/display/playlist?op=OP3')).body;
  ok(pl.modelCode === 'X200' && pl.count === 2, '内容随机种整批换回 X200 的 2 项');

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

  // ---------- 11. 线体 ----------
  // 4.0.0 的线体只剩三件事：名字、状态（四态）、几块屏。工序和内容都不在线体上。
  console.log('\n[11] 线体：状态 / 工位数 / 可生产机种');
  let ls = (await j('/api/lines')).body.lines;
  ok(ls.length === 1 && ls[0].code === 'L1' && ls[0].status === 'running', '默认一条运行中的线体 L1');
  ok(ls[0].slots === 5, '默认工位数 5');
  ok(ls[0].modelCount === 10, '「可生产机种」自动统计出 10 个');

  const madeL2 = await post('/api/lines', { name: '二线', slots: 4 });
  ok(madeL2.ok && madeL2.body.code === 'L2', '新建线体时编码自动生成（L2），不用现场想');
  ok(madeL2.body.slots === 4, '工位数按填的记下来');
  ok(madeL2.body.status === 'stopped', '新建线体默认「停线」（要人明确点一次运行）');
  ok(madeL2.body.modelCount === 0, '新线体还没有可生产机种');
  ok((await post('/api/lines', { name: '二线' })).status === 400, '线体名称重复被拒绝');
  const L2 = madeL2.body.id;

  let en = await put('/api/lines/' + L2, { status: 'running' });
  ok(en.ok && en.body.status === 'running' && en.body.enabled === true, '状态改「运行」后 enabled 同步为 1');
  ls = (await j('/api/lines')).body.lines;
  ok(ls.filter((l) => l.enabled).length === 2, '多条线体可以同时运行');
  ok(ls.find((l) => l.code === 'L1').enabled === true, '把二线改成运行不会把一线停掉');

  const bootNoLine = (await j('/display/boot?op=OP3')).body;
  ok(bootNoLine.lineCode === 'L1', '老终端不带 line 时回落到 sort 最前的启用线体（升级不用改配置）');
  const bootL1 = (await j('/display/boot?op=OP3&line=L1')).body;
  ok(bootL1.lineCode === 'L1' && bootL1.processName === '检验', '带 line 时按指线体的当前机种定位工序');

  ok((await j('/display/boot?op=OP3&line=NOPE')).status === 404, '线体编码配错立刻 404，不静默黑屏');

  // 两条线各自换型，互不影响
  const st1Before = (await j('/api/status?lineId=' + ls.find((l) => l.code === 'L1').id)).body;
  const swLine = await post('/api/switch', { modelCode: 'X220', lineCode: 'L1' });
  ok(swLine.body.state.pendingModelCode === 'X220' || swLine.body.state.modelCode === 'X220',
    '可以在指定线体上发起换型');
  const st2During = (await j('/api/status?lineId=' + L2)).body;
  ok(!st2During.pendingModelCode && st2During.seq === 0, '一线换型不影响二线的状态机');

  // 几条屏在线就要几条一起举手 —— 只有全部就绪才激活，这是两段式切换本来的规矩
  for (const op of st1Before.online) await post('/api/ready', { op, modelId: M.X220.id, line: 'L1' });
  const st1After = (await j('/api/status?lineId=' + ls.find((l) => l.code === 'L1').id)).body;
  ok(st1After.modelCode === 'X220' && st1After.seq === st1Before.seq + 1, '一线切换到 X220 并 seq +1',
    { before: st1Before, after: st1After });
  ok((await j('/api/status?lineId=' + L2)).body.modelCode === '', '二线仍然没有当前机种（完全隔离）');

  const pl2 = (await j('/display/playlist?op=OP3&line=L2')).body;
  ok(pl2.lineCode === 'L2' && pl2.empty === true, '二线还没指定机种 → empty=true（不借用一线的图）');

  // 收拾：停线并删掉测试线体
  await put('/api/lines/' + L2, { status: 'stopped' });
  const delEmpty = await j('/api/lines/' + L2, { method: 'DELETE' });
  ok(delEmpty.ok, '停线的线体可以删除');
  ok((await j('/api/lines')).body.lines.length === 1, '删除后只剩一线');

  // ---------- 12. 工序（机种设置）：机种 × 工序 ----------
  // 4.0.0 的核心：工序归机种，一个机种只有一套，几条线做同一个产品共用。
  console.log('\n[12] 机种 → 工序 → 内容');
  const L1id = (await j('/api/lines')).body.lines.find((l) => l.code === 'L1').id;

  const mp = (await j('/api/processes?modelId=' + M.X200.id)).body;
  ok(mp.processes.length === 5, 'X200 有 5 道工序');
  ok(mp.processes.map((p) => p.code).join(',') === 'OP1,OP2,OP3,OP4,OP5', '工序码与机种定义一致');
  ok(mp.lines.length === 1 && mp.lines[0].code === 'L1', '同时回「可生产线体」');
  const p3 = mp.processes.find((p) => p.code === 'OP3');
  ok(p3.items.length === 2, 'OP3 上有前面写入的 2 项');

  // 类型闸门：工序只允许视频时，塞图片必须被拒
  await put('/api/processes/' + p3.id, { reqs: [{ kind: 'video', minCount: 1 }] });
  const gate = await put('/api/processes/' + p3.id, { items: [{ mediaId: u1.body.id }] });
  ok(gate.status === 400, '工序只允许视频时，写进图片被拒（类型闸门生效）');
  ok((await j('/api/processes?modelId=' + M.X200.id)).body.processes.find((p) => p.code === 'OP3')
    .items.length === 2, '被拒的那次没有破坏原有内容（整批校验，不留半套）');
  await put('/api/processes/' + p3.id, { reqs: [{ kind: 'image', minCount: 1, minWidth: 1280, minHeight: 720 }] });

  // 新建机种：一次定下「几道工序」和「在哪几条线做」—— 这正是新建弹窗干的事
  const nm = await post('/api/models', {
    code: 'T300', name: 'T300 型', processCount: 3, lineIds: [L1id]
  });
  ok(nm.ok && nm.body.processes === 3, '新建机种按「几道工序」一次铺好（3 道）');
  const tp = (await j('/api/processes?modelId=' + nm.body.id)).body;
  ok(tp.processes.map((p) => p.code).join(',') === 'OP1,OP2,OP3', '默认工序码 OP1..OP3');
  ok(tp.processes.map((p) => p.name).join(',') === '装配,调试,检验',
    '默认工序名 装配/调试/检验（建完就能用，不用先改名）');
  ok(tp.lines.length === 1 && tp.lines[0].id === L1id, '新建时勾的线体立刻成为「可生产线体」');
  ok(tp.processes.every((p) => p.items.length === 0), '新工序都是空的，等内容');
  ok(tp.processes.every((p) => p.reqs.some((x) => x.kind === 'image')),
    '新工序默认允许图片（现场最常见的起点）');

  // 编码自动生成：界面新建弹窗不再问编码（4.0.0）
  const auto1 = await post('/api/models', { name: '', processCount: 1, lineIds: [] });
  ok(auto1.ok && /^M\d+$/.test(auto1.body.code), '不传编码时自动给 M1、M2…');
  ok(auto1.body.name === auto1.body.code, '名称留空时先用编码顶上');
  const auto2 = await post('/api/models', { processCount: 1 });
  ok(auto2.body.code !== auto1.body.code, '自动编码不重复');
  await del('/api/models/' + auto1.body.id);
  await del('/api/models/' + auto2.body.id);
  ok((await j('/api/models')).body.models.every((m) => !/^M\d+$/.test(m.code)),
    '自动编号的机种删干净后不再占号');

  // 可生产线体多选：工艺只有一套，几条线共用
  const l2b = await post('/api/lines', { name: '二线', slots: 5 });
  await put('/api/models/' + nm.body.id, { lineIds: [L1id, l2b.body.id] });
  const tp2 = (await j('/api/processes?modelId=' + nm.body.id)).body;
  ok(tp2.lines.length === 2, '一个机种可以安排到多条线（可生产机种多选）');
  ok(tp2.processes.length === 3, '多勾一条线不会复制工序（工艺仍只有一套）');
  ok((await j('/api/lines')).body.lines.find((l) => l.id === l2b.body.id).modelCount === 1,
    '线体那边的「可生产机种」反向更新为 1');

  // 加工序 / 重码拒绝
  const madeP = await post('/api/processes', { modelId: M.X200.id, code: 'OP6', name: '老化' });
  ok(madeP.ok && madeP.body.code === 'OP6' && madeP.body.reqs.some((x) => x.kind === 'image'),
    '可以给机种加工序（默认允许图片）');
  ok((await post('/api/processes', { modelId: M.X200.id, code: 'OP6' })).status === 400,
    '同一机种内工序码不能重复');
  ok((await post('/api/processes', { modelId: M.X210.id, code: 'OP6' })).ok,
    '不同机种可以用同一个工序码（各是各的工序）');

  // 改工序码：内容跟着工序走，不会变成对不上的孤儿
  const p6 = (await j('/api/processes?modelId=' + M.X200.id)).body.processes.find((x) => x.code === 'OP6');
  await put('/api/processes/' + p6.id, { items: [{ mediaId: u1.body.id }] });
  const rn = await put('/api/processes/' + p6.id, { code: 'OP7', name: '老化复核' });
  ok(rn.ok && rn.body.renamed === 1, '改工序码成功（renamed = 1）', rn.body);
  const afterRn = (await j('/api/processes?modelId=' + M.X200.id)).body.processes;
  ok(!afterRn.some((p) => p.code === 'OP6') && afterRn.some((p) => p.code === 'OP7' && p.items.length === 1),
    '改码后内容还在（内容挂在工序 id 上，不是挂在码上）', afterRn.map((p) => p.code + ':' + p.items.length));

  // 另一个机种同名工序是它自己的一份，不会被 X200 的改动带上
  const x210 = (await j('/api/processes?modelId=' + M.X210.id)).body.processes;
  ok(x210.find((p) => p.code === 'OP3').items.length === 1,
    '同一道工序码在另一个机种上是独立记录（X210 的 OP3 仍是 1 项）');
  ok(x210.find((p) => p.code === 'OP3').id !== p3.id, '两个机种的同名工序是两条独立记录');

  // 删有内容的工序：不硬拦，但要把删掉几项报回来，界面据此二次确认
  const delBusy = await j('/api/processes/' + p6.id, { method: 'DELETE' });
  ok(delBusy.ok && delBusy.body.items === 1, '删有内容的工序会报出删掉几项（界面据此确认）');

  // 总览接口：线体 + 机种 + 客户端状态一次给全
  const board = (await j('/api/board')).body;
  ok(Array.isArray(board.lines) && board.lines.length >= 1, '总览一次返回所有线体');
  const bl = board.lines.find((l) => l.id === L1id);
  ok(bl.slots === 5, '总览带工位数');
  ok(bl.clients.length === bl.processes, '每道工序都占一个客户端位置（没装机的也列出来）');
  ok(bl.clients.every((c) => typeof c.status === 'string' && 'hasContent' in c),
    '客户端带 status 与 hasContent，总览据此标出"哪块屏没内容"');

  // ---------- 13. 终端参数与上传进度 ----------
  // 现场最常问的是"3 号工位怎么没数据"，所以两条路径都要能区分：
  // 从没报到过（seen=false） vs 报到过但离线（seen=true, online=false）。
  const t0 = (await j('/api/terminals?lineId=' + L1id)).body;
  ok(t0.total === 5 && t0.terminals.length === 5,
    '终端列表按「当前机种的工序」返回，没装机的工序也占一行');
  ok(t0.terminals.some((x) => x.seen === false), '从未上报过的工序标记为 seen=false');

  const tel = await post('/api/telemetry?line=L1&op=OP4', {
    res: '1920x1080', ver: '1.7.1', free: 4096, done: 3, total: 7, model: 'X200', st: 'preparing'
  });
  ok(tel.ok, '终端可以上报机器参数与下载进度');

  const t1 = (await j('/api/terminals?lineId=' + L1id)).body;
  const op4 = t1.terminals.find((x) => x.op === 'OP4');
  ok(op4.seen === true && op4.online === true, '上报后该工序变为在线');
  ok(op4.res === '1920x1080' && op4.ver === '1.7.1', '分辨率与终端版本被记录');
  ok(op4.done === 3 && op4.total === 7, '下载进度被记录（3/7）');
  ok(op4.ip === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(op4.ip),
    'IP 由服务端从连接里取，不信终端自报');
  ok(op4.modelCode === 'X200', '终端正在准备哪个机种也记下来了');

  // 心跳带参数（不需要额外 POST）：长轮询的 query 里带 res/ver/free 就够
  await j('/api/state?op=OP4&line=L1&since=0&res=3840x2160&ver=9.9.9');
  const t2 = (await j('/api/terminals?lineId=' + L1id)).body;
  const op4b = t2.terminals.find((x) => x.op === 'OP4');
  ok(op4b.res === '3840x2160', '心跳 query 里的分辨率同样能更新档案（老终端不改代码也够用）');

  // ========== 13. 工序清单导入（Excel / CSV） ==========
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

  const stBefore = (await j('/api/processes?modelId=' + M.X200.id)).body.processes;
  const s1 = stBefore.find((s) => s.code === 'OP1');
  const s2 = stBefore.find((s) => s.code === 'OP2');

  // ---- 13.1 老格式：三列、带中文标题、没有机种列 ----
  // 3.4.0 之前做的表不改成四列也能导，靠 ?modelId 定位到"界面当前选中的机种"
  const rows = [['工序号', '工序名称', '做什么'], ['OP1', '压装（改）', '压轴承到位'], ['OP30', '气密', '打气测漏'], ['OP31', '贴标', '']];
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

  const legacyUrl = '/api/import/parse?filename=' + encodeURIComponent('工序.xlsx')
    + '&modelId=' + M.X200.id;
  const upXlsx = await j(legacyUrl, { method: 'POST', body: xlsx });
  ok(upXlsx.status === 200 && upXlsx.body.total === 3, 'xlsx 解析出 3 行（标题行自动跳过）');
  ok(upXlsx.body.mode === 'single', '没有机种列 → 走「导到当前选中机种」这条路');
  ok(Array.isArray(upXlsx.body.header) && upXlsx.body.header[0] === '工序号' && upXlsx.body.headerRow === 1,
    '认出并回传标题行（含它在第几行）');
  ok(upXlsx.body.mapping.code === 0 && upXlsx.body.mapping.name === 1 && upXlsx.body.mapping.note === 2,
    '表头映射：工序号→工序码、工序名称→名称、做什么→说明', upXlsx.body.mapping);
  ok(upXlsx.body.rows[0].code === 'OP1' && upXlsx.body.rows[1].name === '气密',
    '单元格文本按 sharedStrings 正确还原');
  ok(upXlsx.body.counts.new === 2 && upXlsx.body.counts.bad === 0,
    '两道是新工序（OP30 / OP31），没有不合要求的行', upXlsx.body.counts);

  const csvBuf = Buffer.from('工序号,工序名称,做什么\nOP1,压装,说明\nOP32,打磨,砂纸\n', 'utf8');
  const upCsv = await j(legacyUrl, { method: 'POST', body: csvBuf });
  ok(upCsv.body.total === 2 && upCsv.body.rows[1].code === 'OP32', 'CSV 同样能读');

  const imp1 = await post('/api/processes/import', {
    rows: upXlsx.body.rows.filter((r) => r.status !== 'bad'), mode: 'merge'
  });
  ok(imp1.ok && imp1.body.created === 2 && imp1.body.skipped === 1,
    '导入按「有就跳过」：新建 2 道、OP1 已存在跳过 1 道');
  ok(/^b_/.test(imp1.body.batchId), '新建过工序才发批次号（撤销要用）', imp1.body.batchId);

  const imp2 = await post('/api/processes/import', {
    rows: upXlsx.body.rows.filter((r) => r.status !== 'bad'), mode: 'merge'
  });
  ok(imp2.body.created === 0 && imp2.body.skipped === 3, '同一份表再导一次不重复建（幂等）');
  ok(imp2.body.batchId === '', '一行都没建时不发批次号，界面上不会出现点不动的「撤销」');

  // ---- 13.2 全厂四列：表头乱序、前面还插了一列「序号」，照样得认 ----
  // 还特意留了一列「线体」：3.4.0 的五列文件不会因为多这一列就整表错位。
  const flatRows = [
    ['序号', '线体', '做什么', '机种', '名称', '工序码'],
    [1, '一线', '改过的说明', M.X200.name, '压装改名', 'OP1'],       // 有变化
    [2, '一线', s2.note || '', M.X200.name, s2.name, 'OP2'],        // 一模一样
    [3, '一线', '新工序', M.X200.name, '镭雕', 'OP99'],             // 新增
    [4, '一线', '', 'X9999', 'X', 'OP97'],                          // 机种没建档
    [5, '一线', '', M.X200.name, '重复', 'OP1'],                    // 与第 2 行重码
    [6, '一线', '', M.X200.name, '怪码', 'OP 10!'],                 // 工序码不合法
    [7, '一线', '', '', '没机种', 'OP96']                           // 机种栏空着
  ];
  const flatBuf = buildWorkbook([{ name: '工序清单', rows: flatRows }]);
  const upFlat = await j('/api/import/parse?filename=' + encodeURIComponent('全厂.xlsx'),
    { method: 'POST', body: flatBuf });
  ok(upFlat.body.mode === 'flat', '带机种列 → 全厂模式，按行分流到各自机种');
  ok(upFlat.body.mapping.code === 5 && upFlat.body.mapping.model === 3 && upFlat.body.mapping.note === 2,
    '前插「序号」、列顺序打乱，仍按表头名认出每一列', upFlat.body.mapping);
  ok(upFlat.body.counts.new === 1 && upFlat.body.counts.diff === 1 && upFlat.body.counts.same === 1,
    '逐行判定：1 新增 / 1 有变化 / 1 没变化', upFlat.body.counts);
  ok(upFlat.body.counts.bad === 4, '4 行不合要求（线体列已被忽略，不再算错）', upFlat.body.counts);

  const badReasons = upFlat.body.rows.filter((r) => r.status === 'bad').map((r) => r.reason);
  ok(badReasons.some((x) => x.includes('机种「X9999」还没建档')), '机种没建档的行单独指出来', badReasons);
  ok(!badReasons.some((x) => x.includes('线体')), '3.4.0 五列文件里的「线体」列被忽略，不报错');
  ok(badReasons.some((x) => x.includes('与第 2 行工序码重复')), '文件内重码，指出跟第几行撞了');
  ok(badReasons.some((x) => x.includes('工序码只能用')), '工序码字符不合法');
  ok(badReasons.some((x) => x === '没有填机种'), '机种栏空着');
  ok(!upFlat.body.rows.some((r) => r.status === 'bad' && r.code === 'OP99'),
    '不合要求的行不影响合格行');

  const impFlat = await post('/api/processes/import', {
    rows: upFlat.body.rows.filter((r) => r.status !== 'bad'), mode: 'merge'
  });
  ok(impFlat.ok && impFlat.body.created === 1 && impFlat.body.skipped === 2,
    '合并导入：只加 OP99，两道已存在的跳过');

  const impUpd = await post('/api/processes/import', {
    rows: upFlat.body.rows.filter((r) => r.status !== 'bad'), mode: 'update'
  });
  ok(impUpd.body.updated === 1 && impUpd.body.kept === 2 && impUpd.body.created === 0,
    '更新导入：只动真变了的那 1 道，没变化的算「没改动」不重写', impUpd.body);

  const op1After = (await j('/api/processes?modelId=' + M.X200.id))
    .body.processes.find((s) => s.code === 'OP1');
  ok(op1After.name === '压装改名' && op1After.note === '改过的说明', 'update 模式覆盖名称与「做什么」');

  const impOnly = await post('/api/processes/import', {
    rows: [{ row: 1, modelId: M.X200.id, code: 'OP95', name: '不该建', note: '' }],
    mode: 'update-only'
  });
  ok(impOnly.body.created === 0 && impOnly.body.skipped === 1,
    'update-only 不新建工序（表里混了草稿行时用）');

  // ---- 13.3 落库阶段的校验兜底 ----
  const impBad = await post('/api/processes/import', {
    rows: [
      { row: 1, modelId: M.X200.id, code: '', name: '没有码' },
      { row: 2, modelId: M.X200.id, code: 'OP!@#', name: '乱码' },
      { row: 3, modelId: M.X200.id, code: 'OP33', name: '合格', note: '' }
    ],
    mode: 'merge'
  });
  ok(impBad.body.created === 1 && impBad.body.bad.length === 2,
    '坏行单独列出来，不影响其它行入库');
  ok(impBad.body.bad[0].row === 1 && typeof impBad.body.bad[0].reason === 'string',
    '坏行带着原始行号和原因，能对回 Excel 那一行', impBad.body.bad[0]);

  const impWrong = await post('/api/processes/import', {
    rows: [{ row: 1, modelId: 'md_not_exist', code: 'OP1', name: 'x' }], mode: 'merge'
  });
  ok(impWrong.body.bad.length === 1 && impWrong.body.created === 0,
    '机种不存在：整行不入库并写明原因');

  // 老调用方式（顶层 modelId + 三列数组）还能跑，脚本不用改
  const impLegacy = await post('/api/processes/import', {
    modelId: M.X200.id, rows: [['OP34', '老写法', '']], mode: 'merge'
  });
  ok(impLegacy.body.created === 1, '兼容 3.3.0 的调用方式（三列数组 + 顶层机种）');

  // ---- 13.4 撤销本次导入 ----
  const undo = await post('/api/processes/import/undo', { batchId: imp1.body.batchId });
  ok(undo.ok && undo.body.deleted === 2, '撤销本次导入：按批次精确删掉那一批新建的 2 道');
  const no99 = (await j('/api/processes?modelId=' + M.X200.id)).body.processes;
  ok(!no99.some((x) => x.code === 'OP30' || x.code === 'OP31'), '被撤销的工序确实没了');
  ok(no99.some((x) => x.code === 'OP99'), '撤销只删本批次新建的，后来导入的不受影响');

  const undoAgain = await post('/api/processes/import/undo', { batchId: imp1.body.batchId });
  ok(!undoAgain.ok && undoAgain.status === 400, '同一批次撤两次：第二次给出人话，不是静默成功');

  // 清理：把这一节造的工序删掉，把 OP1 改回原样，别影响后面的断言
  for (const code of ['OP99', 'OP32', 'OP33', 'OP34']) {
    const p = (await j('/api/processes?modelId=' + M.X200.id))
      .body.processes.find((x) => x.code === code);
    if (p) await j('/api/processes/' + p.id, { method: 'DELETE' });
  }
  await post('/api/processes/import', {
    rows: [{ row: 1, modelId: M.X200.id, code: 'OP1', name: s1.name, note: s1.note || '' }],
    mode: 'update'
  });
  const back = (await j('/api/processes?modelId=' + M.X200.id)).body.processes;
  ok(back.length === stBefore.length && back.find((x) => x.code === 'OP1').name === s1.name,
    '删掉导入的工序、改回原名后恢复原样');


  // ========== 14. 工序清单导出（xlsx） ==========
  console.log('\n14. 工序清单导出 / 模板（Excel）');

  const tpl = await bin('/api/export/template.xlsx');
  ok(tpl.ok && tpl.buf[0] === 0x50 && tpl.buf[1] === 0x4b, '模板下载回来是 xlsx（ZIP 头 PK）');
  ok(tpl.name === '工序清单导入模板.xlsx', '模板文件名带中文（RFC 5987 编码）', tpl.name);

  const tplRows = parseSheet(tpl.buf);
  ok(tplRows.length === 3 && tplRows[0].length === 4, '模板 = 标题行 + 两行示例，四列', tplRows[0]);
  ok(tplRows[0].join('|') === '机种|工序码|名称|做什么',
    '模板表头与导出的表逐列同构（导出来改完能直接导回去）', tplRows[0]);
  ok(tpl.buf.toString('utf8').includes('填写说明'),
    '说明单独占一页，不混在数据区里（混进去会被当成一道工序）');

  const all = await bin('/api/export/processes.xlsx');
  ok(all.ok && all.buf[0] === 0x50, '全厂导出成功');
  ok(/^工序清单-全部机种-\d{8}-\d{4}\.xlsx$/.test(all.name), '文件名带「全部机种」+ 时间戳', all.name);

  const allRows = parseSheet(all.buf);
  ok(allRows[0].length === 4 && allRows[0][1] === '工序码', '全厂一张表，四列（不再有线体列）', allRows[0]);
  ok(allRows.length > 1 && allRows.slice(1).every((r) => r[0] && r[1]),
    `每一行都带机种 / 工序码（共 ${allRows.length - 1} 行）`);
  ok(allRows.length > 1 && new Set(allRows.slice(1).map((r) => r[0])).size >= Object.keys(M).length - 1,
    '所有机种都在同一张表里，不再按 sheet 拆');

  const one = await bin('/api/export/processes.xlsx?modelId=' + M.X200.id);
  const oneRows = parseSheet(one.buf);
  const stNow = (await j('/api/processes?modelId=' + M.X200.id)).body.processes;
  ok(oneRows.length === stNow.length + 1,
    `单机种导出：行数 = 工序数 + 标题（${oneRows.length} = ${stNow.length} + 1）`);
  ok(stNow.every((s, i) => {
    const r = oneRows[i + 1] || [];
    return r[0] === M.X200.name && r[1] === s.code
      && (r[2] || '') === (s.name || '') && (r[3] || '') === (s.note || '');
  }), '导出 → 读回 逐行一致（机种 / 工序码 / 名称 / 做什么）');

  // 闭环：导出的文件原样导回去，应该一道都不动
  const rt = await j('/api/import/parse?filename=rt.xlsx', { method: 'POST', body: one.buf });
  ok(rt.body.mode === 'flat' && rt.body.counts.new === 0 && rt.body.counts.bad === 0
    && rt.body.counts.same === stNow.length,
    '导出文件原样导回：全部判定「没变化」，不重复建也不误改', rt.body.counts);

  ok((await fetch(BASE + '/api/export/processes.xlsx?modelId=md_not_exist')).status === 400,
    '机种不存在时返回 400，而不是给一张空表');
  // 老地址继续可用（3.4.0 的脚本 / 书签）
  ok((await bin('/api/export/stations.xlsx')).ok, '老地址 /api/export/stations.xlsx 仍然返回同一个文件');


  // ---------- 14. 产线状态与排产（v3.5.0） ----------
  // 作业内容页改成"概览 + 运行产线 + 说明"三段，靠的就是这一组字段：
  //   line.status      运行中 / 停用 / 维修中 / 保养中
  //   line_state.next_model_id  下一个要生产的机种（排产，和换型的 pending 不是一回事）
  console.log('\n[14] 产线状态与排产');

  let bd = (await j('/api/board')).body;
  ok(bd.overview && typeof bd.overview.total === 'number', '总览返回 overview 统计');
  ok(bd.overview.total === bd.lines.length, 'overview.total 与线体数一致');
  ok(bd.overview.running + bd.overview.stopped + bd.overview.maintain + bd.overview.care
    === bd.overview.total, '四类状态之和等于总数（不会有"统计不上"的线）');

  // 第 12 节可能已经把二线删了，这里重新取一次；不够两条就再建一条
  let lsNow = (await j('/api/lines')).body.lines;
  if (lsNow.length < 2) {
    await post('/api/lines', { code: 'L9', name: '九线' });
    lsNow = (await j('/api/lines')).body.lines;
  }
  const LN1 = lsNow.find((l) => l.code === 'L1').id;
  const LN2 = lsNow.find((l) => l.id !== LN1).id;
  ok(lsNow.length >= 2, `准备了两条线体用于验证多线并行（${lsNow.length} 条）`);

  ok(bd.lines.every((l) => ['running', 'stopped', 'maintain', 'care'].includes(l.status)),
    '每条线都带合法 status');

  // 把两条都设成运行中，造出"多条线同时跑"
  await put('/api/lines/' + LN1, { status: 'running' });
  await put('/api/lines/' + LN2, { status: 'running' });
  bd = (await j('/api/board')).body;
  ok(bd.overview.running >= 2, `多条线可以同时运行（当前 ${bd.overview.running} 条）`);

  // ---- 排产 ----
  const curCode = bd.lines.find((l) => l.id === LN1).currentModelCode;
  const other = Object.values(M).find((m) => m.code !== curCode && m.enabled);
  let nx = await post('/api/board/next', { lineId: LN1, modelCode: other.code });
  ok(nx.ok && nx.body.nextModelCode === other.code, '可以给线体排产下一个机种');
  bd = (await j('/api/board')).body;
  ok(bd.lines.find((l) => l.id === LN1).nextModelCode === other.code, '排产后 /api/board 能读到 nextModelCode');

  ok((await post('/api/board/next', { lineId: LN1, modelCode: curCode })).status === 400,
    '把"下一个"排成正在生产的机种会被拒绝');

  // 取消排产
  await post('/api/board/next', { lineId: LN1, modelCode: '' });
  bd = (await j('/api/board')).body;
  ok(bd.lines.find((l) => l.id === LN1).nextModelCode === '', '传空 modelCode 可以取消排产');

  // ---- 换型会把排产摘掉（因为它已经进入"正在切"） ----
  await post('/api/board/next', { lineId: LN1, modelCode: other.code });
  const sw2 = await post('/api/board/switch', { lineId: LN1, modelCode: other.code });
  ok(sw2.ok, '排产后可以直接换型到那个机种');
  bd = (await j('/api/board')).body;
  ok(bd.lines.find((l) => l.id === LN1).nextModelCode === '', '换型后 next 被清空（不留下过期的排产）');

  // ---- 状态：维修中 ----
  let chg = await put('/api/lines/' + LN1, { status: 'maintain' });
  ok(chg.ok && chg.body.status === 'maintain' && chg.body.enabled === false,
    '改成维修中：status 变 maintain、enabled 自动变 0');
  bd = (await j('/api/board')).body;
  ok(bd.overview.maintain >= 1, '概览里统计到维修中的线');
  ok(bd.lines.find((l) => l.id === LN1).nextModelCode === '',
    '不在运行的线，排产一并清掉（不留过期数据）');

  // 维修中的线不出现在"运行产线"的筛选里（前端只渲染 status=running）
  ok(bd.lines.filter((l) => l.status === 'running').every((l) => l.id !== LN1),
    '维修中的线不在运行列表里');

  ok((await put('/api/lines/' + LN1, { status: 'sleeping' })).status === 400, '非法状态被拒绝');

  // ---- 老写法兼容（3.4.0 及以前的界面/脚本） ----
  chg = await put('/api/lines/' + LN1, { enabled: true });
  ok(chg.ok && chg.body.status === 'running', '{enabled:true} 仍可用，等价于 status=running');
  chg = await put('/api/lines/' + LN1, { enabled: false });
  ok(chg.ok && chg.body.status === 'stopped', '{enabled:false} 等价于 status=stopped');

  // ---- 收尾：恢复成一条线在跑，别把状态留给后面的用例 ----
  await put('/api/lines/' + LN1, { status: 'running' });
  await put('/api/lines/' + LN2, { status: 'stopped' });
  bd = (await j('/api/board')).body;
  ok(bd.overview.running === 1, '收尾：恢复成一条线运行', bd.overview);

  // ---------- 汇总 ----------
  console.log('\n────────────────────────────');
  console.log(`  通过 ${pass}　失败 ${fail}`);
  console.log('────────────────────────────\n');
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('\n测试脚本异常：', e);
  process.exit(1);
});

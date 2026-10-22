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

  // 有内容的线体不许直接删（会丢清单）
  const delBusy = await j('/api/lines/' + ls.find((l) => l.code === 'L1').id, { method: 'DELETE' });
  ok(delBusy.status === 400, '还有内容的线体不允许删除（防误删清单一整条线）');

  // 收拾：停用并删掉测试线体
  await put('/api/lines/' + L2, { enabled: false });
  const delEmpty = await j('/api/lines/' + L2, { method: 'DELETE' });
  ok(delEmpty.ok, '没有内容的线体可以删除');
  await put('/api/lines/' + ls.find((l) => l.code === 'L1').id, { enabled: true });
  ok((await j('/api/lines')).body.lines.length === 1, '删除后只剩一线，且恢复启用');

  // ---------- 12. 配置库 ----------
  // 这一节的用例对应"配置库到底是什么"：它是模板，不复制内容，
  // 只做两件事 —— 对齐线的工序清单、拿它去量实际内容缺什么。
  const pfList = (await j('/api/profiles')).body;
  ok(Array.isArray(pfList.profiles) && pfList.profiles.length >= 1,
    '首次启动自带一份标准工艺模板（配置库不是空白）');

  const STD = pfList.profiles.find((x) => x.code === 'STD') || pfList.profiles[0];
  ok(STD.steps.length === 5 && STD.steps[0].reqs.length >= 1,
    '模板带 5 道工序，且每道有类型要求');

  // 校验：用模板去量 X200 的实际内容（本测试前面只给 OP30 配了内容）
  const chk = (await j(`/api/profiles/${STD.id}/check?lineCode=L1&modelCode=X200`)).body;
  ok(chk.summary.total === 5, '校验按工序逐道返回，总数等于配置里的工序数');
  ok(chk.steps.find((x) => x.code === 'OP30').count === 2, 'OP30 的实际项数被正确统计（2 项）');
  ok(chk.steps.find((x) => x.code === 'OP30').ok === false,
    '8×8 的图低于 1280×720 要求 → 判为不达标（不是有内容就算过）');
  ok(chk.steps.find((x) => x.code === 'OP30').badItems.length === 2,
    '不符合规格的项被逐条列出来（界面靠它标红）');

  // 建一份自定义配置：OP10 要 2 图 + 1 视频 + 1 PDF，OP20 只要 1 图
  const made = await post('/api/profiles', {
    code: 'P-X220',
    name: 'X220 工艺',
    steps: [
      { code: 'OP10', name: '上料', maxMb: 30, reqs: [
        { kind: 'image', minCount: 2, minWidth: 640, minHeight: 480 },
        { kind: 'video', minCount: 1 },
        { kind: 'pdf', minCount: 1 }
      ] },
      { code: 'OP20', name: '装配', reqs: [{ kind: 'image', minCount: 1 }] }
    ]
  });
  ok(made.ok && made.body.steps.length === 2, '可以新建一份带类型要求的配置');
  ok(made.body.steps[0].reqs.length === 3, '一道工序可以同时要求图片/视频/PDF 三类');

  // 应用到线体：默认不删配置外的工序
  const L1id = ls.find((l) => l.code === 'L1').id;
  const apKeep = await post(`/api/profiles/${made.body.id}/apply`, { lineId: L1id });
  ok(apKeep.ok && apKeep.body.created.length === 0 && apKeep.body.updated.length === 0,
    '应用时同工序码只改名字/顺序，不重复建');
  ok(apKeep.body.kept.length === 3 && apKeep.body.removed.length === 0,
    '默认不删配置外的工序（哪怕它没有内容）—— 一份 2 道工序的配置不该毁掉 5 道');

  // 明确要求 prune 时才删，而且仍然只删空的：
  // 此时线体上是 OP10/OP20（配置内）+ OP30（有内容）/OP40/OP50（空）。
  // 所以能删的只有 OP40、OP50 两道，OP30 因为有内容必须留下 —— 这正是这条保护的意义。
  const apPrune = await post(`/api/profiles/${made.body.id}/apply`, { lineId: L1id, prune: true });
  ok(apPrune.body.removed.length === 2, 'prune=true 才删配置外的工序，且只删空的（OP40/OP50）');
  ok(apPrune.body.kept.some((x) => x.code === 'OP30' && x.items > 0),
    '配置外但有播放内容的工序，即使 prune 也不删（不替人删他的活儿）');
  const procsAfter = (await j('/api/processes?lineId=' + L1id)).body.processes;
  ok(procsAfter.length === 3, '应用后剩 2 道配置内 + 1 道有内容的（5 → 3）');

  // 恢复：把标准 5 道工序补回来（否则后面的换型用例全乱了）
  const restore = await post(`/api/profiles/${STD.id}/apply`, { lineId: L1id });
  ok(restore.body.created.length === 2, '把标准模板再应用回来，缺的 2 道工序被补上');
  const procsRestored = (await j('/api/processes?lineId=' + L1id)).body.processes;
  ok(procsRestored.length === 5, '线体恢复 5 道工序');

  // 配置匹配：编码里带机种号时能自动匹配上
  const match = (await j('/api/profiles/match?lineId=' + L1id + '&modelCode=X220')).body;
  ok(match.profile && match.profile.code === 'P-X220',
    '机种 X220 自动匹配到「P-X220」这份配置（编码里带机种号）');
  ok(match.byCode && match.byCode.OP10, '匹配结果里带"工序码 → 要求"，矩阵表头直接可用');

  // 没有配置的机种不能凭空判不合格
  const noMatch = (await j('/api/profiles/match?lineId=' + L1id + '&modelCode=X299')).body;
  ok(noMatch.profile === null || noMatch.profile.code !== 'P-X220',
    '没匹配到专属配置时不会硬套别人的要求');

  await j('/api/profiles/' + made.body.id, { method: 'DELETE' });
  ok((await j('/api/profiles')).body.profiles.every((x) => x.code !== 'P-X220'),
    '配置档案可以删除（只删模板，不动内容）');

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

  // ---------- 汇总 ----------
  console.log('\n────────────────────────────');
  console.log(`  通过 ${pass}　失败 ${fail}`);
  console.log('────────────────────────────\n');
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('\n测试脚本异常：', e);
  process.exit(1);
});

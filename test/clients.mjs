// 「客户端（屏）与工序绑定」的回归测试
//
//   node test/clients.mjs      （自带干净数据目录，端口 8112，跑完即焚）
//
// 验这些事：
//   1) 屏每 5 秒的心跳会把自己登记成一台客户端（老终端 1.7.1 一行不改就能进列表）
//   2) 心跳里不带 line（跟随服务端）时，记的是解析后的实际线体，不是空
//   3) 绑定落在 (线体, 工序码) 上；一台屏只占一个工位、一道工序只一台屏
//   4) 同工序换一台：原来的被换下，接口告诉你换的是谁
//   5) 屏上把工序号改了 → 立刻判 moved，并报出它现在报的是什么（这是整个功能的重点）
//   6) 心跳超时 → offline
//   7) 绑定不碰播放：item 一条不少，contentRev 不动
//   8) 参数校验：缺工序 / 工序码非法 / 线体不存在 / 客户端不存在 都 400
//   9) 解除：按客户端解、按工序解，都真的从库里消失
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8112);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-cl-'));
const BASE = `http://127.0.0.1:${PORT}`;
const TTL = 1200;          // 服务端的"离线"阈值，测试里压到 1.2 秒

let pass = 0;
const fails = [];
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${msg}${extra ? ` —— ${extra}` : ''}`); }
}

const json = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  let d = {};
  try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  return { status: r.status, d };
};
const post = (p, body) => json(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

/** 心跳：ip 由 body 带（本机跑多台时 socket 都是 127.0.0.1） */
const beat = (ip, line, op, extra = {}) => post('/api/telemetry', { ip, line, op, ...extra });
const clientOf = async (ip) => (await json('/api/clients')).d.clients.find((c) => c.ip === ip);
const bindIn = async (ip, lineId, code) => (
  await json('/api/binds')).d.binds.find((b) => b.ip === ip && b.lineId === lineId && b.processCode === code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: DATA, VWI_PORT: String(PORT), ESOP_CLIENT_TTL_MS: String(TTL) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (b) => process.stderr.write(b.toString()));
  return child;
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(BASE + '/api/status')).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  console.log(`\n临时数据目录：${DATA}\n端口：${PORT}（离线阈值 ${TTL}ms）\n`);
  const server = startServer();
  try {
    if (!await waitReady()) throw new Error('服务没起来');

    // 新库里不一定已经指定了当前机种，机种直接取列表第一个
    const st = (await json('/api/status')).d;
    const line = st.lineCode;
    const lineId = st.lineId;
    const model = ((await json('/api/models')).d.models || [])[0];
    const procs = (await json('/api/processes?modelId=' + model.id)).d.processes;
    const p1 = procs[0].code;
    const p2 = procs[1].code;
    const line2 = (await json('/api/lines')).d.lines.find((l) => l.code !== line);
    console.log(`线体 ${line} / 工序 ${p1}、${p2}\n`);

    // ── 1. 心跳登记 ────────────────────────────────────────
    console.log('1) 心跳把自己登记成客户端');
    ok((await json('/api/clients')).d.total === 0, '还没人上报时列表是空的');
    await beat('10.0.0.31', line, p1);
    await beat('10.0.0.32', line, p2);
    let list = (await json('/api/clients')).d;
    ok(list.total === 2 && list.online === 2, '两台屏都登记上了，都是在线', `${list.total}/${list.online}`);
    const c31 = await clientOf('10.0.0.31');
    ok(c31 && c31.lineCode === line && c31.opCode === p1, '记下了它自报的线体和工序', c31 && `${c31.lineCode}/${c31.opCode}`);
    ok(c31 && c31.bind === null, '新屏是"未分配"状态');
    ok(list.bound === 0 && list.problem === 0, '没绑定时不计已分配、也不报问题');

    // ── 2. 不带 line（跟随服务端）────────────────────────────
    console.log('\n2) 屏上没填线号（跟随服务端）');
    await beat('10.0.0.33', '', p1);
    const c33 = await clientOf('10.0.0.33');
    ok(c33 && c33.lineCode === line,
      '记的是解析后的实际线体，不是空串（否则一绑就显示改配了）', c33 && JSON.stringify(c33.lineCode));

    // ── 3. 绑定 ────────────────────────────────────────────
    console.log('\n3) 绑定到「线体 × 工序」');
    const b1 = await post('/api/clients/10.0.0.31/bind', { lineId, processCode: p1 });
    ok(b1.status === 200 && b1.d.bind && b1.d.bind.state === 'online',
      '绑上之后状态是 online', JSON.stringify(b1.d.bind && b1.d.bind.state));
    ok(b1.d.bind.lineCode === line && b1.d.bind.processCode === p1, '绑定回的是这条线的这道工序');
    ok((await bindIn('10.0.0.31', lineId, p1)) !== undefined, '/api/binds 里查得到');
    ok((await json('/api/clients')).d.bound === 1, '已分配计数变成 1');

    // ── 4. 一道工序只一台屏 ────────────────────────────────
    console.log('\n4) 同一道工序换一台屏');
    const b2 = await post('/api/clients/10.0.0.33/bind', { lineId, processCode: p1 });
    ok(b2.status === 200 && b2.d.replacedClientId === '10.0.0.31',
      '接口报出被换下的是谁', b2.d.replacedClientId);
    ok((await bindIn('10.0.0.33', lineId, p1)) !== undefined, '新的一台占了这格');
    ok((await bindIn('10.0.0.31', lineId, p1)) === undefined, '原来那台在这一格没了');
    ok((await clientOf('10.0.0.31')).bind === null, '原来那台变回"未分配"');

    // ── 5. 一台屏只占一个工位 ──────────────────────────────
    console.log('\n5) 同一台屏换到另一个工位');
    const b3 = await post('/api/clients/10.0.0.33/bind', { lineId, processCode: p2 });
    ok(b3.status === 200 && b3.d.movedFrom && b3.d.movedFrom.processCode === p1,
      '接口报出它原来在哪个工序', JSON.stringify(b3.d.movedFrom));
    ok((await bindIn('10.0.0.33', lineId, p1)) === undefined, '原来的格子清空了');
    ok((await json('/api/clients')).d.bound === 1, '一共还是一条绑定（没变成两条）');

    // ── 6. 改号 → moved ───────────────────────────────────
    console.log('\n6) 屏上把工序号改了');
    await beat('10.0.0.33', line, p1);        // 它现在报 p1，但绑定在 p2
    const c33b = await clientOf('10.0.0.33');
    ok(c33b.bind.state === 'moved', '判成「已改配」而不是"离线"', c33b.bind.state);
    ok(c33b.bind.seenOpCode === p1 && c33b.bind.processCode === p2,
      '同时报得出"绑的是 p2、它现在报 p1"', `${c33b.bind.processCode} vs ${c33b.bind.seenOpCode}`);
    ok((await json('/api/clients')).d.problem === 1, '问题台数 +1（顶栏要能看见）');
    await beat('10.0.0.33', line, p2);
    ok((await clientOf('10.0.0.33')).bind.state === 'online', '改回去之后恢复 online');

    // 改线号也算改配
    if (line2) {
      await beat('10.0.0.33', line2.code, p2);
      ok((await clientOf('10.0.0.33')).bind.state === 'moved', '改线号同样判成「已改配」');
      await beat('10.0.0.33', line, p2);
    }

    // ── 7. 离线 ───────────────────────────────────────────
    console.log('\n7) 心跳停了');
    await sleep(TTL + 500);
    const off = await clientOf('10.0.0.31');
    ok(off.online === false, '超过阈值就算离线');
    const boundOff = await post('/api/clients/10.0.0.31/bind', { lineId, processCode: p2 });
    ok(boundOff.d.bind && boundOff.d.bind.state === 'offline',
      '离线的屏绑上去状态是 offline（不是 online）', boundOff.d.bind && boundOff.d.bind.state);
    await beat('10.0.0.31', line, p2);
    ok((await clientOf('10.0.0.31')).bind.state === 'online', '心跳回来就自动恢复');

    // ── 8. 绑定不碰播放 ───────────────────────────────────
    console.log('\n8) 绑定不影响播放');
    const stBefore = (await json('/api/status')).d;
    await post('/api/clients/10.0.0.32/bind', { lineId, processCode: p2 });
    const stAfter = (await json('/api/status')).d;
    ok(stBefore.contentRev === stAfter.contentRev, 'contentRev 没动（绑定不推内容变更）');
    ok(stBefore.seq === stAfter.seq, 'seq 没动（不是换型）');

    // ── 9. 参数校验 ───────────────────────────────────────
    console.log('\n9) 参数校验');
    ok((await post('/api/clients/10.0.0.31/bind', { lineId })).status === 400, '缺工序码 → 400');
    ok((await post('/api/clients/10.0.0.31/bind', { lineId, processCode: 'OP 1' })).status === 400,
      '工序码带空格 → 400');
    ok((await post('/api/clients/10.0.0.31/bind', { lineId: 'ln_nope', processCode: p1 })).status === 400,
      '线体不存在 → 400');
    ok((await post('/api/clients/9.9.9.9/bind', { lineId, processCode: p1 })).status === 400,
      '客户端不存在 → 400');
    ok((await post('/api/clients/10.0.0.31/bind', { lineCode: line, processCode: p1 })).status === 200,
      '用 lineCode 代替 lineId 也认');
    // 「当前机种没有这道工序」的提示，要先让这条线真的在做一个机种
    await post('/api/board/current', { lineId, modelCode: model.code });
    const warn = await post('/api/clients/10.0.0.31/bind', { lineId, processCode: 'OP99' });
    ok(warn.status === 200 && /没有工序 OP99/.test(warn.d.warning || ''),
      '绑一个当前机种没有的工序：允许，但给一句提示', warn.d.warning);

    // ── 10. 解除 ──────────────────────────────────────────
    console.log('\n10) 解除');
    const un1 = await post('/api/clients/10.0.0.31/unbind', {});
    ok(un1.status === 200 && un1.d.removed === 1, '按客户端解除');
    ok((await clientOf('10.0.0.31')).bind === null, '这台变回未分配');
    const un2 = await post('/api/binds/release', { lineId, processCode: p2 });
    ok(un2.status === 200 && un2.d.removed >= 1, '按工序解除（把占着 OP 的那台一起放掉）');

    const end = (await json('/api/binds')).d;
    ok(end.total === 0, '最后一条绑定都不剩', String(end.total));
  } catch (e) {
    fails.push('未捕获异常：' + e.message);
    console.error(e);
  } finally {
    try { server.kill(); } catch { /* 可能已退出 */ }
  }

  console.log(`\n${pass} 项通过，${fails.length} 项失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ! ' + f));
    process.exitCode = 1;
  }
})();

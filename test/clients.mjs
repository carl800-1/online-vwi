// 「屏台账（终端监控）」的回归测试
//
//   node test/clients.mjs      （自带干净数据目录，端口 8112，跑完即焚）
//
// 5.0.1 把「指派体系」整套砍了（client_bind / 四态握手 / 服务端改写屏配置）。
// 屏的身份就是它自己报的「线号 + 工序号」，服务端只记最新一次心跳。
// 所以这里验的是台账本身，不再是绑定与协商：
//
//   1) 屏每 5 秒的心跳会把自己登记进台账（老终端一行不改就能出现在列表里）
//   2) 心跳里不带 line（跟随服务端）时，记的是解析后的实际线体，不是空串
//   3) 心跳停了算离线，再跳回来自动恢复在线
//   4) 两道工序报成同一道时，库里两台都在 —— 冲突由界面按行标红，不在服务端拦
//   5) 参数校验：缺工序 / 工序码非法 / 线号配错，各自给对的状态码
//   6) hello 仍保留（老终端保存设置后调一次），回 confirmed、assign=null
//   7) 删除：只清台账，屏还在跑的话下一次心跳就把它插回来
//   8) 指派时代的三条接口都已下线（404，不是 405）
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
const del = (p) => json(p, { method: 'DELETE' });

/** 心跳：ip 由 body 带（本机跑多台时 socket 都是 127.0.0.1） */
const beat = (ip, line, op, extra = {}) => post('/api/telemetry', { ip, line, op, ...extra });
const list = async () => (await json('/api/clients')).d;
const clientOf = async (ip) => (await list()).clients.find((c) => c.ip === ip);
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

    const st = (await json('/api/status')).d;
    const line = st.lineCode;
    const model = ((await json('/api/models')).d.models || [])[0];
    const procs = (await json('/api/processes?modelId=' + model.id)).d.processes;
    const p1 = procs[0].code;
    const p2 = procs[1].code;
    console.log(`线体 ${line} / 工序 ${p1}、${p2}\n`);

    // ── 1. 心跳登记 ────────────────────────────────────────
    console.log('1) 心跳把自己登记进台账');
    ok((await list()).total === 0, '还没人上报时列表是空的');
    await beat('10.0.0.31', line, p1);
    await beat('10.0.0.32', line, p2);
    let l = await list();
    ok(l.total === 2 && l.online === 2, '两台屏都登记上了，都是在线', `${l.total}/${l.online}`);
    const c31 = await clientOf('10.0.0.31');
    ok(c31 && c31.lineCode === line && c31.opCode === p1, '记下了它自报的线体和工序',
      c31 && `${c31.lineCode}/${c31.opCode}`);
    ok(c31.name === '' && c31.ver === '', '没报的字段留空，不瞎填');
    ok(l.clients[0].online === true && l.clients[0].ageMs < 5000, '列表里带 ageMs（界面显示"几秒前"）',
      String(l.clients[0].ageMs));

    // ── 2. 不带 line（跟随服务端）────────────────────────────
    console.log('\n2) 屏上没填线号（跟随服务端）');
    await beat('10.0.0.33', '', p1);
    const c33 = await clientOf('10.0.0.33');
    ok(c33 && c33.lineCode === line,
      '记的是解析后的实际线体，不是空串（否则界面上看着像没配线）', c33 && JSON.stringify(c33.lineCode));

    // ── 3. 离线与恢复 ──────────────────────────────────────
    console.log('\n3) 心跳停了 → 离线；再跳 → 恢复');
    await sleep(TTL + 500);
    const off = await clientOf('10.0.0.31');
    ok(off.online === false, '超过阈值就算离线');
    ok(off.ageMs >= TTL, '离线时 ageMs 继续累加（界面显示"几分钟前在线"）', String(off.ageMs));
    await beat('10.0.0.31', line, p1);
    ok((await clientOf('10.0.0.31')).online === true, '心跳回来就自动恢复在线');

    // ── 4. 同工序两屏 ──────────────────────────────────────
    console.log('\n4) 两台屏报同一道工序');
    const p3 = procs[2].code;
    await beat('10.0.0.41', line, p3);
    await beat('10.0.0.42', line, p3);
    const dup = (await list()).clients.filter((c) => c.lineCode === line && c.opCode === p3);
    ok(dup.length === 2, '两台都在库里（服务端不拦，冲突由界面按行标红）', String(dup.length));
    ok(dup.every((c) => c.online), '两台都是在线状态 —— 标红要靠 opCode 重复判，不是靠在线数');

    // ── 5. 参数校验 ────────────────────────────────────────
    console.log('\n5) 参数校验');
    ok((await post('/api/telemetry', { ip: '10.0.0.61', line, op: '' })).status === 400, '缺工序码 → 400');
    ok((await post('/api/telemetry', { ip: '10.0.0.61', line, op: 'OP 1' })).status === 400,
      '工序码带空格 → 400');
    ok((await post('/api/telemetry', { ip: '10.0.0.61', line: 'NOPE', op: p1 })).status === 404,
      '线号配错 → 404（终端上表现为连不上，要去屏前查配置）');
    ok((await clientOf('10.0.0.61')) === undefined, '被拒的心跳不写台账');

    // ── 6. hello 仍保留 ────────────────────────────────────
    console.log('\n6) hello（老终端保存设置后调一次）');
    const h = await post('/api/clients/hello', { ip: '10.0.0.71', line, op: p2, ver: '1.8.3' });
    ok(h.status === 200 && h.d.state === 'confirmed', '回 confirmed，屏上显示「服务端已收到」', h.d.state);
    ok(h.d.assign === null, 'assign 恒为 null（没有指派这回事了）', JSON.stringify(h.d.assign));
    const c71 = await clientOf('10.0.0.71');
    ok(c71 && c71.opCode === p2 && c71.ver === '1.8.3', 'hello 也把机器登记进台账，版本一起记');
    ok((await post('/api/clients/hello', { ip: '10.0.0.71', line, op: 'OP 1' })).status === 400,
      'hello 的工序码同样要合法');

    // ── 7. 删除 ────────────────────────────────────────────
    console.log('\n7) 删除记录');
    const d1 = await del('/api/clients/10.0.0.71');
    ok(d1.status === 200 && d1.d.removed === 1, '删掉一条');
    ok((await clientOf('10.0.0.71')) === undefined, '列表里没有了');
    ok((await del('/api/clients/10.0.0.71')).status === 404, '再删一次 → 404，不是静默成功');
    await beat('10.0.0.71', line, p2);
    ok((await clientOf('10.0.0.71')) !== undefined,
      '屏还在跑 → 下一次心跳把它插回来（删除不是封禁）');

    // ── 8. 指派时代的三条接口已下线 ─────────────────────────
    console.log('\n8) 指派体系的接口已下线');
    ok((await json('/api/binds')).status === 404, '/api/binds 已删');
    ok((await post('/api/clients/10.0.0.31/bind', { line, processCode: p1 })).status === 404,
      '/api/clients/:id/bind 已删');
    ok((await post('/api/binds/release', { line, processCode: p1 })).status === 404,
      '/api/binds/release 已删');
    const pl = await json(`/display/playlist?line=${encodeURIComponent(line)}&op=${encodeURIComponent(p2)}`);
    ok(pl.status === 200 && pl.d.assigned === false && pl.d.selfProcessCode === p2,
      '清单恒按屏自报的号回答（assigned=false，字段留着给老终端）',
      `assigned=${pl.d.assigned} self=${pl.d.selfProcessCode}`);
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

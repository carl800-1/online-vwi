/**
 * 终端自报（hello）与配置优先级。
 *
 * 5.0.1 把「管理端指派」整套删了，所以这个文件只剩两件不需要 Electron 的事：
 *   ① hello 自报 —— 装机的人站在屏前，要知道服务端到底收没收到
 *   ② 配置优先级 —— 老机器上 `managed:true` 的那份仍然压过部署包 json
 *      （字段不再写入，但存量不能一升级就丢配置）
 *
 * 跑法：node test/hello-test.cjs
 * 自带假服务器，不依赖真实服务端，也不连网。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.join(os.tmpdir(), 'esop-hello-test-' + Date.now());
const EXE_DIR = path.join(ROOT, 'exe');
process.env.ESOP_TERMINAL_ROOT = ROOT;
process.env.PORTABLE_EXECUTABLE_DIR = EXE_DIR;
fs.mkdirSync(EXE_DIR, { recursive: true });

const config = require('../src/config');
const { hello } = require('../src/hello');
const { Syncer } = require('../src/sync');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}${detail ? '　→ ' + detail : ''}`); }
}
function eq(a, b, msg) {
  ok(a === b, msg, `实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 假服务器 ─────────────────────────

let helloReply = { state: 'confirmed', lineCode: 'L1', processCode: 'OP1' };
let helloStatus = 200;
let helloBody = null;
// 故意带上 assign：验证新终端**完全不看**这个字段了
let stateReply = {
  rev: 1, seq: 0, currentModelId: '', modelCode: '', contentRev: 1, online: [],
  assign: { line: 'L2', op: 'OP9', src: 'admin' }
};
const readyHits = [];      // 1.8.4 不该再打 /api/ready，打了几次都记下来

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    if (url.pathname === '/api/clients/hello') {
      helloBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (helloStatus === 404) return send(404, { error: 'Not Found' });
      if (helloStatus === 400) return send(400, { error: '线体 L1 不存在，请检查屏上填的线号' });
      return send(200, { ok: true, ...helloReply });
    }
    if (url.pathname === '/api/state') {
      setTimeout(() => send(200, { ...stateReply }), 40);
      return;
    }
    if (url.pathname === '/api/ready') { readyHits.push(url.pathname); return send(404, { error: '接口不存在' }); }
    if (url.pathname === '/api/telemetry') return send(200, { ok: true });
    if (url.pathname === '/display/playlist') return send(200, { items: [], modelCode: 'X' });
    send(404, { error: 'no' });
  });
});

// ───────────────────────── 用例 ─────────────────────────

async function testHello(base) {
  console.log('\nH1 自报：服务端收到了，屏上要说清楚');
  helloReply = { state: 'confirmed', lineCode: 'L1', processCode: 'OP30' };
  let r = await hello(base, { line: 'L1', op: 'OP30', ver: '1.8.4', res: '1920x1080', name: '3F-XB-01' });
  eq(r.ok, true, '自报成功');
  eq(r.state, 'confirmed', '新服务端只有 confirmed 一种');
  ok(r.message.includes('按本机设置'), '话术说明"按你自己填的号播"', r.message);
  eq(helloBody.name, '3F-XB-01', '把计算机名一起报上去（管理端显示名字而不是裸 IP）');
  eq(helloBody.line, 'L1', '带上线号');
  eq(helloBody.op, 'OP30', '带上工序号');
  eq(helloBody.ver, '1.8.4', '带上版本号');
  eq(r.assign, null, 'assign 恒为 null（5.0.1 服务端不再指派）');

  console.log('\nH2 接老服务端也不会崩（状态原样透传，只是不改配置）');
  helloReply = { state: 'assigned', lineCode: 'L2', processCode: 'OP05', assign: { lineCode: 'L2', processCode: 'OP05' } };
  r = await hello(base, { line: 'L1', op: 'OP30' });
  eq(r.state, 'assigned', '老服务端回 assigned：状态透传');
  ok(r.message.includes('仍按自己的设置'), '话术写明本机不会跟着改', r.message);

  console.log('\nH3 自报失败不能挡住装机');
  helloStatus = 400;
  r = await hello(base, { line: 'L1', op: 'OP30' });
  eq(r.ok, false, '400：算失败');
  ok(r.error.includes('线体 L1 不存在'), '400：把服务端的中文原因带出来（不是 "HTTP 400"）', r.error);

  helloStatus = 404;
  r = await hello(base, { line: 'L1', op: 'OP30' });
  ok(r.oldServer === true, '404：识别成"服务端太旧"，装机继续');
  helloStatus = 200;

  r = await hello(base, { line: 'L1', op: '' });
  eq(r.ok, false, '没填工序号：不打请求，直接判失败');
}

async function testNoAssign(base) {
  console.log('\nS1 服务端还下发 assign 也不理它（1.8.4 删了改派）');
  const s = new Syncer({ line: 'L1', op: 'OP1', server: base }, {});
  let fired = 0;
  s.on('assign', () => { fired++; });
  s.start();
  await sleep(800);
  eq(fired, 0, '一个 assign 事件都不发');
  eq(s.cfg.line, 'L1', '本地配置没被改写（还是自己填的 L1）');
  eq(s.cfg.op, 'OP1', '工序号也没被改写');
  s.stop();

  console.log('\nS2 不再举手（1.8.4 删了 /api/ready）');
  eq(readyHits.length, 0, `跑了 ${800}ms 一次 /api/ready 都没打过`, readyHits.length ? readyHits.join(',') : '');
}

function testConfigPriority() {
  console.log('\nC1 配置优先级：老机器上 managed 的那份仍然压过部署包 json');
  // 部署包 json 说 L1/OP1（运维批量部署的那份）
  fs.writeFileSync(path.join(EXE_DIR, 'config.json'),
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L1', op: 'OP1' }), 'utf8');
  // 本机：4.5 时代被管理端改写过的那份（存量数据，不能一升级就丢）
  fs.writeFileSync(config.PATHS.config,
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L2', op: 'OP5', managed: true }), 'utf8');

  let c = config.load();
  eq(c.line, 'L2', 'managed 的本地配置优先（老机器升级后不会突然变回部署包的值）');
  eq(c.op, 'OP5', '工序也跟着本地');
  eq(c.from, 'local-managed', '来源标记为 local-managed');

  // 手工清掉 managed（现场想回到"部署包 json 说了算"时就这么做）
  fs.writeFileSync(config.PATHS.config,
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L2', op: 'OP5' }), 'utf8');
  c = config.load();
  eq(c.line, 'L1', '没有 managed 标记时回到老行为：部署包 json 优先');
  eq(c.from, 'portable', '来源标记为 portable');

  console.log('\nC2 设置页保存不会把 kiosk / 自启重置（1.8.1 修过的那个坑）');
  fs.writeFileSync(path.join(EXE_DIR, 'config.json'),
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L1', op: 'OP1', kiosk: true, autoStart: true }), 'utf8');
  const cur = config.load();
  const saved = config.save({ ...cur, op: 'OP7' });
  eq(saved.op, 'OP7', '工序号改成了 OP7');
  eq(saved.kiosk, true, 'kiosk 没被重置成默认值');
  eq(saved.autoStart, true, 'autoStart 没被重置成默认值');
}

async function main() {
  console.log(`\n终端自报与配置测试　临时目录 ${ROOT}`);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await testHello(base);
    await testNoAssign(base);
    testConfigPriority();
  } finally {
    server.close();
  }

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  for (const f of failures) console.log('  · ' + f);

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试中断：', e.message);
  process.exit(2);
});

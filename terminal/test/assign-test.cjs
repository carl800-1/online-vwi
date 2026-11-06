/**
 * 终端 1.8.0：指派下发与自报。
 *
 * 只测两件不需要 Electron 的事：
 *   ① hello 自报（真的打 HTTP，四种返回都要能读懂）
 *   ② 指派下发（Syncer 收到 assign 要发事件，且**同一个值只发一次**，否则主进程会反复重启同步）
 *   ③ 配置优先级（管理端改写过的那份要压过部署包 json，否则重启就变回去）
 *
 * 跑法：node test/assign-test.cjs
 * 自带假服务器，不依赖真实服务端，也不连网。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.join(os.tmpdir(), 'esop-assign-test-' + Date.now());
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

let helloReply = { state: 'pending', lineCode: 'L1', processCode: 'OP1' };
let helloStatus = 200;
let helloBody = null;          // 记录终端发上来的 body
let stateReply = { rev: 1, seq: 0, phase: 'idle', currentModelId: '', modelCode: '', contentRev: 1, online: [] };

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
      // 稍等一下再回：不然长轮询变成死循环，CPU 直接跑满
      setTimeout(() => send(200, { ...stateReply }), 40);
      return;
    }
    if (url.pathname === '/api/telemetry' || url.pathname === '/api/ready') return send(200, { ok: true });
    if (url.pathname === '/display/playlist') return send(200, { items: [], modelCode: 'X' });
    send(404, { error: 'no' });
  });
});

// ───────────────────────── 用例 ─────────────────────────

async function testHello(base) {
  console.log('\nH1 自报：四种状态都要能读懂');
  helloReply = { state: 'pending', lineCode: 'L1', processCode: 'OP30' };
  let r = await hello(base, { line: 'L1', op: 'OP30', ver: '1.8.0', res: '1920x1080', name: '3F-XB-01' });
  eq(r.ok, true, 'pending：调用成功');
  eq(r.state, 'pending', 'pending：状态透传');
  ok(r.message.includes('等管理端确认'), 'pending：带中文话术', r.message);
  eq(helloBody.name, '3F-XB-01', '把计算机名一起报上去（管理端显示名字而不是裸 IP）');
  eq(helloBody.line, 'L1', '带上线号');
  eq(helloBody.op, 'OP30', '带上工序号');
  eq(helloBody.ver, '1.8.0', '带上版本号');

  helloReply = { state: 'confirmed', lineCode: 'L1', processCode: 'OP30' };
  r = await hello(base, { line: 'L1', op: 'OP30' });
  eq(r.state, 'confirmed', 'confirmed：状态透传');

  helloReply = { state: 'assigned', lineCode: 'L2', processCode: 'OP05', assign: { lineCode: 'L2', processCode: 'OP05' } };
  r = await hello(base, { line: 'L1', op: 'OP30' });
  eq(r.state, 'assigned', 'assigned：状态透传');
  eq(r.assign.processCode, 'OP05', 'assigned：把管理端指到哪带回来');
  ok(r.message.includes('按管理端执行'), 'assigned：话术说明本机要跟着改', r.message);

  helloReply = { state: 'conflict', conflictWith: '192.168.1.32' };
  r = await hello(base, { line: 'L1', op: 'OP30' });
  eq(r.state, 'conflict', 'conflict：状态透传');
  eq(r.conflictWith, '192.168.1.32', 'conflict：告诉现场是哪台占着');

  console.log('\nH2 自报失败不能挡住装机');
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

async function testAssign(base) {
  console.log('\nA1 下发与本地不一致 → 发一次 assign 事件');
  stateReply = { ...stateReply, assign: { line: 'L1', op: 'OP2', src: 'admin' } };
  const s = new Syncer({ line: 'L1', op: 'OP1', server: base }, {});
  const seen = [];
  s.on('assign', (a) => seen.push(a));
  s.start();
  await sleep(700);
  eq(seen.length, 1, '只发一次');
  if (seen[0]) {
    eq(seen[0].line, 'L1', '带来目标线体');
    eq(seen[0].op, 'OP2', '带来目标工序');
    eq(seen[0].fromOp, 'OP1', '带来原工序（日志与屏上提示要用）');
    eq(seen[0].src, 'admin', '带来来源（管理端改派）');
  }

  // 服务端还在继续下发同一个值（长轮询每轮都带），不能再发
  await sleep(600);
  eq(seen.length, 1, '同一个值重复下发不会重复发事件');

  console.log('\nA2 值变了 → 再发一次；与本地一致 → 不发');
  stateReply = { ...stateReply, assign: { line: 'L2', op: 'OP3', src: 'admin' } };
  await sleep(600);
  eq(seen.length, 2, '换成另一个位置会再发一次');
  eq(seen[1] && seen[1].line, 'L2', '第二次的目标线体');
  s.stop();

  const s2 = new Syncer({ line: 'L2', op: 'OP3', server: base }, {});
  const seen2 = [];
  s2.on('assign', (a) => seen2.push(a));
  s2.start();
  await sleep(600);
  eq(seen2.length, 0, '本地已经是这个位置：不发（不会自己重启自己）');
  s2.stop();

  console.log('\nA3 没有被指派过 → 一个事件都不该有');
  stateReply = { ...stateReply, assign: undefined };
  const s3 = new Syncer({ line: 'L1', op: 'OP1', server: base }, {});
  const seen3 = [];
  s3.on('assign', (a) => seen3.push(a));
  s3.start();
  await sleep(500);
  eq(seen3.length, 0, '没有 assign 字段时什么都不做（老服务端）');
  s3.stop();
}

function testConfigPriority() {
  console.log('\nC1 配置优先级：管理端改写过的那份压过部署包 json');
  // 部署包 json 说 L1/OP1（运维批量部署的那份）
  fs.writeFileSync(path.join(EXE_DIR, 'config.json'),
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L1', op: 'OP1' }), 'utf8');
  // 本机（管理端改派后写入）
  fs.writeFileSync(config.PATHS.config,
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L2', op: 'OP5', managed: true }), 'utf8');

  let c = config.load();
  eq(c.line, 'L2', 'managed 的本地配置优先（否则重启就变回部署包的值）');
  eq(c.op, 'OP5', '工序也跟着本地');
  eq(c.from, 'local-managed', '来源标记为 local-managed');

  // 手工清掉 managed（前端没有这个开关，等价于重新部署一份干净配置）
  fs.writeFileSync(config.PATHS.config,
    JSON.stringify({ server: 'http://10.0.0.1:8092', line: 'L2', op: 'OP5' }), 'utf8');
  c = config.load();
  eq(c.line, 'L1', '没有 managed 标记时回到老行为：部署包 json 优先');
  eq(c.from, 'portable', '来源标记为 portable');

  console.log('\nC2 managed 要能落盘（下次启动才认）');
  const saved = config.save({ ...c, line: 'L3', op: 'OP7', managed: true });
  eq(saved.managed, true, 'save 返回里带 managed');
  const raw = JSON.parse(fs.readFileSync(config.PATHS.config, 'utf8'));
  eq(raw.managed, true, '真的写进了 config.json');
  eq(config.load().line, 'L3', '再读一次就是管理端说的那条线');
}

async function main() {
  console.log(`\n终端指派与自报测试　临时目录 ${ROOT}`);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await testHello(base);
    await testAssign(base);
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

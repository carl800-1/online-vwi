/**
 * 客户端 ↔ 服务端 联通自检。
 *
 * 和 sync-test 的区别：sync-test 测的是「素材下载与缓存对不对」，它要求服务端已有
 * 特定内容（写死了 X200/X210）；这个脚本只回答一个问题 —— **这台屏能不能连上服务端，
 * 并且走完整轮交互**。所以它对内容不做要求，空库也能跑。
 *
 * 走的是终端自己的代码（src/net.js 发请求、src/hello.js 自报），不是另写一套 fetch，
 * 这样"脚本通过"和"屏能播"用的是同一条链路。
 *
 * 跑法：
 *   node test/link-test.cjs
 *   SERVER=http://192.168.1.4:8092 LINE=L1 OP=OP3 node test/link-test.cjs
 *
 * ⚠️ 用 127.0.0.1 跑只能证明服务端活着，**不能证明屏连得上**（本机连接走回环，
 * 不过防火墙）。要验证现场可达，SERVER 必须填服务端的局域网 IP。
 *
 * 退出码：0 全通 / 1 有失败项。
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('../src/net');
const { hello, TEXT } = require('../src/hello');

const SERVER = (process.env.SERVER || 'http://127.0.0.1:8092').replace(/\/+$/, '');
const LINE = process.env.LINE || '';
const OP = process.env.OP || '';

const TMP = path.join(os.tmpdir(), 'esop-link-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}${detail ? '　→ ' + detail : ''}`); }
}
function info(msg) { console.log(`    ${msg}`); }

const LOOPBACK = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(SERVER);

(async () => {
  console.log('');
  console.log('='.repeat(62));
  console.log('  客户端 → 服务端 联通自检');
  console.log('  服务端  ' + SERVER);
  console.log('  线体/工序  ' + (LINE || '(跟随服务端当前线体)') + ' / ' + (OP || '(未指定)'));
  console.log('='.repeat(62));

  if (LOOPBACK) {
    console.log('');
    console.log('  ⚠ 地址是回环地址。本机连接走机器内部，不过防火墙，');
    console.log('    所以这一轮**只能证明服务端活着**，不能证明屏连得上。');
    console.log('    要验证现场可达，把 SERVER 换服务端的局域网 IP 再跑一次。');
  }

  // ── 1. 端口通不通 ────────────────────────────────────────
  console.log('');
  console.log('[1] TCP 连接');
  let board = null;
  try {
    board = await net.getJson(SERVER, '/api/board', { timeoutMs: 8000 });
    ok(true, '能连上并拿到 JSON：GET /api/board');
    const lines = (board.lines || []).map((l) => l.code);
    info(`线体 ${lines.length} 条：${lines.slice(0, 8).join(' / ')}${lines.length > 8 ? ' …' : ''}`);
    ok(lines.length > 0, '服务端里有线体（不是空库）', '先去管理端建线体');
  } catch (e) {
    ok(false, '连不上服务端：' + (e.code || e.message), '核对 IP、服务端是否在跑、防火墙是否放行 8092');
    info('排查顺序：');
    info('  ① 服务端的「放行端口.bat /check」看四项体检');
    info('  ② 确认这次填的 IP 是服务端网卡地址，不是 127.0.0.1');
    info('  ③ 换台机器用浏览器开 ' + SERVER + '/ 看能不能出页面');
    return finish(1);
  }

  // ── 2. 服务端版本 ────────────────────────────────────────
  console.log('');
  console.log('[2] 服务端版本');
  let ver = '';
  try {
    // 4.x 用 /api/status（顺带能确认"服务端认的是哪条线"）；老版本没有这个接口
    const s = await net.getJson(SERVER, '/api/status', { timeoutMs: 8000 });
    ver = s.version || '';
    if (s.lineCode) info(`服务端默认线体 ${s.lineCode}　当前机种 ${s.modelCode || '(未指定)'}`);
  } catch {
    // 拿不到版本不是联通问题，跳过
  }
  if (ver) {
    const major = Number(String(ver).split('.')[0]) || 0;
    info('服务端 ' + ver);
    ok(major >= 4, '版本够新（≥ 4.5.0 才支持自报与指派）', '当前 ' + ver + '，自报会降级但不影响播放');
  } else {
    info('服务端没报版本（老版本或接口不同）');
    ok(true, '跳过版本判断');
  }

  // ── 3. 自报身份 ──────────────────────────────────────────
  console.log('');
  console.log('[3] 自报身份（POST /api/clients/hello）');
  const identity = {
    line: LINE,
    op: OP,
    ver: '1.8.0',
    res: '1920x1080',
    name: 'link-test-' + os.hostname()
  };
  const h = await hello(SERVER, identity);
  if (!h.ok && h.oldServer) {
    ok(true, '服务端较旧，不支持自报（不影响播放）');
    info(h.error);
  } else if (!h.ok) {
    ok(false, '自报失败：' + h.error);
  } else {
    ok(['pending', 'confirmed', 'assigned', 'conflict'].includes(h.state), '服务端回了已知状态：' + h.state);
    info('话术：' + (h.message || TEXT[h.state] || ''));
    if (h.state === 'conflict') {
      info('（这道工序已被另一台屏占着 —— 联通过程正常，是业务上的占用）');
    }
    if (h.assign) {
      info('管理端指派：' + h.assign.lineCode + ' / ' + h.assign.processCode);
    }
  }

  // ── 4. 长轮询拿状态 ──────────────────────────────────────
  // 注意：/api/state 是**线体级**状态（终端用它判断"要不要换型 / 内容变没变"），
  // 里面**没有** process / items —— 工序清单走 /display/playlist，下一节才测。
  // 别把这两个接口混成一个（第一版就写错过）。
  console.log('');
  console.log('[4] 长轮询取状态（GET /api/state）');
  try {
    const st = await net.getJson(
      SERVER,
      `/api/state?line=${encodeURIComponent(LINE)}&op=${encodeURIComponent(OP)}&since=0`,
      { timeoutMs: 15000 }
    );
    ok(true, '长轮询有返回（不是挂住不回）');
    const need = ['rev', 'seq', 'phase', 'contentRev'];
    const missing = need.filter((k) => st[k] === undefined);
    ok(missing.length === 0, '终端要用的字段齐全（' + need.join(' / ') + '）',
      '缺 ' + missing.join(' / ') + '，终端会按默认值走');
    info(`rev=${st.rev}　seq=${st.seq}　contentRev=${st.contentRev}　phase=${st.phase || '-'}`);
    info(`当前机种 ${st.modelCode || '(未指定)'}　在线屏 ${(st.online || []).length} 台`);
    if (!st.modelCode) {
      info('这条线还没有指定当前机种 —— 屏会显示等待，不是连不上');
    }
  } catch (e) {
    ok(false, '长轮询失败：' + (e.code || e.message));
  }

  // ── 5. 清单 + 素材下载 ───────────────────────────────────
  console.log('');
  console.log('[5] 拉清单并实际下载一份素材（GET /display/playlist + /m/:id）');
  let pl = null;
  try {
    pl = await net.getJson(
      SERVER,
      `/display/playlist?line=${encodeURIComponent(LINE)}&op=${encodeURIComponent(OP)}`,
      { timeoutMs: 15000 }
    );
    const items = pl.items || [];
    info(`${pl.modelCode || '(无机种)'} / ${pl.processCode || '?'}　清单 ${items.length} 项` +
         (pl.empty ? '（空）' : '') + (pl.assigned ? '　[由管理端指派]' : ''));
    ok(true, '清单接口正常');

    if (items.length === 0) {
      info('清单是空的，跳过下载 —— 空内容不代表联通有问题');
    } else {
      const it = items[0];
      const dest = path.join(TMP, `${it.mediaId}.${it.ext || 'bin'}`);
      const r = await net.download(SERVER, it.url, dest, { expectedSha: it.sha256 });
      ok(r.bytes > 0, `下载成功：${it.name || it.mediaId}　${(r.bytes / 1024).toFixed(1)} KB`);
      ok(!it.sha256 || r.sha256 === it.sha256, 'sha256 校验通过（内容和清单一致）');
      info('落盘 ' + dest);
    }
  } catch (e) {
    if (e.status === 404) {
      ok(false, '清单接口 404 —— 服务端版本太旧或地址写错');
    } else if (e.code === 'ERR_SHA') {
      ok(false, 'sha256 不符（下载到的内容与清单不一致）');
    } else {
      ok(false, '清单/下载失败：' + (e.code || e.message));
    }
  }

  // ── 6. 心跳上报 ──────────────────────────────────────────
  console.log('');
  console.log('[6] 心跳上报（POST /api/telemetry）');
  try {
    await net.postJson(SERVER, '/api/telemetry', {
      line: LINE,
      op: OP,
      ver: '1.8.0',
      res: '1920x1080',
      free: 1234,
      name: identity.name,
      done: 0,
      total: 0
    }, { timeoutMs: 10000 });
    ok(true, '心跳被接收');
  } catch (e) {
    ok(false, '心跳失败：' + (e.code || e.message));
  }

  // ── 7. 管理端能否看到这台屏 ──────────────────────────────
  console.log('');
  console.log('[7] 管理端能否看到这台屏（GET /api/clients）');
  try {
    const cl = await net.getJson(SERVER, '/api/clients', { timeoutMs: 10000 });
    const list = cl.clients || cl.items || (Array.isArray(cl) ? cl : []);
    const me = list.find((c) => c.name === identity.name);
    ok(Boolean(me), '客户端列表里能找到刚上报的这台（' + identity.name + '）',
      '共 ' + list.length + ' 条，可能被同名覆盖或心跳没写库');
    if (me) {
      info(`${me.name}　${me.ip || '?'}　${me.lineCode || '?'} / ${me.opCode || '?'}` +
           `　${me.confirmed ? '已确认' : '待确认'}`);
    }
  } catch (e) {
    ok(false, '查客户端列表失败：' + (e.code || e.message));
  }

  finish(failures.length ? 1 : 0);

  function finish(code) {
    console.log('');
    console.log('─'.repeat(62));
    if (code === 0) {
      console.log(`  通过 ${pass}　失败 0`);
      console.log('  这条链路通了：TCP → 自报 → 长轮询 → 清单 → 下载 → 心跳 → 管理端可见');
      if (LOOPBACK) {
        console.log('  ⚠ 但走的是回环地址，现场可达性还没证明 —— 换成局域网 IP 再跑一次。');
      }
    } else {
      console.log(`  通过 ${pass}　失败 ${failures.length}`);
      failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
    }
    console.log('─'.repeat(62));
    console.log('');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉就留着 */ }
    // net.js 的 agent 是 keepAlive，不显式退出会挂着
    process.exit(code);
  }
})().catch((e) => {
  console.log('');
  console.log('脚本自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

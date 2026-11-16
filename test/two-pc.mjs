/**
 * 两机联调自动断言（零改造版）。
 *
 * 只通过服务端 HTTP 接口验证「另一台电脑上的屏」，第二台电脑不用装探针、不用开端口、
 * 不用装 Node —— 因为终端每 5 秒心跳 + 开机自报 + 被改派后重新上报，状态本来就在服务端库里。
 *
 * 两种跑法：
 *   1) 沙盒自测：VIRTUAL=1，用 /api/clients/hello 的 body.ip 伪造一台 B 屏，闭环全跑通。
 *      必须在隔离库上跑（ESOP_DATA 指到临时目录），别拿它打现场库。
 *   2) 真机：B_IP=<屏的IP> BASE=http://<服务端局域网IP>:8092，脚本等真屏上线、真实改派、
 *      等真屏自己把工序号改过来（≤25 秒长轮询窗口），最后把绑定恢复原状。
 *
 * 跑法：
 *   BASE=http://127.0.0.1:8093 VIRTUAL=1 node test/two-pc.mjs
 *   BASE=http://192.168.1.4:8092 B_IP=192.168.1.55 LINE=L1 OP=OP3 ALT_OP=OP2 node test/two-pc.mjs
 *   WAIT_LINK=1 ...   # 额外做「心跳中断 → 恢复」人工配合项（拔网 / 重启终端）
 *
 * 退出码：0 全部通过 / 1 有失败项。
 * ⚠️ 会真的写 client_bind 并推 contentRev，别在生产高峰跑。结束时自动恢复原绑定。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  base: process.env.BASE || 'http://127.0.0.1:8093',
  line: process.env.LINE || 'L1',
  op: process.env.OP || 'OP3',
  altOp: process.env.ALT_OP || 'OP2',
  bip: process.env.B_IP || '',
  vip: process.env.VIP || '127.0.0.77',
  waitSec: Number(process.env.WAIT_SEC || 180),
  assignSec: Number(process.env.ASSIGN_SEC || 40),
  virtual: process.env.VIRTUAL === '1',
  keepBind: process.env.KEEP_BIND === '1',
  waitLink: process.env.WAIT_LINK === '1',
  restoreLocal: process.env.RESTORE_LOCAL !== '0'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cmpVer(a, b) {
  const x = String(a || '0').split('.').map(Number);
  const y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

async function req(base, p, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const r = await fetch(base.replace(/\/+$/, '') + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const txt = await r.text();
  let d;
  try { d = JSON.parse(txt); } catch { d = txt; }
  if (!r.ok) {
    const msg = d && typeof d === 'object' ? (d.error || JSON.stringify(d)) : String(d);
    throw new Error(`HTTP ${r.status}: ${msg.slice(0, 160)}`);
  }
  return d;
}

async function pollUntil(fn, timeoutMs, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* 网络抖动继续等 */ }
    await sleep(intervalMs);
  }
  return null;
}

const isLoopback = (base) => /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(base);

/**
 * @param {object} input 覆盖 DEFAULTS
 * @param {(ev:object)=>void} emit 实时事件，给 Web 控制台用
 */
export async function runSuite(input = {}, emit = () => {}) {
  const o = { ...DEFAULTS, ...input };
  const rows = [];
  const log = [];

  const say = (msg) => { log.push({ t: Date.now(), msg }); emit({ type: 'log', msg }); };
  const phase = (name) => { emit({ type: 'phase', name }); say('【' + name + '】'); };
  const ok = (item, expect, actual, pass, hint = '') => {
    const row = { item, expect, actual: String(actual), pass: !!pass, hint };
    rows.push(row);
    emit({ type: 'row', row });
    return !!pass;
  };

  const get = (p, opts) => req(o.base, p, opts);
  const post = (p, body) => req(o.base, p, { method: 'POST', body });
  const status = () => get('/api/status');
  const clients = () => get('/api/clients');
  const bind = (ip, processCode, src = 'admin') =>
    post(`/api/clients/${encodeURIComponent(ip)}/bind`, { lineCode: o.line, processCode, src });
  const unbind = (ip) => post(`/api/clients/${encodeURIComponent(ip)}/unbind`, {});
  const hello = (ip, processCode, name = 'SANDBOX-PC-B') =>
    post('/api/clients/hello', {
      ip, line: o.line, op: processCode, name, ver: '1.8.0', res: '1920x1080'
    });

  const pick = (list) => {
    if (o.bip) return list.find((c) => c.ip === o.bip);
    if (o.virtual) return list.find((c) => c.ip === o.vip);
    return list.filter((c) => !/^(127\.|::1|localhost)/.test(c.ip) && c.online)
      .sort((a, b) => a.ageMs - b.ageMs)[0];
  };

  const LOOPBACK = isLoopback(o.base);
  let targetIp = o.bip || (o.virtual ? o.vip : '');
  let originalBind = null;
  let changed = false;          // 是否真的写过指派（决定要不要恢复现场）
  let failed = false;

  try {
    // ── 0. 服务端体检 ────────────────────────────────────────
    phase('0 服务端体检');
    let st;
    try { st = await status(); } catch (e) {
      ok('服务端可达', 'GET /api/status 200', e.message, false, '先启动 ESOP-Server.exe；A 本机跑一次 放行端口.bat check');
      failed = true;
      return finish();
    }
    ok('服务端可达', 'GET /api/status 200', `v${st.version || '?'} / ${st.lineCode || '?'}`, !!st.version);
    const verOk = cmpVer(st.version, '4.5.0') >= 0;
    if (!verOk) failed = true;
    ok('服务端版本支持自报/指派', '≥ 4.5.0', st.version || '未知', verOk, '低于 4.5.0 请整套升级');
    let board = { lines: [] };
    try { board = await get('/api/board'); } catch { /* 老版本没有 */ }
    const codes = (board.lines || []).map((l) => l.code);
    ok('线体 ' + o.line + ' 存在', o.line, codes.join(' / ') || '(读不到)', codes.includes(o.line));
    ok('服务端有内容概览', 'models/items 字段', `${st.models ?? '?'} 机种 / ${st.items ?? '?'} 清单项`, st.models !== undefined);
    if (LOOPBACK) say('⚠ 当前是回环地址：只能证明服务端活着，不能证明另一台电脑连得上来');
    else say('✓ 走的是局域网地址，和真屏同一条路');

    // ── 1. 目标屏上线 ────────────────────────────────────────
    phase('1 目标屏上线 / 自报建档');
    if (o.virtual) {
      if (!LOOPBACK) throw new Error('虚拟屏只允许打隔离沙盒（回环地址），禁止往现场库写假客户端');
      const h = await hello(o.vip, o.op);
      const four = ['pending', 'confirmed', 'assigned', 'conflict'];
      ok('虚拟屏自报 hello', '四态之一', h.state, four.includes(h.state));
      say('⚠ 这是本机伪造的 B 屏：验证的是业务闭环，不代替真机防火墙/网口测试');
    } else {
      say(`等待真机屏上线（最多 ${o.waitSec} 秒，请在 B 上双击 ESOP-Client.exe 并填好设置）…`);
      const found = await pollUntil(async () => {
        const d = await clients();
        const others = d.clients.filter((c) => !/^(127\.|::1|localhost)/.test(c.ip) && c.online);
        if (others.length > 1 && !o.bip) say(`检测到 ${others.length} 台非回环屏，建议用 B_IP 指定，当前取心跳最新的一台`);
        return pick(d.clients);
      }, o.waitSec * 1000, 1500);
      if (!found) {
        ok('真机屏上线', `${o.waitSec}s 内出现在 /api/clients`, '超时未出现', false,
          '查 A 的 放行端口.bat check；B 浏览器开 http://<A-IP>:8092/；B 设置页点「检测」');
        failed = true;
        return finish();
      }
      targetIp = found.ip;
      say(`找到了：${found.ip} ${found.name || '(无名)'} ${found.lineCode}/${found.opCode}`);
    }

    // ── 2. 自报字段 ──────────────────────────────────────────
    phase('2 自报字段核对');
    const c0 = pick((await clients()).clients);
    ok('B 出现在客户端表', targetIp, c0 ? c0.ip : '未找到', !!c0, 'IP 由服务端从连接来源读取，不采信自报');
    if (!c0) { failed = true; return finish(); }
    ok('计算机名已上报', '非空', c0.name || '(空)', !!c0.name, '1.8.0 的 collectMeta() 带 hostName()');
    ok('终端版本', '1.8.0', c0.ver || '(空)', c0.ver === '1.8.0', '老终端不会跟随改派，必须整套配对');
    ok('分辨率已上报', '非空', c0.res || '(空)', !!c0.res);
    ok('自报线体 / 工序', `${o.line} / ${o.op}`, `${c0.lineCode} / ${c0.opCode}`,
      !!c0.lineCode && !!c0.opCode);
    ok('心跳新鲜（5 秒一次）', '< 15000 ms', `${c0.ageMs} ms`, c0.ageMs < 15000);
    originalBind = c0.bind ? { ...c0.bind } : null;
    say('测试前绑定：' + (originalBind
      ? `${originalBind.lineCode}/${originalBind.processCode}（src=${originalBind.src || '-'}）`
      : '未绑定'));

    // ── 3. 改派闭环（核心）────────────────────────────────────
    phase('3 改派 → 屏自动跟随');
    const before = (await status()).contentRev;
    const r = await bind(targetIp, o.altOp, 'admin');
    changed = true;
    ok('指派接口成功', 'ok:true', String(r.ok), !!r.ok);
    const after = (await status()).contentRev;
    ok('指派推了 contentRev（屏会立刻刷新）', `> ${before}`, String(after),
      typeof before === 'number' && typeof after === 'number' && after > before,
      '4.4.0 的已知问题就在这：不推的话要等 25 秒长轮询超时');

    const c1 = pick((await clients()).clients);
    ok('指派已落库且标记 admin', `${o.line}/${o.altOp} src=admin`,
      c1?.bind ? `${c1.bind.lineCode}/${c1.bind.processCode} src=${c1.bind.src}` : '(无绑定)',
      !!c1?.bind && c1.bind.processCode === o.altOp && c1.bind.src === 'admin');
    ok('自报与指派不一致被识别', 'moved / 已跟随', c1?.bind?.state || '(无)',
      c1?.bind?.state === 'moved' || c1?.opCode === o.altOp,
      '管理端「按客户端」应显示「已改配 · 按分配执行」');

    if (o.virtual) {
      await sleep(600);
      await hello(targetIp, o.altOp);       // 模拟终端收到 assign → 改写 config.json → 重新自报
      say('虚拟屏模拟：收到 assign，本地改成 ' + o.altOp + ' 并重新上报');
    } else {
      say(`等待真机屏自己跟上（长轮询窗口 ≤25 秒，最多等 ${o.assignSec} 秒）…`);
    }
    const t0 = Date.now();
    const followed = await pollUntil(async () => {
      const c = pick((await clients()).clients);
      return c && c.opCode === o.altOp && (!c.bind || c.bind.state === 'online') ? c : null;
    }, o.assignSec * 1000, 700);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    ok('屏跟随改派（强证据）', `自报变成 ${o.altOp} 且状态 online`,
      followed ? `${followed.opCode} / ${followed.bind?.state || 'unbound'} · ${elapsed}s` : `${elapsed}s 内未跟上`,
      !!followed, followed ? '' : '真机不跟随 → 检查终端是不是 1.8.0、长轮询有没有被代理掐断');
    if (!followed) failed = true;

    // ── 4. 断线 / 重启（人工配合，可选）────────────────────────
    if (o.waitLink) {
      phase('4 心跳中断 → 恢复（人工配合）');
      say('▶ 现在请拔掉 B 的网线（或重启 ESOP-Client.exe），等心跳停 20 秒以上再恢复…');
      const down = await pollUntil(async () => {
        const c = pick((await clients()).clients);
        return c && c.ageMs > 20000 ? c : null;
      }, 90000, 1500);
      ok('检测到心跳中断', 'ageMs > 20000', down ? `${down.ageMs} ms` : '90s 内没断', !!down);
      if (down) {
        say('▶ 现在把网插回去 / 等终端起来…');
        const up = await pollUntil(async () => {
          const c = pick((await clients()).clients);
          return c && c.ageMs < 10000 && c.opCode === o.altOp ? c : null;
        }, 90000, 1500);
        ok('重连后仍按指派、不回退', `${o.altOp} 且心跳恢复`,
          up ? `${up.opCode} / ${up.ageMs} ms` : '90s 内没恢复', !!up);
        if (!up) failed = true;
      } else failed = true;
    } else {
      phase('4 断线/重启（跳过）');
      ok('断线恢复（可选人工项）', 'WAIT_LINK=1 时执行', '已跳过', true,
        '要测就加 WAIT_LINK=1，按提示拔网/重启 B');
    }

    // ── 5. 恢复现场 ──────────────────────────────────────────
    phase('5 恢复现场');
    await restore();
    return finish();
  } catch (e) {
    failed = true;
    say('✗ 异常：' + e.message);
    ok('流程完整性', '无异常', e.message, false);
    try { await restore(); } catch (x) { say('⚠ 恢复绑定失败：' + x.message + '（请到管理端手工恢复）'); }
    return finish();
  }

  async function restore() {
    if (!targetIp || o.keepBind || !changed) return;
    const restored = [];
    // 先把终端本地 config 改回原工序（利用「绑定优先 + 自动下发」这一机制，零改造）。
    // 只在原本「未绑定」时做：原本就绑在别处的屏，直接恢复那条绑定即可。
    if (o.restoreLocal && !originalBind) {
      await bind(targetIp, o.op, 'admin');
      if (o.virtual) await hello(targetIp, o.op);
      else await pollUntil(async () => {
        const c = pick((await clients()).clients);
        return c && c.opCode === o.op ? c : null;
      }, o.assignSec * 1000, 700);
      restored.push(`本地改回 ${o.op}`);
    }
    if (originalBind) {
      await bind(targetIp, originalBind.processCode, originalBind.src || 'admin');
      restored.push(`绑定恢复 ${originalBind.lineCode}/${originalBind.processCode}`);
    } else {
      await unbind(targetIp);
      restored.push('解除绑定（回到测试前的未分配）');
    }
    const c = pick((await clients()).clients);
    const want = originalBind ? originalBind.processCode : null;
    const good = want ? c?.bind?.processCode === want : !c?.bind;
    ok('现场已恢复（绑定）', want || '未绑定', c?.bind?.processCode || '未绑定', good,
      restored.join('；') + '；恢复失败请到「终端监控 → 按客户端」手工处理');
    if (!good) failed = true;
  }

  function finish() {
    const pass = rows.filter((r) => r.pass).length;
    const failN = rows.length - pass;
    if (failN) failed = true;
    return {
      pass, fail: failN, rows, log, failed,
      base: o.base, virtual: o.virtual, targetIp,
      note: o.virtual
        ? '这是隔离沙盒 + 虚拟屏：闭环逻辑已验证，真机防火墙/网口仍需按六关清单实跑。'
        : '真机断言完成；终端本地 config.json 已由脚本通过改派改回原工序。'
    };
  }
}

// ── 命令行入口 ────────────────────────────────────────────────
const self = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (self && fileURLToPath(import.meta.url) === self) {
  const res = await runSuite({}, (ev) => {
    if (ev.type === 'log') console.log('  ' + ev.msg);
    if (ev.type === 'row') console.log(`  ${ev.row.pass ? '✓' : '✗'} ${ev.row.item}　→ ${ev.row.actual}`);
  });
  console.log('\n' + '='.repeat(66));
  console.log(`  两机联调断言：${res.pass} 通过 / ${res.fail} 失败　（${res.base}${res.virtual ? ' · 虚拟屏' : ''}）`);
  console.log('='.repeat(66));
  console.log(res.note);
  process.exit(res.failed ? 1 : 0);
}

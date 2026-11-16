/**
 * 两机联调可视化控制台 —— 给 WorkBuddy 右侧结果区用的本地 Web 服务。
 *
 * 只监听 127.0.0.1，不对外。它自己不实现业务逻辑，断言全部复用 test/two-pc.mjs：
 *   - 沙盒模式：BASE 指隔离库服务端（8093），虚拟 B 屏用 /api/clients/hello 的 body.ip 伪造；
 *   - 真机模式：把 BASE 改成 A 的局域网 IP，虚拟屏自动禁用，只做只读观测 + 真实改派。
 *
 * 跑法：CONSOLE_PORT=8095 BASE=http://127.0.0.1:8093 node tools/two-pc-console.mjs
 * 然后浏览器打开 http://127.0.0.1:8095/ （WorkBuddy 里由 present_files 推到右侧预览）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from '../test/two-pc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(ROOT, 'two-pc-console.html'), 'utf8');
const PORT = Number(process.env.CONSOLE_PORT || 8095);
const VIP = '127.0.0.77';

let cfg = {
  base: process.env.BASE || 'http://127.0.0.1:8093',
  line: process.env.LINE || 'L1',
  op: process.env.OP || 'OP3',
  altOp: process.env.ALT_OP || 'OP2',
  bip: process.env.B_IP || ''
};
let virtual = false;
let running = false;
let phase = '';
let rows = [];
let log = [];
let last = null;

const isLoopback = (b) => /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(b);
const sandbox = () => isLoopback(cfg.base);
const stamp = (msg) => log.push({ t: Date.now(), msg });

async function esop(p, init = {}) {
  const r = await fetch(cfg.base.replace(/\/+$/, '') + p, {
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : {},
    signal: AbortSignal.timeout(6000)
  });
  const txt = await r.text();
  let d;
  try { d = JSON.parse(txt); } catch { d = txt; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(typeof d === 'object' ? (d.error || '') : d).slice(0, 120)}`);
  return d;
}
const post = (p, body) => esop(p, { method: 'POST', body: JSON.stringify(body) });
const hello = (ip, op) => post('/api/clients/hello', {
  ip, line: cfg.line, op, name: 'SANDBOX-PC-B', ver: '1.8.0', res: '1920x1080'
});

function pickTarget(list) {
  if (cfg.bip) return list.find((c) => c.ip === cfg.bip);
  if (virtual) return list.find((c) => c.ip === VIP);
  return list.filter((c) => !/^(127\.|::1|localhost)/.test(c.ip) && c.online)
    .sort((a, b) => a.ageMs - b.ageMs)[0];
}

function emit(ev) {
  if (ev.type === 'row') rows.push(ev.row);
  if (ev.type === 'log') stamp(ev.msg);
  if (ev.type === 'phase') phase = ev.name;
}

async function payload() {
  const out = {
    cfg: { ...cfg }, sandbox: sandbox(), virtual, running, phase,
    rows, log: log.slice(-80), last,
    pass: rows.filter((r) => r.pass).length,
    fail: rows.filter((r) => !r.pass).length,
    a: { ok: false }, b: null
  };
  try {
    const [s, c] = await Promise.all([esop('/api/status'), esop('/api/clients')]);
    out.a = {
      ok: true, version: s.version, lineCode: s.lineCode, modelCode: s.modelCode,
      contentRev: s.contentRev, rev: s.rev, models: s.models, items: s.items,
      processes: s.processes, total: c.total, online: c.online,
      bound: c.bound, problem: c.problem
    };
    out.b = pickTarget(c.clients) || null;
  } catch (e) {
    out.a = { ok: false, error: e.message };
  }
  return out;
}

async function action(body) {
  const type = String(body.type || '');
  if (type === 'config') {
    for (const k of ['base', 'line', 'op', 'altOp', 'bip']) {
      if (typeof body[k] === 'string') cfg[k] = body[k].trim();
    }
    if (!cfg.base) cfg.base = 'http://127.0.0.1:8093';
    if (!sandbox() && virtual) {
      virtual = false;
      stamp('切到真机地址，虚拟屏已自动关闭（禁止往现场库写假客户端）');
    }
    stamp(`配置已应用：服务端 ${cfg.base}　${cfg.line}/${cfg.op} → ${cfg.altOp}${cfg.bip ? '　B_IP=' + cfg.bip : ''}`);
    return { ok: true };
  }
  if (type === 'virtual') {
    if (!sandbox()) return { error: '真机模式不能开虚拟屏：会往现场库写一条假客户端' };
    virtual = !virtual;
    if (virtual) {
      try { await hello(VIP, cfg.op); stamp(`虚拟 B 屏已上线：${VIP} ${cfg.line}/${cfg.op} v1.8.0`); }
      catch (e) { virtual = false; return { error: '虚拟屏自报失败：' + e.message }; }
    } else stamp('虚拟 B 屏已关闭（记录留在隔离库，不影响任何交付数据）');
    return { ok: true };
  }
  if (type === 'suite') {
    if (running) return { error: '上一轮还在跑' };
    rows = []; log = []; last = null; phase = '准备中'; running = true;
    const opts = {
      ...cfg, virtual, vip: VIP,
      waitSec: virtual ? 10 : 120,
      assignSec: 40, waitLink: false, keepBind: false
    };
    runSuite(opts, emit)
      .then((r) => { last = r; running = false; phase = r.failed ? '完成（有失败项）' : '完成（全部通过）'; })
      .catch((e) => {
        running = false; phase = '异常结束';
        stamp('✗ 控制台异常：' + e.message);
      });
    return { ok: true };
  }
  if (type === 'reset') {
    try {
      const c = await esop('/api/clients');
      const t = pickTarget(c.clients);
      if (t) await post(`/api/clients/${encodeURIComponent(t.ip)}/unbind`, {});
      if (virtual) await hello(VIP, cfg.op);
      stamp('手工恢复：已解除目标屏绑定' + (virtual ? '，虚拟屏自报改回 ' + cfg.op : ''));
      return { ok: true };
    } catch (e) { return { error: '恢复失败：' + e.message }; }
  }
  return { error: '未知操作：' + type };
}

// 沙盒启动时自动放一台虚拟屏上去，右侧一打开就能看到 A/B 两栏都有数据。
// 只在回环隔离库生效；真机地址永远不会伪造客户端。
if (process.env.AUTO_VIRTUAL === '1' && sandbox()) {
  virtual = true;
  hello(VIP, cfg.op)
    .then(() => stamp(`虚拟 B 屏已自动上线：${VIP} ${cfg.line}/${cfg.op} v1.8.0`))
    .catch((e) => { virtual = false; stamp('虚拟屏自动启动失败：' + e.message); });
}

// 虚拟屏心跳：只在不跑断言、且是隔离沙盒时维持 5 秒一次，模拟真实终端。
// 用「当前库里记录的 opCode」上报，避免把改派后的值又改回去。
setInterval(async () => {
  if (!virtual || running || !sandbox()) return;
  try {
    const c = await esop('/api/clients');
    const cur = c.clients.find((x) => x.ip === VIP);
    await hello(VIP, cur?.opCode || cfg.op);
  } catch { /* 服务端临时没起，下一轮再试 */ }
}, 5000);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(HTML);
    }
    if (u.pathname === '/api/console/state') return json(200, await payload());
    if (u.pathname === '/api/console/action' && req.method === 'POST') {
      let raw = '';
      for await (const ch of req) raw += ch;
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'JSON 格式不对' }); }
      return json(200, await action(body));
    }
    return json(404, { error: 'not found' });
  } catch (e) {
    return json(500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`两机联调控制台  http://127.0.0.1:${PORT}/`);
  console.log(`服务端          ${cfg.base}${sandbox() ? '（隔离沙盒）' : '（真机）'}`);
});

// 同步切换验收（A1 / A2 / A9）：三台终端订阅同一型号，服务端一发切换，
// 逐帧记录每台"屏幕上真正显示的是哪套内容"，据此算切换总时长、首末翻转间隔、是否混屏。
//
// 用法：node tools/acceptance.mjs switch <目标型号> [端口:op ...]
//   例：node tools/acceptance.mjs switch X210 9223:OP10 9224:OP30 9225:OP50
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'probe', 'probe-out');
fs.mkdirSync(outDir, { recursive: true });

const BASE = process.env.VWI_SERVER || 'http://127.0.0.1:8092';
const [, , cmd, target, ...portArgs] = process.argv;
const targets = portArgs.map((s) => {
  const [port, op] = s.split(':');
  return { port: Number(port), op: op || `P${port}` };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(port, op) {
    this.port = port;
    this.op = op;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error(`端口 ${this.port} 没有页面`);
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`端口 ${this.port} WS 失败`)), { once: true });
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      });
    });
    return this;
  }
  send(method, params = {}, timeoutMs = 5000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, timeoutMs);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.value;
  }
  async snapshot() {
    const raw = await this.evaluate(`(() => {
      // 只看真正可见的那一层：.layer 默认 visibility:hidden，加 .on 才显示。
      // 隐藏层是预载缓冲，里面已经有新内容，但观众看不到——不能当成"已切换"。
      const boxes = ['layerA','layerB'].map((id) => document.getElementById(id)).filter(Boolean);
      const on = boxes.filter((el) => el.classList.contains('on'));
      const vis = [];
      for (const el of on) {
        const img = el.querySelector('img');
        const v = el.querySelector('video');
        const shown = [img, v].find((x) => x && !x.hidden);
        if (shown) vis.push({ tag: shown.tagName.toLowerCase(), src: decodeURIComponent(shown.getAttribute('src') || '') });
      }
      return JSON.stringify({
        model: document.getElementById('mCode')?.textContent || '',
        op: document.getElementById('pCode')?.textContent || '',
        state: document.getElementById('stateText')?.textContent || '',
        wait: document.getElementById('wait')?.hidden === false,
        hint: document.getElementById('hint')?.hidden === false,
        bubble: document.querySelectorAll('.layer.on').length,
        layers: vis,
        beat: window.__vwiBeat || 0
      });
    })()`);
    return JSON.parse(raw);
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 10000);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function mediaOf(snap) {
  // 可见层里正在显示的那张图的文件名（= mediaId.ext），用来判定"这一屏到底是哪套内容"
  const vis = snap.layers.find((l) => l.src);
  if (!vis) return '';
  const m = /\/current\/([^/\\]+)$/.exec(vis.src);
  return m ? m[1].replace(/\.[^.]+$/, '') : vis.src;
}

(async () => {
  const clients = [];
  for (const t of targets) clients.push(await new Cdp(t.port, t.op).connect());
  console.log(`已连接 ${clients.length} 台：${clients.map((c) => `${c.op}@${c.port}`).join(' ')}`);

  // 目标型号包含哪些 mediaId，用来判定"已翻转"
  const pl = await (await fetch(`${BASE}/api/models`)).json();
  const model = pl.models.find((m) => m.code === target);
  if (!model) throw new Error(`型号 ${target} 不存在`);
  const wantIds = new Set();
  for (const p of (await (await fetch(`${BASE}/api/processes`)).json()).processes) {
    const r = await (await fetch(`${BASE}/api/playlist?modelId=${model.id}&processId=${p.id}`)).json();
    for (const it of r.items) wantIds.add(it.mediaId);
  }
  console.log(`目标 ${target} 共 ${wantIds.size} 个媒体：${[...wantIds].join(',')}`);

  const before = [];
  for (const c of clients) before.push(await c.snapshot());
  console.log('切换前：' + clients.map((c, i) => `${c.op}=${before[i].model}/${mediaOf(before[i])}`).join('  '));
  for (const c of clients) await c.shot(path.join(outDir, `before-${c.op}.png`));

  const timeline = [];
  const t0 = Date.now();
  let switchedAt = 0;
  const sampling = (async () => {
    while (Date.now() - t0 < 12000) {
      const ts = Date.now() - t0;
      const snaps = await Promise.all(clients.map(async (c) => {
        try { return await c.snapshot(); } catch { return null; }
      }));
      clients.forEach((c, i) => {
        const s = snaps[i];
        if (!s) return;
        timeline.push({ ts, op: c.op, model: s.model, media: mediaOf(s), state: s.state, wait: s.wait, hint: s.hint, layersOn: s.bubble });
      });
      if (!switchedAt && timeline.some((r) => wantIds.has(r.media))) switchedAt = ts;
      if (switchedAt && ts > switchedAt + 2500) break;
      await sleep(70);
    }
  })();

  await sleep(800);
  const fireAt = Date.now() - t0;
  const res = await fetch(`${BASE}/api/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelCode: target })
  });
  const body = await res.json();
  console.log(`切换指令已发出（t=${fireAt}ms，HTTP ${res.status}，phase=${body.state?.phase}）`);

  await sampling;

  const after = [];
  for (const c of clients) { after.push(await c.snapshot()); await c.shot(path.join(outDir, `after-${c.op}.png`)); }

  // ── 统计 ──
  const firstFlip = {};
  for (const r of timeline) {
    if (wantIds.has(r.media) && !(r.op in firstFlip)) firstFlip[r.op] = r.ts;
  }
  const flips = Object.values(firstFlip);
  const spread = flips.length ? Math.max(...flips) - Math.min(...flips) : null;
  const doneAt = flips.length ? Math.max(...flips) : null;

  // 混屏检查：同一台在同一时刻是否同时出现两套内容的 src，或顶栏与画面不一致
  const mixed = timeline.filter((r) => {
    return r.model && r.model !== target && wantIds.has(r.media);   // 画面已是新内容但顶栏还写旧型号
  });
  const waitShown = timeline.filter((r) => r.wait);
  // A9 的硬判据：任何时刻只能有一层可见。两层同时 on = 一屏里叠了两套内容。
  const multiLayer = timeline.filter((r) => r.layersOn > 1);
  // A2 只算"切换过程"这一段（指令发出 → 最后一台翻完）。此前终端可能本来就在下载，不该记到切换账上。
  const winEnd = doneAt ?? fireAt + 5000;
  const waitInSwitch = timeline.filter((r) => r.wait && r.ts >= fireAt - 100 && r.ts <= winEnd);
  const hintInSwitch = timeline.filter((r) => r.hint && r.ts >= fireAt - 100 && r.ts <= winEnd);

  const report = {
    target, fireAt, doneAt, spread,
    perTerminal: firstFlip,
    finalStates: clients.map((c, i) => ({ op: c.op, model: after[i].model, media: mediaOf(after[i]), state: after[i].state })),
    mixedSamples: mixed.length,
    multiLayerSamples: multiLayer.length,
    waitSamples: waitShown.length,
    waitInSwitch: waitInSwitch.length,
    hintInSwitch: hintInSwitch.length,
    samples: timeline.length
  };
  fs.writeFileSync(path.join(outDir, `switch-report-${target}.json`), JSON.stringify({ report, timeline }, null, 2));

  console.log('\n── 结果 ──');
  console.log(`切换指令 → 最后一台翻完：${doneAt} ms（指令发出于 ${fireAt}ms）`);
  console.log(`首末翻转间隔（A1 要求 ≤1000ms）：${spread} ms`);
  for (const [op, t] of Object.entries(firstFlip)) console.log(`  ${op} 在 ${t}ms 翻到新内容`);
  console.log(`顶栏与画面不一致的采样数（A9）：${mixed.length}`);
  console.log(`两层同时可见的采样数（A9 混屏，必须 0）：${multiLayer.length}`);
  console.log(`切换窗口内全屏遮罩采样数（A2 要求 0）：${waitInSwitch.length}`);
  console.log(`切换窗口内左下提示条采样数（允许，但不遮画面）：${hintInSwitch.length}`);
  console.log('切换后各屏：' + report.finalStates.map((s) => `${s.op}=${s.model}/${s.media}`).join('  '));
  console.log(`明细已写入 tools/probe/probe-out/switch-report-${target}.json`);

  clients.forEach((c) => c.close());
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });

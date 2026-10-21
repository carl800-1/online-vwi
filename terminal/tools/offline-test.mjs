// 断网续播验收（A3）：服务端停掉后，终端必须继续循环播放本地缓存，不黑屏、不报错退出。
// 判据：页码仍在推进（多图工序）、可见层始终有内容、状态条变"离线"但画面不动。
// 用法：node tools/offline-test.mjs 40 9223:OP10 9224:OP30 9225:OP50
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'probe', 'probe-out');
const seconds = Number(process.argv[2] || 40);
const targets = process.argv.slice(3).map((s) => {
  const [port, op] = s.split(':');
  return { port: Number(port), op };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('超时')); } }, 8000);
  });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  return {
    ws, send, evaluate,
    snap: async () => JSON.parse(await evaluate(`(() => {
      const on = ['layerA','layerB'].map((id) => document.getElementById(id)).filter((el) => el && el.classList.contains('on'));
      let media = '';
      for (const el of on) {
        const shown = [el.querySelector('img'), el.querySelector('video')].find((x) => x && !x.hidden);
        if (shown && shown.getAttribute('src')) media = (shown.getAttribute('src') || '').split('/').pop();
      }
      return JSON.stringify({
        cur: document.getElementById('cur')?.textContent || '0',
        total: document.getElementById('total')?.textContent || '0',
        model: document.getElementById('mCode')?.textContent || '',
        state: document.getElementById('stateText')?.textContent || '',
        rightCls: document.getElementById('right')?.className || '',
        media,
        wait: document.getElementById('wait')?.hidden === false,
        beat: window.__vwiBeat || 0
      });
    })()`)),
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    }
  };
}

(async () => {
  const clients = [];
  for (const t of targets) clients.push({ ...t, c: await open(t.port) });

  const rows = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const ts = ((Date.now() - t0) / 1000).toFixed(1);
    const line = [];
    for (const t of clients) {
      let s;
      try { s = await t.c.snap(); } catch { s = null; }
      rows.push({ ts: Number(ts), op: t.op, ...(s || {}) });
      line.push(`${t.op}: ${s ? `${s.cur}/${s.total} ${s.state} ${s.media || '无内容'}` : '读取失败'}`);
    }
    console.log(`t=${ts}s  ` + line.join('  |  '));
    await sleep(1500);
  }

  for (const t of clients) {
    await t.c.shot(path.join(outDir, `offline-${t.op}.png`));
    t.c.ws.close();
  }

  // 汇总：每台页码是否变化过、是否出现过空白
  console.log('\n── 汇总 ──');
  for (const t of clients) {
    const mine = rows.filter((r) => r.op === t.op && r.model !== undefined);
    const pages = [...new Set(mine.map((r) => r.cur))].join('→');
    const blank = mine.filter((r) => !r.media).length;
    const waits = mine.filter((r) => r.wait).length;
    const states = [...new Set(mine.map((r) => r.state))].join('/');
    console.log(`${t.op}: 页码 ${pages}，无内容采样 ${blank}，全屏遮罩 ${waits}，状态 ${states}`);
  }
  fs.writeFileSync(path.join(outDir, 'offline-report.json'), JSON.stringify(rows, null, 2));
  console.log('明细已写入 tools/probe/probe-out/offline-report.json');
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });

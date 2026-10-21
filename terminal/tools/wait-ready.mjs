// 等待某台终端"真正出画面"，用于 A5：从进程启动到屏上有内容的耗时。
// 用法：node tools/wait-ready.mjs <CDP端口> <启动时刻文件（可选）>
import fs from 'node:fs';

const port = Number(process.argv[2] || 9223);
const startFile = process.argv[3];
const t0 = startFile && fs.existsSync(startFile) ? Number(fs.readFileSync(startFile, 'utf8').trim()) : Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryOnce() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const out = await new Promise((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      m.error ? reject(new Error(m.error.message)) : resolve(m.result.result.value);
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const on = ['layerA','layerB'].map((id) => document.getElementById(id)).filter((el) => el && el.classList.contains('on'));
          for (const el of on) {
            const img = el.querySelector('img');
            const v = el.querySelector('video');
            const shown = [img, v].find((x) => x && !x.hidden);
            if (shown && shown.getAttribute('src')) return JSON.stringify({
              media: (shown.getAttribute('src') || '').split('/').pop(),
              model: document.getElementById('mCode')?.textContent || '',
              state: document.getElementById('stateText')?.textContent || ''
            });
          }
          return '';
        })()`
      }
    }));
  });
  ws.close();
  return out ? JSON.parse(out) : null;
}

(async () => {
  const deadline = Date.now() + 120000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const s = await tryOnce();
      if (s && s.media) {
        console.log(`已出画面：${((Date.now() - t0) / 1000).toFixed(2)} 秒，型号 ${s.model}，文件 ${s.media}，状态 ${s.state}`);
        process.exit(0);
      }
      if (s) last = `${s.model}/${s.state}`;
    } catch { /* 进程还没起来，继续等 */ }
    await sleep(120);
  }
  console.error(`120 秒内没出画面（最后状态 ${last || '无'}）`);
  process.exit(1);
})();

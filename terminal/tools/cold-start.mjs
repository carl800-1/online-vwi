// 冷启动掐表：配置已就绪时，从双击 exe 到屏幕出现内容用了多久。
// 和 A6 的区别是不含装机向导，模拟"第二天早上开机"。
// 用法：node tools/cold-start.mjs <t0文件> <CDP端口> <截图>
import fs from 'node:fs';

const [, , t0File, portArg, shotPath] = process.argv;
const PORT = Number(portArg || 9231);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Number(fs.readFileSync(t0File, 'utf8').trim());
const now = () => Date.now() - t0;

class Cdp {
  constructor(u) { this.id = 0; this.p = new Map(); this.ws = new WebSocket(u); }
  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error(e.message)));
      this.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data); const p = this.p.get(m.id);
        if (!p) return; this.p.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result.value; }
}

(async () => {
  let page = null;
  const dl = Date.now() + 60000;
  while (Date.now() < dl) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && (t.url || '').includes('player.html'));
      if (page) break;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  if (!page) throw new Error('60 秒内没等到播放页');
  const tPage = now();
  console.log(`  播放页出现：${tPage} ms`);

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  let frame = null;
  const fd = Date.now() + 60000;
  while (Date.now() < fd) {
    const raw = await cdp.eval(`(() => {
      const on = document.querySelector('.layer.on');
      const img = on && on.querySelector('img:not([hidden])');
      const m = document.getElementById('mCode');
      return JSON.stringify({
        model: m ? m.textContent.trim() : '',
        state: (document.getElementById('stateText') || {}).textContent || '',
        src: img ? decodeURIComponent(img.getAttribute('src') || '') : '',
        nw: img ? img.naturalWidth : 0, cw: img ? img.clientWidth : 0,
        vw: innerWidth, vh: innerHeight
      });
    })()`);
    const s = JSON.parse(raw);
    if (s.model && s.src) { frame = s; break; }
    await sleep(80);
  }
  if (!frame) throw new Error('60 秒内没出画面');
  const tShot = now();

  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  }

  console.log('\n── 冷启动结果 ──');
  console.log(`双击 exe → 出画面：${tShot} ms（${(tShot / 1000).toFixed(2)} 秒）`);
  console.log(`画面：${frame.model} / ${frame.state} / 视口 ${frame.vw}x${frame.vh}`);
  console.log(`图片原始宽 ${frame.nw}px，显示宽 ${frame.cw}px → ${frame.nw === frame.cw ? '1:1 未缩放' : '有缩放'}`);
  fs.writeFileSync(String(shotPath || 'cold.json').replace(/\.png$/, '.json'),
    JSON.stringify({ t0, tPage, tPicture: tShot, frame }, null, 2));
  cdp.ws.close();
  process.exit(0);
})().catch((e) => { console.error('冷启动测试失败：', e.message); process.exit(1); });

// 用 Electron 自带的 Chromium 把一张本地页面按指定分辨率渲染成 PNG。
// 用途：生成 A7 检验卡成品图，保证卡片像素与面板像素 1:1。
// 用法：node tools/render-page.mjs <url> <宽> <高> <输出png> [CDP端口]
import fs from 'node:fs';

const [, , url, wArg, hArg, outPath, portArg] = process.argv;
const W = Number(wArg || 1280);
const H = Number(hArg || 720);
const PORT = Number(portArg || 9232);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result.value; }
}

(async () => {
  let page = null;
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* 等实例起来 */ }
    await sleep(200);
  }
  if (!page) throw new Error('等不到可渲染的页面');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const target = url.startsWith('file:') || url.startsWith('http') ? url : 'file:///' + url.replace(/\\/g, '/');
  await cdp.send('Page.navigate', { url: target });
  await sleep(1200);

  const info = await cdp.eval('JSON.stringify({url:location.href, w:innerWidth, h:innerHeight, title:document.title, bodyH:document.body.scrollHeight})');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(outPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`已渲染 ${outPath}`);
  console.log(info);
  cdp.ws.close();
  process.exit(0);
})().catch((e) => { console.error('渲染失败：', e.message); process.exit(1); });

// CDP 截图：连上 Electron 的 remote-debugging-port，把页面真实像素抓成 PNG。
// 用途是验收——不靠人眼、不靠"我觉得应该没问题"，直接看渲染结果。
// 用法：node tools/shot.cjs <输出文件> [等待毫秒] [url关键字]
const fs = require('node:fs');
const path = require('node:path');

const outFile = process.argv[2] || path.join(__dirname, 'probe', 'probe-out', 'shot.png');
const waitMs = Number(process.argv[3] || 800);
const urlHint = process.argv[4] || '';
const PORT = Number(process.env.VWI_CDP_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WS 连接失败: ' + e.message)));
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  let targets = await listTargets();
  if (urlHint) targets = targets.filter((t) => (t.url || '').includes(urlHint));
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.error('没有可截图的页面，现有 target：', targets.map((t) => `${t.type} ${t.url}`).join(' | '));
    process.exit(1);
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Page.enable');
  await sleep(waitMs);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight})',
    returnByValue: true
  });
  console.log(`已截图 ${outFile}  ${result.value}`);
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('截图失败：', e.message); process.exit(2); });

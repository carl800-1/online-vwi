// CDP 交互工具：在目标窗口里执行一段 JS，可选截一张图。
// 用途是验收 GUI 行为——点开面板、翻标签、触发切换后直接看像素结果，
// 不靠"我觉得应该生效了"。
//
// 用法：
//   node tools/cdp-eval.cjs "<js表达式>" [等待毫秒] [截图输出路径] [url关键字]
// 例：
//   node tools/cdp-eval.cjs "document.getElementById('sysBtn').click()" 1200 shot.png
const fs = require('node:fs');
const path = require('node:path');

const js = process.argv[2] || '1+1';
const waitMs = Number(process.argv[3] || 600);
const outFile = process.argv[4] || '';
const urlHint = process.argv[5] || '';
const PORT = Number(process.env.VWI_CDP_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const hit = urlHint ? pages.find((t) => (t.url || '').includes(urlHint)) : pages[0];
  if (!hit) throw new Error('没有找到目标窗口' + (urlHint ? '（关键字 ' + urlHint + '）' : ''));
  return hit;
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
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.text || '') +
      ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* 已断开 */ } }
}

(async () => {
  const t = await pickTarget();
  const cdp = new Cdp(t.webSocketDebuggerUrl);
  await cdp.ready();
  try {
    const value = await cdp.evaluate(js);
    if (value !== undefined) console.log('返回值：', JSON.stringify(value));
    if (waitMs > 0) await sleep(waitMs);
    if (outFile) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(path.resolve(outFile), Buffer.from(shot.data, 'base64'));
      console.log('已截图', path.resolve(outFile));
    }
  } finally {
    cdp.close();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
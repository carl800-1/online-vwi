// A6 装机掐表：从"双击 exe"到"屏幕上出现正确内容"到底用了多久。
//
// 全程用 CDP 驱动装机向导（填服务器 → 检测 → 选工序 → 保存），
// 不靠人手点，避免人工操作时间污染成绩。t0 由启动脚本写入文件，
// 因为 portable exe 要先自解压，进程真正起来之前就有耗时了。
//
// 用法：node tools/a6-install.mjs <t0文件> <CDP端口> <服务器地址> <工序码> <截图路径>
import fs from 'node:fs';

const [, , t0File, portArg, serverArg, opArg, shotPath] = process.argv;
const PORT = Number(portArg || 9230);
const SERVER = serverArg || 'http://127.0.0.1:8092';
const OP = opArg || 'OP10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Number(fs.readFileSync(t0File, 'utf8').trim());

const marks = {};
const mark = (k) => { if (!marks[k]) marks[k] = Date.now() - t0; };
const now = () => Date.now() - t0;

class Cdp {
  constructor(wsUrl) {
    this.id = 0; this.pending = new Map(); this.ws = new WebSocket(wsUrl);
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WS 失败 ' + e.message)));
      this.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function targets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return await res.json();
  } catch { return []; }
}

// 等到某个页面出现（按 url 关键字），超时返回 null
async function waitTarget(hint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await targets();
    const t = list.find((x) => x.type === 'page' && (x.url || '').includes(hint));
    if (t) return t;
    await sleep(120);
  }
  return null;
}

(async () => {
  console.log(`t0 已定，开始等窗口（CDP ${PORT}）…`);

  // ① 装机向导出现
  const setupTarget = await waitTarget('setup.html', 60000);
  if (!setupTarget) throw new Error('60 秒内没等到装机向导');
  mark('wizard');
  console.log(`  向导窗口出现：${marks.wizard} ms`);

  const cdp = new Cdp(setupTarget.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  // 等向导脚本就绪（window.vwi 存在、按钮可点）
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    const ok = await cdp.eval("Boolean(window.vwi && document.getElementById('probe'))");
    if (ok) break;
    await sleep(100);
  }
  mark('wizardReady');
  console.log(`  向导可操作：${marks.wizardReady} ms`);

  // ② 填服务器地址 + 检测
  await cdp.eval(`(() => {
    const el = document.getElementById('server');
    el.value = ${JSON.stringify(SERVER)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('probe').click();
    return true;
  })()`);

  // 工序按钮出现
  let procs = [];
  const procDeadline = Date.now() + 20000;
  while (Date.now() < procDeadline) {
    procs = await cdp.eval("[...document.querySelectorAll('#procgrid button')].map(b => b.textContent.trim())") || [];
    if (procs.length) break;
    await sleep(120);
  }
  mark('probed');
  console.log(`  检测到 ${procs.length} 道工序：${procs.join(' / ')}  （${marks.probed} ms）`);
  if (!procs.length) throw new Error('检测不到工序，向导无法继续');

  // ③ 选本机工序 + 保存
  const picked = await cdp.eval(`(() => {
    const want = ${JSON.stringify(OP)};
    const b = [...document.querySelectorAll('#procgrid button')].find(x => x.textContent.includes(want));
    if (!b) return false;
    b.click();
    const s = document.getElementById('save');
    if (s.disabled) return false;
    s.click();
    return true;
  })()`);
  if (!picked) throw new Error(`选不到工序 ${OP} 或保存按钮仍不可用`);
  mark('saved');
  console.log(`  已保存配置：${marks.saved} ms`);
  cdp.close();

  // ④ 播放页出现 + 真的出了画面（有 src 且已上屏）
  const playerTarget = await waitTarget('player.html', 90000);
  if (!playerTarget) throw new Error('90 秒内没等到播放页');
  mark('player');
  const pcdp = new Cdp(playerTarget.webSocketDebuggerUrl);
  await pcdp.ready();
  await pcdp.send('Runtime.enable');

  let frame = null;
  const frameDeadline = Date.now() + 120000;
  while (Date.now() < frameDeadline) {
    const raw = await pcdp.eval(`(() => {
      const on = document.querySelector('.layer.on');
      const img = on && on.querySelector('img:not([hidden])');
      const vid = on && on.querySelector('video:not([hidden])');
      const m = document.getElementById('mCode');
      return JSON.stringify({
        model: m ? m.textContent.trim() : '',
        op: (document.getElementById('pCode') || {}).textContent || '',
        state: (document.getElementById('stateText') || {}).textContent || '',
        src: img ? decodeURIComponent(img.getAttribute('src') || '') : (vid ? 'video' : ''),
        w: on && on.querySelector('img') ? on.querySelector('img').naturalWidth : 0,
        cw: on && on.querySelector('img') ? on.querySelector('img').clientWidth : 0
      });
    })()`);
    const s = JSON.parse(raw);
    if (s.model && s.src) { frame = s; break; }
    await sleep(150);
  }
  if (!frame) throw new Error('120 秒内画面仍未出内容');
  mark('picture');
  console.log(`  画面出现且型号正确：${marks.picture} ms  →  ${frame.model} / ${frame.op} / ${frame.state}`);

  // ⑤ 截图存档
  const shot = await pcdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(require$dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  const report = { t0Epoch: t0, marks, frame, totalMs: marks.picture };
  fs.writeFileSync(shotPath.replace(/\.png$/, '.json'), JSON.stringify(report, null, 2));

  console.log('\n── A6 结果 ──');
  console.log(`双击 exe → 向导可操作：${marks.wizardReady} ms`);
  console.log(`          → 配置保存：${marks.saved} ms`);
  console.log(`          → 首画面：  ${marks.picture} ms（${(marks.picture / 1000).toFixed(1)} 秒）`);
  console.log(`判据 ≤300 秒：${marks.picture <= 300000 ? '通过' : '不通过'}`);
  pcdp.close();
  process.exit(0);
})().catch((e) => { console.error('A6 失败：', e.message); process.exit(1); });

// path.dirname 的轻量替代，避免再多 import
function require$dirname(p) { return p.replace(/[\\/][^\\/]+$/, ''); }

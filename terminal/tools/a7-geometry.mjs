// A7 几何实测：把播放页的视口改成真机面板尺寸（1280x1024），
// 量出顶栏/底栏占多高、图片实际被画成多大，从而算出 1 个屏幕像素等于多少毫米。
// 用法：node tools/a7-geometry.mjs [CDP端口]
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 9231);
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 12000);
    });
  }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result.value; }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && (t.url || '').includes('player.html')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到播放页');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false });
  // 播放页把 1280x1024 当设计画布、每 2 秒重新 fit 一次，等它跑完这一轮再量
  await sleep(2600);

  const raw = await cdp.eval(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
    const head = document.querySelector('header');
    const foot = document.querySelector('footer');
    const stage = document.querySelector('.stage');
    const on = document.querySelector('.layer.on');
    const img = on && on.querySelector('img:not([hidden])');
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      header: head ? r(head) : null,
      footer: foot ? r(foot) : null,
      stage: stage ? r(stage) : null,
      img: img ? { ...r(img), nw: img.naturalWidth, nh: img.naturalHeight, fit: getComputedStyle(img).objectFit } : null,
      model: (document.getElementById('mCode') || {}).textContent || ''
    });
  })()`);
  const g = JSON.parse(raw);

  const MM_PER_PX = 376.8 / 1280;     // 19" 5:4 面板，可视宽 376.8 mm 铺 1280 像素
  console.log('视口：', g.viewport.w + 'x' + g.viewport.h, 'DPR', g.viewport.dpr);
  console.log('顶栏：', g.header && g.header.h, 'px　底栏：', g.footer && g.footer.h, 'px　内容区：', g.stage && (g.stage.w + 'x' + g.stage.h));
  if (g.img) {
    // object-fit: contain —— 真正画出来的尺寸是按比例缩放到框内的最大值，不是元素框本身
    const s = Math.min(g.img.w / g.img.nw, g.img.h / g.img.nh);
    const pw = Math.round(g.img.nw * s), ph = Math.round(g.img.nh * s);
    console.log(`图片：原始 ${g.img.nw}x${g.img.nh} → 元素框 ${g.img.w}x${g.img.h} → 实画 ${pw}x${ph}（object-fit: ${g.img.fit}）`);
    console.log(`缩放比：${s.toFixed(3)}x　${s === 1 ? '1:1，无重采样' : '有重采样，细节会被平均掉'}`);
    console.log(`屏幕上 2 mm 特征 = ${(2 / MM_PER_PX).toFixed(1)} 屏像素`);
    if (s < 1) {
      console.log(`  但源图按 ${s.toFixed(3)}x 缩小后，这 2 mm 只剩 ${(2 / MM_PER_PX * s).toFixed(1)} 个源像素采样`);
      console.log(`  建议按 ${pw}x${ph} 或更小的画幅制作，正好铺满内容区、零缩放`);
    }
    console.log(`1.0 m 处 2 mm 张角 = ${(2 / 1000 * 180 / Math.PI * 60).toFixed(1)} 弧分（人眼极限 1 弧分，余量 ${(2 / 1000 * 180 / Math.PI * 60).toFixed(1)} 倍）`);
  }
  console.log('当前内容：', g.model || '(空)');
  const shotPath = process.argv[3];
  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('截图：', shotPath);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  cdp.ws.close();
  process.exit(0);
})().catch((e) => { console.error('几何实测失败：', e.message); process.exit(1); });

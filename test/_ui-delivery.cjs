// 交付版桌面冒烟：连交付版 exe 自己的窗口（CDP），验「系统设置」页并截图。
//
// 为什么要这么绕：系统页只有桌面程序才有（托盘 / 自启 / 本机路径全靠 preload 的 vwiDesktop）。
// 浏览器里点「系统设置」会被 `if (v === 'system' && !loadSysPanel) return` 拦掉，
// 所以在普通 BrowserWindow 里跑测试只能验 DOM 结构，验不到真实渲染。
//
//   # 先启动交付版，带调试端口
//   ESOP-Server.exe --remote-debugging-port=9333
//   # 再跑本脚本
//   node test/_ui-delivery.cjs            （默认 9333，可用 VWI_CDP 覆盖）
//
// 只读：只点导航、只取值、只截图，不改任何数据。
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.VWI_CDP || 9333);
const OUT = path.resolve(__dirname, '..', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (c, m, d) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fails.push(m); console.log('  ✗ ' + m + (d ? '　→ ' + d : '')); }
};

/** 最小 CDP 客户端：一条 WebSocket、id 自增、按 id 收结果 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} 超时`));
      }, 15000);
    });
  }

  /** 在页面里求值，自动包成表达式并等 Promise */
  async pick(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面里抛错了');
    return r.result.value;
  }
}

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return null;
}

(async function main() {
  const target = await findTarget();
  if (!target) {
    console.log(`连不上 CDP（127.0.0.1:${PORT}）。交付版要带 --remote-debugging-port=${PORT} 启动。`);
    process.exit(2);
  }
  console.log('连上：', target.url, '|', target.title);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 打不开')));
  });
  const cdp = new Cdp(ws);

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(600);

  console.log('\n① 桌面模式下多出「系统设置」这一项');
  const nav = await cdp.pick(`({
    items: [...document.querySelectorAll('.nav-item[data-view]')].map(b => b.dataset.view),
    sysText: (document.querySelector('.nav-item[data-view="system"]')?.textContent || '').trim(),
    desk: !!window.vwiDesktop
  })`);
  ok(nav.desk, 'preload 的 vwiDesktop 在（真的是桌面模式）');
  ok(nav.items.length === 5, `导航 ${nav.items.length} 项：${nav.items.join(' / ')}`, nav.items.join(','));
  ok(nav.sysText === '系统设置', `末项文案：${nav.sysText}`);

  console.log('\n② 点进去：标题、本机信息、没有线体清单');
  await cdp.pick(`(function(){ document.querySelector('.nav-item[data-view="system"]').click(); return true; })()`);
  await sleep(1200);
  const sys = await cdp.pick(`({
    title: (document.getElementById('viewTitle')?.textContent || '').trim(),
    hidden: document.getElementById('view-system').classList.contains('hide'),
    ver: (document.getElementById('sysVer')?.textContent || '').trim(),
    port: (document.getElementById('sysPort')?.textContent || '').trim(),
    auto: (document.getElementById('sysAutoTxt')?.textContent || '').trim(),
    data: (document.getElementById('sysData')?.textContent || '').trim(),
    log: (document.getElementById('sysLog')?.textContent || '').trim(),
    lan: [...document.querySelectorAll('#sysLan .lan-item b')].map(b => b.textContent.trim()),
    lines: document.querySelectorAll('#sysLines, #view-system .sys-line').length,
    statusSel: document.querySelectorAll('#view-system [data-lstatus]').length,
    text: (document.getElementById('view-system').textContent || '').replace(/\s+/g, ' ').trim()
  })`);
  ok(sys.title === '系统设置', `视图标题：${sys.title}`);
  ok(!sys.hidden, '系统设置视图已显示');
  ok(/^v\d/.test(sys.ver), `版本：${sys.ver}`);
  ok(sys.port === '8092', `服务端口：${sys.port}`);
  ok(sys.auto.length > 0, `开机自启：${sys.auto}`);
  ok(sys.data.length > 3 && sys.log.length > 3, `数据目录 / 日志都填上了`);
  ok(sys.lan.length >= 1, `终端要填的地址 ${sys.lan.length} 条：${sys.lan.join(' , ')}`);
  ok(sys.lines === 0 && sys.statusSel === 0, '「本厂线体」清单确实不在了', String(sys.lines));
  ok(!/本厂线体/.test(sys.text), '页面文字里也没有「本厂线体」');
  ok(!/生产输入|文件查询/.test(sys.text), '没有 生产输入 / 文件查询 的残留文案');

  console.log('\n③ 截图');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-system.png'), Buffer.from(shot.data, 'base64'));
  ok(true, 'docs/ui-5.0.1-system.png');

  console.log('\n④ 这一页的「刷新」真的会重读本机信息');
  await cdp.pick(`(function(){ document.getElementById('refreshBtn').click(); return true; })()`);
  await sleep(700);
  const after = await cdp.pick(`({
    title: (document.getElementById('viewTitle')?.textContent || '').trim(),
    ver: (document.getElementById('sysVer')?.textContent || '').trim(),
    port: (document.getElementById('sysPort')?.textContent || '').trim(),
    toasts: [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent.trim())
  })`);
  ok(after.title === '系统设置', `点完还停在这一页：${after.title}`);
  ok(/^v\d/.test(after.ver) && after.port === '8092', `重读后信息还在：${after.ver} / ${after.port}`);
  ok(after.toasts.some((t) => /已刷新/.test(t)), `提示：${after.toasts.join(' / ') || '（没有浮层）'}`);

  console.log('\n⑤ 上传进度浮层：3 条封顶 + 5 秒自动收');
  // 不真传文件：uplRow 是全局函数，直接造 8 条「已完成」的行看渲染与尺寸
  const upl = await cdp.pick(`(function(){
    const box = $('uplList');
    box.innerHTML = '';
    box.classList.add('hide');
    for (let i = 1; i <= 8; i++) uplRow('CB18FE-0' + i + '.jpg').ok();
    const rows = [...box.querySelectorAll('.uplrow')].map((el) => el.querySelector('.nm').textContent);
    return { rows, h: Math.round(box.getBoundingClientRect().height) };
  })()`);
  ok(upl.rows.length === 3, `造 8 条只留 ${upl.rows.length} 条：${upl.rows.join(' / ')}`);
  ok(upl.h > 0 && upl.h <= 150, `浮层高度 ${upl.h}px（3 行封顶）`);
  await sleep(300);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-upload.png'), Buffer.from(shot2.data, 'base64'));
  ok(true, 'docs/ui-5.0.1-upload.png');
  await cdp.pick(`(function(){ scheduleUplHide(); return true; })()`);
  await sleep(5300);
  const gone = await cdp.pick(`({ rows: $('uplList').children.length, hidden: $('uplList').classList.contains('hide') })`);
  ok(gone.hidden && gone.rows === 0, '5 秒后自动消失并清空', JSON.stringify(gone));

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log(' - ' + f)); }
  ws.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log('出错：', e.message);
  process.exit(3);
});

// 播放页「内容被『播放内容』全排除」的清屏点检（终端 1.8.3）。
//
//   terminal/node_modules/electron/dist/electron.exe terminal/test/_ui-empty.cjs
//
// 换样式改文案之后跑一遍：这条路径以前是"什么都不做"，屏上继续播被勾掉的旧内容，
// 所以这里验的不是好看，是**旧画面到底有没有被清掉**、**有没有 ack**。
// 不连服务器，直接调页面里的 applyView()，和 _shot-player.cjs 一个路子。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const OUT = path.resolve(__dirname, '..', '..', 'docs');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fails.push(msg); console.log('  ✗ ' + msg + (detail ? '　→ ' + detail : '')); }
};

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-ui-empty-'));
  const png = path.join(tmp, 'a.png');
  fs.writeFileSync(png, PNG);
  const url = 'file:///' + png.replace(/\\/g, '/');

  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    backgroundColor: '#0f1319',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'));
  await sleep(500);

  // 假 bridge：只收 flipped，够判断"有没有 ack"
  await win.webContents.executeJavaScript(
    // 返回 undefined：executeJavaScript 会序列化最后一句的值，函数不可克隆会直接报错
    `window.vwi = { flipped: (p) => { (window.__acks = window.__acks || []).push(p); }, log: () => {} }; undefined`
  );

  // 页面里的 $ 是顶层 const，直接在 executeJavaScript 里再声明会撞车 → 一律包进 IIFE
  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );

  // ── A 正常一套内容 ──
  console.log('\nA 有内容（1 张图）');
  await win.webContents.executeJavaScript(
    `applyView(${JSON.stringify({
      id: 1, modelCode: 'T9900', modelId: 'md1', reason: 'switch',
      items: [{ url, kind: 'image', dwellSec: 5, fit: 'contain', zoom: 100 }]
    })})`
  );
  await sleep(500);
  const a = await pick(`{ wait: $('wait').hidden, total: $('total').textContent }`);
  ok(a.wait === true, '等待页隐藏，画面在播');
  ok(a.total === '1', '顶栏内容计数 = 1');

  // ── B 内容被「播放内容」全排除 ──
  console.log('\nB 清单变 0 项（3 项被播放内容排除）');
  await win.webContents.executeJavaScript(
    `applyView(${JSON.stringify({
      id: 2, modelCode: 'T9900', modelId: 'md1', reason: 'switch', items: [], hidden: 3
    })})`
  );
  await sleep(500);
  const b = await pick(`({
    wait: $('wait').hidden,
    title: $('waitTitle').textContent,
    text: $('waitText').textContent,
    hint: $('waitHint').textContent,
    total: $('total').textContent,
    acks: window.__acks || []
  })`);
  ok(b.wait === false, '等待页必须显示出来（不能留旧画面）', JSON.stringify(b.wait));
  ok(b.title.includes('暂停播放'), '标题说清是被挡的：' + b.title);
  ok(b.text.includes('3 项被排除'), '正文带上被排除的项数：' + b.text);
  ok(b.hint.includes('播放内容'), '提示指向「机种设置 · 播放内容」');
  ok(b.total === '0', '顶栏内容计数归零');
  ok(b.acks.some((x) => x.id === 2 && x.ok), '已 ack 成功（否则主进程会当成翻转失败、保留旧画面）');

  await win.webContents.capturePage();          // 先空捕一次，隐藏窗口拿到的是上一帧
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-1.8.3-empty-content.png'), img.toPNG());
  console.log('  截图 docs/ui-1.8.3-empty-content.png');

  // ── C 勾回来要自己恢复 ──
  console.log('\nC 勾回来（0 → 1 项）');
  await win.webContents.executeJavaScript(
    `applyView(${JSON.stringify({
      id: 3, modelCode: 'T9900', modelId: 'md1', reason: 'switch',
      items: [{ url, kind: 'image', dwellSec: 5, fit: 'contain', zoom: 100 }]
    })})`
  );
  await sleep(500);
  const c = await pick(`{ wait: $('wait').hidden, total: $('total').textContent, hidden: S.hidden }`);
  ok(c.wait === true, '等待页隐藏，恢复播放');
  ok(c.total === '1', '顶栏内容计数回到 1');
  ok(c.hidden === 0, '"被排除"计数已清零（否则顶栏会一直挂着旧提示）');

  // ── D 真空清单（本来就没内容）不在这里改行为 ──
  console.log('\nD 真空清单（hidden=0）仍保留旧画面，只告警');
  await win.webContents.executeJavaScript(
    `applyView(${JSON.stringify({
      id: 4, modelCode: 'T9900', modelId: 'md2', reason: 'switch', items: [], hidden: 0
    })})`
  );
  await sleep(500);
  const d = await pick(`{ wait: $('wait').hidden, total: $('total').textContent }`);
  ok(d.wait === true, '不黑屏：旧画面保持（1.7.x 的老行为不动）');
  ok(d.total === '1', '旧内容计数不变');

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('  · ' + f);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  win.destroy();
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error('失败', (e && e.stack) || e); app.exit(2); });

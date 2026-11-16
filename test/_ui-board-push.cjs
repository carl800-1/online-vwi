// 作业内容页「推送面板 + 生产概况柱状图」界面点检（5.0.0）。
//
//   VWI_UI_BASE=http://127.0.0.1:8093 electron test/_ui-board-push.cjs
//
// ⚠️ 服务要在外面先起好。验四件事：
//   1) 运行产线卡片出现「运行产线 / 该产线下机种（多选）」两个下拉，选线后机种下拉有选项
//   2) 选机种后下面列出机种卡片，每个带「推送」按钮
//   3) 生产概况变成柱状图（空态给引导文案，不再显示 KPI 那套）
//   4) 页面无 console 报错
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8093';
const OUT = path.resolve(__dirname, '..', 'docs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (c, m, d) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fails.push(m); console.log('  ✗ ' + m + (d ? '　→ ' + d : '')); } };

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    // 只记 error。Electron 加载远程 URL 会报 CSP 警告（打包版不出现），不算问题
    if (level >= 3) errors.push(message);
  });

  await win.loadURL(BASE + '/');
  await sleep(3000);   // 等 board 2 秒刷新 + prod 加载

  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );

  console.log('\n① 推送面板两个下拉');
  const hasPanel = await pick(`!!document.getElementById('pushLine') && !!document.getElementById('pushModels')`);
  ok(hasPanel, '运行产线卡片出现两个下拉');
  const lineOpts = await pick(`document.getElementById('pushLine').options.length`);
  ok(lineOpts > 0, `「运行产线」下拉有 ${lineOpts} 个选项（应 = 运行中线数）`, String(lineOpts));
  const selLineId = await pick(`document.getElementById('pushLine').value`);
  ok(!!selLineId, '默认选中第一条运行产线');

  console.log('\n② 选机种 → 列出推送按钮');
  const modelOpts = await pick(`document.getElementById('pushModels').options.length`);
  ok(modelOpts > 0, `「该产线下机种」下拉有 ${modelOpts} 个选项`, String(modelOpts));
  // 模拟选一个机种，触发 change → renderPushList
  await pick(`(function(){ const s=document.getElementById('pushModels'); s.options[0].selected=true; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  const rows = await pick(`document.querySelectorAll('.push-row').length`);
  const hasPushBtn = await pick(`document.querySelectorAll('.push-row [data-pushmodel]').length`);
  ok(rows >= 1, `选机种后列出 ${rows} 个机种卡片`, String(rows));
  ok(hasPushBtn === rows, `每个机种卡片都有「推送」按钮（${hasPushBtn}/${rows}）`);

  console.log('\n③ 生产概况 = 柱状图（跟随选中的线）');
  const pSub = await pick(`document.getElementById('pSub').textContent`);
  ok(pSub && !/生产概况/.test(pSub), '副标题改为「线名 · 各机种产量」之类', pSub);
  const kpiGone = await pick(`!document.querySelector('.pkpi')`);
  ok(kpiGone, '原来的 KPI 四格已移除');
  const body = await pick(`document.getElementById('pBody').innerText`);
  // 交付库没有产量台账 → 应该是空态引导（含"生产输入"字样），不是 KPI 数字
  ok(/生产输入/.test(body), '无产量时给「去生产输入录入」的引导', body.slice(0, 30));

  console.log('\n④ 无 console 报错');
  ok(errors.length === 0, '页面无 warning/error', errors.slice(0, 3).join(' | '));

  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-5.0.0-board-push.png'), img.toPNG());
  console.log('  截图 docs/ui-5.0.0-board-push.png');

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('  · ' + f);
  win.destroy();
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error('失败', (e && e.stack) || e); app.exit(2); });

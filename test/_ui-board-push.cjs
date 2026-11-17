// 作业内容页「推送面板」界面点检。
//
//   node test/_seed-ui.mjs                     # 先备数据（两条运行线 + 三个机种）
//   VWI_UI_BASE=http://127.0.0.1:8093 electron test/_ui-board-push.cjs
//
// ⚠️ 服务要在外面先起好（隔离库，别打交付目录）。验这些事：
//   1) 机种面板**默认收起**（5.0.1 修的就是"常开的 multiple 列表选了收不回去"）
//   2) 点开有候选、搜索能过滤、搜不到有提示
//   3) 勾一个机种 → 下面出现对应的「推送」按钮，按钮文案跟着变
//   4) 点「收起」能缩回去，已勾的机种不丢
//   5) 点「推送」→ 面板自动收起，服务端 current 机种真的变了，行上标「正在生产」
//   6) 换到没挂机种的线 → 展开时给「这条线还没挂机种」
//   7) 全程无 console 报错
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
  await sleep(3000);   // 等 board 2 秒刷新 + 线体懒加载

  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );
  const pickAsync = (body) => win.webContents.executeJavaScript(
    `(async () => { const $ = (id) => document.getElementById(id); ${body} })()`
  );

  console.log('\n① 面板结构：默认收起');
  const shape = await pick(`({
    line: !!$('pushLine'),
    picker: !!$('pushPicker'),
    hidden: $('pushPick').hidden,
    label: $('pushPickerText').textContent.trim(),
    legacy: !!$('pushModels'),
    lineOpts: $('pushLine').options.length
  })`);
  ok(shape.line && shape.picker, '有「运行产线」下拉和「选机种」按钮');
  ok(!shape.legacy, '常开的 multiple 多选列表已移除（#pushModels 不存在）');
  ok(shape.hidden === true, '机种面板默认是收起的', JSON.stringify(shape.hidden));
  ok(/选机种/.test(shape.label), `按钮默认文案：${shape.label}`);
  ok(shape.lineOpts > 0, `「运行产线」下拉有 ${shape.lineOpts} 个选项`, String(shape.lineOpts));

  console.log('\n② 点开：候选 + 搜索过滤');
  await pick(`(function(){ $('pushPicker').click(); return true; })()`);
  await sleep(400);
  const opened = await pick(`({
    hidden: $('pushPick').hidden,
    opts: [...document.querySelectorAll('#pushOpts .push-opt')].map(l => l.textContent.trim()),
    cnt: $('pushPickCnt').textContent.trim()
  })`);
  ok(opened.hidden === false, '点一下能展开');
  ok(opened.opts.length >= 3, `列出 ${opened.opts.length} 个候选机种：${opened.opts.slice(0, 3).join(' / ')}`);

  await pick(`(function(){ const q=$('pushSearch');
    q.value=${JSON.stringify('ZZZZ')}; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  const noHit = await pick(`({ n: document.querySelectorAll('#pushOpts .push-opt').length, txt: $('pushOpts').textContent.trim() })`);
  ok(noHit.n === 0 && /没有匹配/.test(noHit.txt), '搜不到时给「没有匹配」提示', JSON.stringify(noHit));

  await pick(`(function(){ const q=$('pushSearch');
    q.value=${JSON.stringify('C7')}; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  const hit = await pick(`[...document.querySelectorAll('#pushOpts .push-opt')].map(l => l.querySelector('.push-opt-c').textContent.trim())`);
  ok(hit.length >= 1 && hit.every((c) => /C7/i.test(c)), `搜「C7」只剩 ${hit.length} 个：${hit.join(' / ')}`, hit.join(','));

  console.log('\n③ 勾选 → 出现「推送」按钮');
  await pick(`(function(){ const q=$('pushSearch'); q.value=''; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  await pick(`(function(){ document.querySelector('#pushOpts .push-opt input').click(); return true; })()`);
  await sleep(350);
  const picked = await pick(`({
    rows: document.querySelectorAll('.push-row').length,
    btns: document.querySelectorAll('.push-row [data-pushmodel]').length,
    cnt: $('pushPickCnt').textContent.trim(),
    label: $('pushPickerText').textContent.trim(),
    code: document.querySelector('#pushOpts .push-opt.on .push-opt-c')?.textContent.trim() || ''
  })`);
  ok(picked.rows === 1 && picked.btns === 1, `勾一个机种后出现 ${picked.rows} 个机种卡片 / ${picked.btns} 个「推送」`);
  ok(/已勾选 1 个/.test(picked.cnt), `已勾选计数：${picked.cnt}`);
  ok(picked.label === picked.code, `按钮文案变成所选机种：${picked.label}`);
  const pushCode = picked.code;

  console.log('\n④ 点「收起」能缩回去（本版修的点）');
  await pick(`(function(){ $('pushFold').click(); return true; })()`);
  await sleep(300);
  const folded = await pick(`({
    hidden: $('pushPick').hidden,
    rows: document.querySelectorAll('.push-row').length,
    label: $('pushPickerText').textContent.trim(),
    expanded: $('pushPicker').getAttribute('aria-expanded')
  })`);
  ok(folded.hidden === true, '面板收起来了（原来这个 multiple 列表永远摊着）');
  ok(folded.expanded === 'false', 'aria-expanded = false');
  ok(folded.rows === 1, '已勾的机种没丢，推送按钮还在');
  ok(folded.label === pushCode, `收起后按钮仍显示所选机种：${folded.label}`);

  console.log('\n⑤ 点「推送」→ 自动收起 + 服务端真的切了');
  await pick(`(function(){ $('pushPicker').click(); return true; })()`);
  await sleep(250);
  await pick(`(function(){ const b=document.querySelector('.push-row [data-pushmodel]'); b.click(); return true; })()`);
  await sleep(1500);
  const after = await pick(`({ hidden: $('pushPick').hidden })`);
  ok(after.hidden === true, '推送完面板自动收起');

  const server = await pickAsync(`
    const j = await fetch('/api/board').then(r => r.json());
    const l = j.lines.find(x => x.id === $('pushLine').value) || j.lines[0];
    return { code: l.currentModelCode, name: l.currentModelName };
  `);
  ok(server.code === pushCode, `服务端「正在生产」=${server.code}（期望 ${pushCode}）`, JSON.stringify(server));

  await sleep(2300);   // 等一轮 board 刷新，行上应该标「正在生产」
  const mark = await pick(`({
    cur: [...document.querySelectorAll('#board .rl')].map(r => r.innerText.replace(/\\s+/g,' ').trim()).filter(t => /正在生产/.test(t)).length,
    rows: document.querySelectorAll('.push-row').length
  })`);
  ok(mark.cur >= 1, '运行产线行上标出了「正在生产」', JSON.stringify(mark));

  console.log('\n⑥ 换到没挂机种的线 → 空态');
  const lines = await pick(`[...$('pushLine').options].map(o => ({ v: o.value, t: o.textContent.trim() }))`);
  if (lines.length >= 2) {
    await pick(`(function(){ const s=$('pushLine'); s.selectedIndex=1; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(600);
    await pick(`(function(){ if ($('pushPick').hidden) $('pushPicker').click(); return true; })()`);
    await sleep(500);
    const empty = await pick(`({ opts: document.querySelectorAll('#pushOpts .push-opt').length, txt: $('pushOpts').textContent.trim(), hidden: $('pushPick').hidden })`);
    ok(empty.opts === 0 && /没挂机种/.test(empty.txt), `空线给提示：${empty.txt.slice(0, 24)}`, JSON.stringify(empty).slice(0, 120));
    ok(empty.hidden === false, '空线也能展开（看到提示，而不是打不开）');
  } else {
    console.log('  - 只有 1 条运行线，跳过空态检查');
  }

  console.log('\n⑦ 控制台');
  ok(errors.length === 0, '页面无 console 报错', errors.slice(0, 3).join(' | '));

  // 截图：回到第一条线、展开面板，留一张有内容的图
  await pick(`(function(){ const s=$('pushLine'); s.selectedIndex=0; s.dispatchEvent(new Event('change'));
    if ($('pushPick').hidden) $('pushPicker').click(); return true; })()`);
  await sleep(900);
  await win.webContents.capturePage();
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-push.png'), img.toPNG());
  console.log('  截图 docs/ui-5.0.1-push.png');

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('  · ' + f);
  win.destroy();
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error('失败', (e && e.stack) || e); app.exit(2); });

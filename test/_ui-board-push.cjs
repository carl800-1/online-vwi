// 作业内容页界面点检：单线 + 当天机种清单。
//
//   node test/_seed-ui.mjs                     # 先备数据（两条运行线 + 三个机种）
//   VWI_UI_BASE=http://127.0.0.1:8093 electron test/_ui-board-push.cjs
//
// ⚠️ 服务要在外面先起好（隔离库，别打交付目录）。验这些事：
//   1) 不再一行一条铺线体列表（.rl / #board 都没了），只有一行信息 + 一句说明
//   2) 「+ 添加机种」默认收起，点开有候选、搜索能过滤、搜不到有提示
//   3) 勾机种 → 下面清单按勾选顺序出现，序号 1、2…
//   4) ↑↓ 能改顺序，刷新页面顺序还在（localStorage）
//   5) 点「推送」→ 面板自动收起 → 服务端正在生产的机种真的变了 → 该行标「正在生产 / 已推送」
//   6) × 能从清单移除，屏上内容不受影响
//   7) 只有一条运行线时没有下拉，只有线号文字
//   8) 换到没挂机种的线 → 「这条线还没挂机种」
//   9) 全程无 console 报错
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
    if (level >= 3) errors.push(message);
  });

  await win.loadURL(BASE + '/');
  await sleep(3000);

  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );
  const pickAsync = (body) => win.webContents.executeJavaScript(
    `(async () => { const $ = (id) => document.getElementById(id); ${body} })()`
  );

  // 上一轮留下的清单会干扰计数，先按线体全清掉
  await pick(`(function(){ Object.keys(localStorage).filter(k => k.startsWith('esop.plan.')).forEach(k => localStorage.removeItem(k)); return true; })()`);
  await win.webContents.reload();
  await sleep(2600);

  console.log('\n① 页面结构：不再铺线体列表，只有一行信息');
  const shape = await pick(`({
    hint: document.querySelector('.board-hint')?.textContent.trim() || '',
    bar: !!$('boardBar'),
    rows: document.querySelectorAll('#boardBar .rl, #board .rl').length,
    legacyList: !!$('board'),
    picker: !!$('pushPicker'),
    pickerText: $('pushPickerText').textContent.trim(),
    pickHidden: $('pushPick').hidden,
    planRows: document.querySelectorAll('.plan-row').length,
    empty: document.querySelector('.plan-empty')?.textContent.replace(/\\s+/g,' ').trim() || ''
  })`);
  ok(/排列当天要生产的机种/.test(shape.hint) && /推送/.test(shape.hint), `说明文案：${shape.hint}`);
  ok(shape.rows === 0 && !shape.legacyList, '不再一行一条铺线体列表（#board / .rl 已移除）', JSON.stringify(shape));
  ok(shape.bar && shape.picker, '有一行信息（作业线 / 正在生产 / 在线数 / 添加机种）');
  ok(shape.pickHidden === true, '机种面板默认收起');
  ok(/添加机种/.test(shape.pickerText), `按钮文案：${shape.pickerText}`);
  ok(shape.planRows === 0 && /清单还是空的/.test(shape.empty), `空清单给提示：${shape.empty.slice(0, 26)}`);

  console.log('\n② 点开：候选 + 搜索过滤');
  await pick(`(function(){ $('pushPicker').click(); return true; })()`);
  await sleep(400);
  const opened = await pick(`({
    hidden: $('pushPick').hidden,
    opts: [...document.querySelectorAll('#pushOpts .push-opt')].map(l => l.querySelector('.push-opt-c').textContent.trim())
  })`);
  ok(opened.hidden === false, '点一下能展开');
  ok(opened.opts.length >= 3, `列出 ${opened.opts.length} 个候选：${opened.opts.slice(0, 3).join(' / ')}`);

  await pick(`(function(){ const q=$('pushSearch'); q.value='ZZZZ'; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  const noHit = await pick(`({ n: document.querySelectorAll('#pushOpts .push-opt').length, txt: $('pushOpts').textContent.trim() })`);
  ok(noHit.n === 0 && /没有匹配/.test(noHit.txt), '搜不到给「没有匹配」提示');

  await pick(`(function(){ const q=$('pushSearch'); q.value='C7'; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  const hit = await pick(`[...document.querySelectorAll('#pushOpts .push-opt')].map(l => l.querySelector('.push-opt-c').textContent.trim())`);
  ok(hit.length >= 1 && hit.every((c) => /C7/i.test(c)), `搜「C7」只剩 ${hit.length} 个：${hit.join(' / ')}`);

  console.log('\n③ 勾两个 → 清单按顺序出现');
  await pick(`(function(){ const q=$('pushSearch'); q.value=''; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  const picked = await pick(`(function(){
    const ins = [...document.querySelectorAll('#pushOpts .push-opt input')].slice(0, 2);
    ins.forEach(i => { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
    return ins.map(i => i.value);
  })()`);
  await sleep(400);
  const plan1 = await pick(`({
    nos: [...document.querySelectorAll('.plan-row .plan-no')].map(e => e.textContent.trim()),
    codes: [...document.querySelectorAll('.plan-row .plan-code')].map(e => e.textContent.trim()),
    btns: [...document.querySelectorAll('.plan-row [data-planpush]')].map(e => e.textContent.trim()),
    cnt: $('planCnt').textContent.trim(),
    head: $('planHead').hidden
  })`);
  ok(plan1.codes.length === 2, `清单里出现 ${plan1.codes.length} 行`);
  ok(plan1.codes.join(',') === picked.join(','), `顺序跟勾选一致：${plan1.codes.join(' → ')}`, 'pick=' + picked.join(','));
  ok(plan1.nos.join(',') === '1,2', `序号 1、2：${plan1.nos.join(',')}`);
  ok(plan1.btns.every((t) => t === '推送' || t === '已推送'),
    `每行都有推送按钮：${plan1.btns.join(' / ')}`);
  ok(plan1.btns.filter((t) => t === '推送').length >= 1, '至少有一行还没推送（能点）');
  ok(/共 2 个/.test(plan1.cnt) && plan1.head === false, `清单标题计数：${plan1.cnt}`);

  console.log('\n④ ↑↓ 改顺序');
  await pick(`(function(){ document.querySelector('.plan-row [data-plandown]').click(); return true; })()`);
  await sleep(300);
  const plan2 = await pick(`[...document.querySelectorAll('.plan-row .plan-code')].map(e => e.textContent.trim())`);
  ok(plan2[0] === picked[1] && plan2[1] === picked[0], `下移后顺序：${plan2.join(' → ')}`);
  ok(await pick(`!!document.querySelector('.plan-row:first-child [data-planup]').disabled`), '第一行的 ↑ 是禁用的');

  console.log('\n⑤ 刷新页面，顺序还在（本机记住）');
  await win.webContents.reload();
  await sleep(2600);
  const plan3 = await pick(`[...document.querySelectorAll('.plan-row .plan-code')].map(e => e.textContent.trim())`);
  ok(plan3.join(',') === plan2.join(','), `刷新后清单仍是：${plan3.join(' → ')}`, '期望 ' + plan2.join(','));

  console.log('\n⑥ 推送 → 面板收起 + 服务端真的切了');
  await pick(`(function(){ $('pushPicker').click(); return true; })()`);
  await sleep(250);
  // 上一轮可能已经设过当前机种，挑一条还没推的来点（已推送的按钮是禁用的）
  const topCode = await pick(`(function(){
    const b = [...document.querySelectorAll('.plan-row [data-planpush]')].find(x => x.textContent.trim() === '推送');
    return b ? b.dataset.planpush : '';
  })()`);
  ok(!!topCode, `清单里有一条可推送：${topCode || '（没有，全是已推送）'}`);
  await pick(`(function(){
    const b = [...document.querySelectorAll('.plan-row [data-planpush]')].find(x => x.textContent.trim() === '推送');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1600);
  const afterPush = await pick(`({ hidden: $('pushPick').hidden })`);
  ok(afterPush.hidden === true, '推送完候选面板自动收起');

  const server = await pickAsync(`
    const j = await fetch('/api/board').then(r => r.json());
    const lid = document.querySelector('[data-pickcur]')?.dataset.pickcur;
    const l = j.lines.find(x => x.id === lid) || j.lines.find(x => x.status === 'running');
    return { code: l.currentModelCode, name: l.name };
  `);
  ok(server.code === topCode, `服务端「正在生产」=${server.code}（期望 ${topCode}）`, JSON.stringify(server));

  await sleep(2400);   // 等一轮 board 刷新
  const mark = await pick(`(function(){
    const row = [...document.querySelectorAll('.plan-row')].find(r => r.dataset.code === ${JSON.stringify(topCode)});
    const b = row && row.querySelector('[data-planpush]');
    return {
      tag: (row && row.querySelector('.plan-tag')?.textContent.trim()) || '',
      btn: (b && b.textContent.trim()) || '',
      disabled: !!(b && b.disabled),
      barCode: document.querySelector('.bar-code')?.textContent.trim() || ''
    };
  })()`);
  ok(/正在生产/.test(mark.tag), `被推的那行标出「${mark.tag}」`);
  ok(mark.btn === '已推送' && mark.disabled, `该行按钮变成「${mark.btn}」并禁用`, JSON.stringify(mark));
  ok(mark.barCode === topCode, `上面一行信息里的正在生产 = ${mark.barCode}`);

  console.log('\n⑦ × 从清单移除（屏上内容不受影响）');
  const before = await pick(`document.querySelectorAll('.plan-row').length`);
  const removedCode = await pick(`document.querySelector('.plan-row .plan-code').textContent.trim()`);
  await pick(`(function(){ document.querySelector('.plan-row [data-plandel]').click(); return true; })()`);
  await sleep(300);
  const afterDel = await pick(`({
    n: document.querySelectorAll('.plan-row').length,
    nos: [...document.querySelectorAll('.plan-row .plan-no')].map(e => e.textContent.trim()),
    codes: [...document.querySelectorAll('.plan-row .plan-code')].map(e => e.textContent.trim()),
    tag: document.querySelectorAll('.plan-row .plan-tag').length
  })`);
  ok(afterDel.n === before - 1, `移除后剩 ${afterDel.n} 行`);
  ok(afterDel.nos.join(',') === afterDel.nos.map((_, i) => i + 1).join(','), `序号重新排成 ${afterDel.nos.join(',')}`);
  ok(!afterDel.codes.includes(removedCode), `被移除的 ${removedCode} 已不在清单里`);
  const still = await pickAsync(`
    const j = await fetch('/api/board').then(r => r.json());
    const l = j.lines.find(x => x.id === document.querySelector('[data-pickcur]')?.dataset.pickcur);
    return { code: l ? l.currentModelCode : '' };
  `);
  ok(still.code === topCode, `屏上仍在播 ${still.code}（移除清单不影响已推送的内容）`, JSON.stringify(still));

  console.log('\n⑧ 换到没挂机种的线');
  const two = await pick(`(function(){
    const s = $('pushLine');
    if (!s || s.options.length < 2) return false;
    s.selectedIndex = 1; s.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`);
  if (two) {
    await sleep(700);
    await pick(`(function(){ if ($('pushPick').hidden) $('pushPicker').click(); return true; })()`);
    await sleep(400);
    const empty = await pick(`({ opts: document.querySelectorAll('#pushOpts .push-opt').length, txt: $('pushOpts').textContent.trim() })`);
    ok(empty.opts === 0 && /没挂机种/.test(empty.txt), `空线给提示：${empty.txt.slice(0, 22)}`);
    // 恢复回第一条
    await pick(`(function(){ const s=$('pushLine'); s.selectedIndex=0; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(600);
  } else {
    console.log('  - 只有 1 条运行线，跳过（单线是现场常态，见 ⑨）');
  }

  console.log('\n⑨ 只留一条运行线 → 不再有下拉');
  const single = await pickAsync(`
    const j = await fetch('/api/board').then(r => r.json());
    const run = j.lines.filter(l => l.status === 'running');
    if (run.length < 2) return { skipped: true, run: run.length };
    // 停掉除第一条外的所有线，看单线形态
    for (const l of run.slice(1)) {
      await fetch('/api/lines/' + encodeURIComponent(l.id), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'stopped' })
      });
    }
    return { skipped: false, stopped: run.slice(1).map(l => l.id) };
  `);
  if (!single.skipped) {
    await win.webContents.reload();
    await sleep(2600);
    const one = await pick(`({
      sel: !!$('pushLine'),
      line: document.querySelector('.bar-line')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      sub: $('runSub').textContent.trim()
    })`);
    ok(one.sel === false, '单线时没有下拉（只有线号文字）');
    ok(one.line.length > 0, `显示当前作业线：${one.line}`);
    ok(/1 条线在运行/.test(one.sub), `副标题：${one.sub}`);

    // 截图留一张单线形态（现场就长这样）
    await win.webContents.capturePage();
    await sleep(400);
    let img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'ui-5.0.1-plan.png'), img.toPNG());
    console.log('  截图 docs/ui-5.0.1-plan.png');

    // 恢复成两条，别影响后面的手动验收
    await pickAsync(`
      for (const id of ${JSON.stringify(single.stopped)}) {
        await fetch('/api/lines/' + encodeURIComponent(id), {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'running' })
        });
      }
      return true;
    `);
  } else {
    console.log('  - 本来就只有一条运行线，跳过');
  }

  console.log('\n⑩ 控制台');
  ok(errors.length === 0, '页面无 console 报错', errors.slice(0, 3).join(' | '));

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('  · ' + f);
  win.destroy();
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error('失败', (e && e.stack) || e); app.exit(2); });

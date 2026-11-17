// 5.0.1 界面减法点检：导航只剩 5 项、作业内容只有推送面板、终端监控单视图、系统页有线体清单。
//
//   VWI_UI_BASE=http://127.0.0.1:8093 electron test/_ui-501.cjs
//
// ⚠️ 服务要在外面先起好（隔离库，别打交付目录）。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8093';
const OUT = path.resolve(__dirname, '..', 'docs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (c, m, d) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fails.push(m); console.log('  ✗ ' + m + (d ? '　→ ' + d : '')); }
};

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
  await sleep(2500);

  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );

  console.log('\n① 导航只剩 5 项');
  const nav = await pick(`[...document.querySelectorAll('.nav-item[data-view]')].map(b => b.dataset.view)`);
  ok(nav.length === 5, `导航 ${nav.length} 项：${nav.join(' / ')}`, nav.join(','));
  ok(!nav.includes('prod') && !nav.includes('lines') && !nav.includes('files'),
    '没有 生产输入 / 线体设置 / 文件查询');

  console.log('\n② 作业内容：只有推送面板 + 运行产线');
  const hasPanel = await pick(`!!$('pushLine') && !!$('pushModels') && !!$('board')`);
  ok(hasPanel, '推送面板和运行产线列表都在');
  const dead = await pick(`({
    pcard: !!document.getElementById('pBody'),
    bsum: !!document.getElementById('bsum'),
    bhelp: !!document.querySelector('.bhelp'),
    chart: document.querySelectorAll('.pchart').length
  })`);
  ok(!dead.pcard && !dead.bsum && !dead.bhelp && !dead.chart,
    '生产概况 / 产线概览 / 操作说明 / 柱状图 都已移除', JSON.stringify(dead));

  const lineOpts = await pick(`$('pushLine').options.length`);
  ok(lineOpts > 0, `「运行产线」下拉有 ${lineOpts} 个选项`, String(lineOpts));
  await pick(`(function(){ const s=$('pushModels'); if(!s.options.length) return false; s.options[0].selected=true; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  const pushRows = await pick(`document.querySelectorAll('.push-row [data-pushmodel]').length`);
  ok(pushRows >= 1, `选机种后出现 ${pushRows} 个「推送」按钮`, String(pushRows));

  const rlBtns = await pick(`({
    picknext: document.querySelectorAll('[data-picknext]').length,
    sw: document.querySelectorAll('[data-switch]').length,
    cur: document.querySelectorAll('[data-pickcur]').length
  })`);
  ok(rlBtns.picknext === 0 && rlBtns.sw === 0,
    '运行产线里没有「排产下一个 / 换型」按钮', JSON.stringify(rlBtns));

  await win.webContents.capturePage().catch(() => {});
  await sleep(350);
  const shot1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-board.png'), shot1.toPNG());

  console.log('\n③ 终端监控：单视图');
  await pick(`(function(){ document.querySelector('.nav-item[data-view="terms"]').click(); return true; })()`);
  await sleep(1200);
  const terms = await pick(`({
    tmOp: !!document.getElementById('tmOp'),
    opWrap: !!document.getElementById('termOpWrap'),
    clientWrap: !!document.getElementById('termClientWrap'),
    cols: document.querySelectorAll('#clientTable thead th').length
  })`);
  ok(!terms.tmOp && !terms.opWrap, '「按工序」视图与按钮已移除', JSON.stringify(terms));
  ok(terms.clientWrap && terms.cols === 8, `客户端表 ${terms.cols} 列（IP/机名/线体/工序/心跳/版本/状态/操作）`);

  console.log('\n④ 系统页：本厂线体清单');
  await pick(`(function(){ const b=document.querySelector('.nav-item[data-view="system"]'); if(b) b.click(); return !!b; })()`);
  await sleep(1200);
  const sys = await pick(`({
    lines: document.querySelectorAll('#sysLines .sys-line').length,
    statusSel: document.querySelectorAll('#sysLines [data-lstatus]').length
  })`);
  ok(sys.lines > 0, `系统页列出 ${sys.lines} 条线体`, String(sys.lines));
  ok(sys.statusSel === sys.lines, '每条都有状态下拉');
  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-system.png'), shot2.toPNG());

  console.log('\n⑤ 机种设置：工序表不再有「屏」和「工时」');
  await pick(`(function(){ document.querySelector('.nav-item[data-view="models"]').click(); return true; })()`);
  await sleep(1500);
  // 机种设置要选中一个机种才出工序表 —— 点第一张机种卡（没有就点列表第一项）
  await pick(`(function(){
    const cards = document.querySelectorAll('[data-md]');
    if (cards.length) { cards[0].click(); return true; }
    return false;
  })()`);
  await sleep(1200);
  const mdl = await pick(`({
    ths: [...document.querySelectorAll('.st-table thead th')].map(t => t.textContent.trim()),
    bindop: document.querySelectorAll('[data-bindop]').length,
    numCell: document.querySelectorAll('.st-table .cell-num').length,
    rows: document.querySelectorAll('#stTbody tr').length,
    pk: document.querySelectorAll('.cell-pk').length
  })`);
  ok(mdl.bindop === 0, '工序表没有「屏」那一列了', String(mdl.bindop));
  ok(mdl.numCell === 0, '工序表没有工时输入格了（合计/瓶颈一起删）', String(mdl.numCell));
  ok(mdl.rows > 0, `工序表有 ${mdl.rows} 行`, String(mdl.rows));
  ok(mdl.pk > 0, '「播放内容」三个小勾还在', String(mdl.pk));
  ok(!mdl.ths.includes('屏') && !mdl.ths.includes('工时'), `表头：${mdl.ths.join(' / ')}`, mdl.ths.join(','));
  await pick(`window.scrollTo(0, 0)`);
  await win.webContents.capturePage().catch(() => {});
  await sleep(350);
  const shot3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-5.0.1-models.png'), shot3.toPNG());

  console.log('\n⑥ 媒体库：仍能选机种 → 工序');
  await pick(`(function(){ document.querySelector('.nav-item[data-view="media"]').click(); return true; })()`);
  await sleep(1500);
  const media = await pick(`({
    sel: document.querySelectorAll('#mdModel, #mediaModel, select').length,
    body: document.body.innerText.includes('媒体库')
  })`);
  ok(media.sel > 0, `媒体库有 ${media.sel} 个下拉/选择器`, String(media.sel));

  console.log('\n⑦ 控制台');
  ok(errors.length === 0, '无 console 错误', errors.slice(0, 3).join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  app.quit();
}).catch((e) => {
  console.error('点检脚本自身出错：', e);
  app.exit(1);
});

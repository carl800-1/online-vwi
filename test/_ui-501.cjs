// 5.0.1 界面减法点检：导航只剩 5 项、作业内容是当天机种清单、终端监控单视图、系统设置只剩本机信息。
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
  // 当天机种清单存在 localStorage（按线体分开），同一 user-data-dir 连跑两次会带着上次的清单
  await win.webContents.executeJavaScript('localStorage.clear()').catch(() => {});
  await win.webContents.reload();
  await sleep(2500);

  const pick = (expr) => win.webContents.executeJavaScript(
    `(() => { const $ = (id) => document.getElementById(id); return (${expr}); })()`
  );

  console.log('\n① 导航只剩 5 项');
  const nav = await pick(`[...document.querySelectorAll('.nav-item[data-view]')].map(b => b.dataset.view)`);
  ok(nav.length === 5, `导航 ${nav.length} 项：${nav.join(' / ')}`, nav.join(','));
  ok(!nav.includes('prod') && !nav.includes('lines') && !nav.includes('files'),
    '没有 生产输入 / 线体设置 / 文件查询');

  console.log('\n② 作业内容：一句说明 + 当前作业线 + 当天机种清单');
  const shape = await pick(`({
    hint: (document.querySelector('.board-hint')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    bar: !!$('boardBar'),
    picker: !!$('pushPicker'),
    legacy: !!$('board'),
    oldRow: document.querySelectorAll('#boardBar .rl').length,
    lineText: (document.querySelector('.bar-line')?.textContent || $('pushLine')?.selectedOptions?.[0]?.textContent || '').trim()
  })`);
  ok(/排列当天要生产的机种/.test(shape.hint), `说明：${shape.hint}`);
  ok(shape.bar && shape.picker, '有一行信息（作业线 / 正在生产 / 在线数 / 添加机种）');
  ok(!shape.legacy && shape.oldRow === 0, '不再一行一条铺线体列表（#board 已移除）', JSON.stringify(shape));
  ok(shape.lineText.length > 0, `当前作业线：${shape.lineText}`);

  const dead = await pick(`({
    pcard: !!document.getElementById('pBody'),
    bsum: !!document.getElementById('bsum'),
    bhelp: !!document.querySelector('.bhelp'),
    chart: document.querySelectorAll('.pchart').length
  })`);
  ok(!dead.pcard && !dead.bsum && !dead.bhelp && !dead.chart,
    '生产概况 / 产线概览 / 操作说明 / 柱状图 都已移除', JSON.stringify(dead));

  await pick(`(function(){ $('pushPicker').click(); return true; })()`);
  await sleep(400);
  const cands = await pick(`document.querySelectorAll('#pushOpts .push-opt').length`);
  ok(cands >= 1, `展开后列出 ${cands} 个候选机种`);
  await pick(`(function(){ const cb=document.querySelector('#pushOpts .push-opt input'); if (cb) cb.click(); return true; })()`);
  await sleep(300);
  const planRows = await pick(`document.querySelectorAll('.plan-row [data-planpush]').length`);
  ok(planRows >= 1, `勾选后下面清单出现 ${planRows} 个「推送」按钮`);
  await pick(`(function(){ $('pushFold').click(); return true; })()`);
  await sleep(200);

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

  console.log('\n④ 系统设置：只剩本机信息，线体清单已删');
  // 浏览器版看不出这一页（点 system 会被 if (!loadSysPanel) return 拦掉、桌面信息也填不上），
  // 所以这里只验 DOM 结构；实际渲染留到打包版冒烟。
  const sys = await pick(`({
    nav: (document.querySelector('.nav-item[data-view="system"]')?.textContent || '').trim(),
    navCount: document.querySelectorAll('.nav-item[data-view]').length,
    sysLinesNode: !!$('sysLines'),
    lines: document.querySelectorAll('#view-system .sys-line').length,
    statusSel: document.querySelectorAll('[data-lstatus]').length,
    viewText: (document.getElementById('view-system')?.textContent || '').replace(/\s+/g, ' ').trim(),
    nodes: ['sysVer','sysPort','sysAuto','sysLan','sysData','sysLog','sysHide','sysQuit']
      .filter(id => !document.getElementById(id))
  })`);
  ok(sys.nav === '系统设置', `导航项文案：${sys.nav}`);
  ok(!sys.sysLinesNode && sys.lines === 0 && sys.statusSel === 0,
    '「本厂线体」整块已删除（没有 #sysLines、没有状态下拉）', JSON.stringify(sys));
  ok(!/本厂线体/.test(sys.viewText), '视图里也没有「本厂线体」字样');
  ok(sys.nodes.length === 0, `本机信息结构还在（缺：${sys.nodes.join(',') || '无'}）`, sys.nodes.join(','));
  ok(/终端装机要填的服务端地址/.test(sys.viewText) && /数据目录/.test(sys.viewText),
    '服务端地址 / 数据目录 / 日志 三块还在');
  // 这里不截图：浏览器版切不到系统页（点了没反应），硬截只会拍到上一页。
  // 系统设置页的图由打包版冒烟脚本（test/_ui-delivery.cjs）在桌面模式下出。

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

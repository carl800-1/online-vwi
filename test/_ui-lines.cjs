// 线体导入 / 导出的界面冒烟检查（一次性脚本）。
// 用 Electron 隐藏窗口真点一遍按钮，把弹窗文字与截图取回来 ——
// 后端测试证明不了「按钮有没有接上、弹窗有没有渲染」。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BASE = process.env.BASE || 'http://127.0.0.1:8095';
const OUT = path.resolve(__dirname, '..', 'docs');
const PNG = path.join(OUT, 'ui-4.2.1-lines-xlsx.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + '\n');

// 本机系统代理会把 127.0.0.1 也劫持走（502），必须显式关代理；
// 再关掉 GPU —— 沙箱里没有显示设备，走硬件加速会直接起不来。
app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

/** 造一份「有新增 / 有变化 / 没变化 / 不合要求」四种都占的表，截图才看得出分流 */
async function makeSheet() {
  const post = (b) => fetch(BASE + '/api/lines', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
  }).then((r) => r.json());

  const { lines } = await fetch(BASE + '/api/lines').then((r) => r.json());
  const names = new Set(lines.map((l) => l.name));
  if (!names.has('二线')) await post({ name: '二线', slots: 5 });
  if (!names.has('三线')) await post({ name: '三线', slots: 5 });

  const now = (await fetch(BASE + '/api/lines').then((r) => r.json())).lines;
  const l1 = now.find((l) => l.name === '一线');
  const l2 = now.find((l) => l.name === '二线');
  const l3 = now.find((l) => l.name === '三线');

  // 用服务端同一套 builder 造文件，保证和「导出的表」逐列同构
  const { buildWorkbook } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'xlsx.js')).href);
  const rows = [
    ['线体名称', '编码', '工位数', '状态'],
    ['一线（总装）', l1.code, String((l1.slots || 5) + 1), '运行'],   // 有变化：名称 + 工位数
    ['二线', l2.code, String(l2.slots || 5), '运行'],                 // 没变化
    ['三线', l3.code, '8', '停线'],                                   // 有变化：工位数
    ['十线', 'L 10', '4', ''],                                        // 不合要求：编码带空格
    ['四线', '', '3', ''],                                            // 新增，编码留空自动补
    ['二线', l2.code, '5', ''],                                       // 不合要求：行内重复
  ];
  return buildWorkbook([{ name: '线体清单', rows }]).toString('base64');
}

app.whenReady().then(async () => {
  const sheetB64 = await makeSheet();
  const win = new BrowserWindow({ width: 1440, height: 940, show: false });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  await win.loadURL(BASE);
  await sleep(1500);
  const js = (s) => win.webContents.executeJavaScript(s, true);

  await js(`document.querySelector('[data-view="lines"]').click()`);
  await sleep(900);

  const out = {};
  out.buttons = await js(`JSON.stringify([...document.querySelectorAll('#view-lines .card-head .btn')].map(b => b.textContent.trim()))`);

  // 1) 导出弹窗
  await js(`document.getElementById('lnExportBtn').click()`);
  await sleep(400);
  out.exportOpen = await js(`document.getElementById('dialog').classList.contains('show')`);
  out.exportText = await js(`document.getElementById('dialog').innerText.replace(/\\s+/g,' ').trim()`);
  await js(`document.getElementById('dlgCancel').click()`);
  await sleep(300);

  // 2) 导入预览：把造好的表 POST 给 parse，再走界面渲染
  //    不能 await showLineImportPreview —— 它内部 await 弹窗，不关就永远不返回
  out.preview = await js(`(async () => {
    const bin = atob(${JSON.stringify(sheetB64)});
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const d = await (await fetch('/api/import/lines/parse?filename=' + encodeURIComponent('线体清单.xlsx'),
      { method: 'POST', body: buf })).json();
    void showLineImportPreview(d);
    return 'ok';
  })()`).catch((e) => 'ERR ' + e.message);
  await sleep(1000);
  out.previewTitle = await js(`document.getElementById('dlgTitle').textContent`);
  out.previewText = await js(`document.getElementById('dialog').innerText.replace(/\\s+/g,' ').trim()`);
  out.previewRows = await js(`document.querySelectorAll('#dlgBody .imp-table tbody tr').length`);
  out.badRows = await js(`[...document.querySelectorAll('#dlgBody .imp-table tbody tr.is-bad')].length`);

  // 截图：隐藏窗口第一帧常是上一帧，先空捕一次再真捕
  await win.webContents.capturePage();
  await sleep(400);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(PNG, (await win.webContents.capturePage()).toPNG());
  out.png = PNG;

  // 3) 确认导入（默认 update）→ 结果弹窗
  await js(`document.getElementById('dlgOk').click()`);
  await sleep(1500);
  out.resultTitle = await js(`document.getElementById('dlgTitle').textContent`);
  out.resultText = await js(`document.getElementById('dialog').innerText.replace(/\\s+/g,' ').trim()`);
  await js(`document.getElementById('dlgOk').click()`);
  await sleep(300);

  // 4) 导回去：库里现在的状态
  out.after = await fetch(BASE + '/api/lines').then((r) => r.json())
    .then((d) => d.lines.map((l) => `${l.name}/${l.code}/${l.slots}/${l.status}`));

  out.errors = errs;
  log(JSON.stringify(out, null, 2));
  app.exit(0);
}).catch((e) => { log('UI 检查失败：' + (e && e.stack || e)); app.exit(1); });

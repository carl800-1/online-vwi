// 「工序 ↔ 屏」分配的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8111 electron test/_ui-clients.cjs
//
// ⚠️ 服务要在外面先起好（Electron 的 process.execPath 是 electron.exe，起不了 node 服务）。
//
// 验六件事：
//   1) 工序表有「屏」列，未绑的显示「未绑」，已绑的显示「L1 · 31」
//   2) 点这一格能打开分配弹窗，弹窗里按线体分块、候选里"就是这台"排第一
//   3) 点候选能落库，重新拉一遍还是这台
//   4) 把客户端自报的工序号改掉之后，这一格标红、弹窗里显示「已改配」和它现在报什么
//   5) 解除分配能落库
//   6) 页面没有 console 报错
// 跑完把绑定还原成跑之前的样子，不改开发库的配置（finally 里做）。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8111';
const PNG_TABLE = path.join(ROOT, 'docs', 'ui-4.4.0-bind-table.png');
const PNG_MODAL = path.join(ROOT, 'docs', 'ui-4.4.0-bind-modal.png');
const PNG_TELEMETRY = path.join(ROOT, 'docs', 'ui-4.4.0-clients-view.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiJson = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return r.json();
};
const postJson = (p, body) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
}).then((r) => r.json());

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(BASE + '/api/status')).ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }

  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const errs = [];
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    const level = (e && e.level) || '';
    if ((level === 'error' || level === 2) && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  const result = {};
  let code = '';                 // 被测工序码
  let lineId = '';               // 被测线体
  let origBind = null;           // 跑之前的绑定，收尾还原用
  let touchedIp = '';            // 本次绑上去的客户端
  let touchedSeen = null;        // 它绑之前自报的线号/工序号，收尾时原样拍回去

  const restore = async () => {
    if (!code || !lineId) return 'skip';
    const out = { unbound: '', rebound: '' };
    // 只解绑本次绑上去的那台；如果它就是原来的绑定，让下面的重绑直接覆盖，
    // 少一次先删后插（也少一个中间的"这道工序没屏"状态）。
    if (touchedIp && (!origBind || origBind.ip !== touchedIp)) {
      await postJson('/api/clients/' + encodeURIComponent(touchedIp) + '/unbind', {});
      out.unbound = touchedIp;
    }
    if (origBind) {
      // 重绑回原主之后必须补一次心跳把它自报的值拍回这道工序。
      // 光重绑不补心跳，那台屏会以「已改配」留在开发库里 —— 下一轮打开界面看着像 bug，
      // 而且再跑这个脚本时它会被当成"要演示改配的那台"，越跑越乱。
      await postJson('/api/clients/' + encodeURIComponent(origBind.ip) + '/bind',
        { lineId, processCode: code });
      await postJson('/api/telemetry', {
        ip: origBind.ip,
        line: origBind.lineCode || result.line,
        op: code, ver: '1.7.1', res: '1920x1080'
      });
      out.rebound = origBind.ip;
    }
    const now = await apiJson('/api/binds?lineId=' + encodeURIComponent(lineId));
    out.bind = now.binds.filter((b) => b.processCode === code).map((b) => `${b.lineCode}/${b.processCode} → ${b.ip} (${b.state})`);
    return out;
  };

  let quit = false;
  const finish = async () => {
    if (quit) return;
    quit = true;
    try { result.restored = await restore(); } catch (e) { result.restoreError = String(e.message || e); }
    result.errors = errs;
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
    win.destroy();
    app.quit();
  };

  try {
    await win.loadURL(BASE);
    await sleep(2000);
    const js = (s) => win.webContents.executeJavaScript(s, true);

    // 先把开发库里那几台测试客户端补一次心跳，截图才有"在线"的样子。
    // 已经被绑定过的，按绑定的线体工序报（否则一拍就是"已改配"，看着像 bug）；
    // 这一轮要演示改配的那台在下面单独处理。
    {
      const cl0 = await apiJson('/api/clients');
      const bd0 = await apiJson('/api/binds');
      for (const c of cl0.clients) {
        if (!c.lineCode || !c.opCode) continue;
        const b = bd0.binds.find((x) => x.ip === c.ip);
        await postJson('/api/telemetry', {
          ip: c.ip,
          line: b ? b.lineCode : c.lineCode,
          op: b ? b.processCode : c.opCode,
          ver: c.ver || '1.7.1', res: c.res || '1920x1080'
        });
      }
    }

    // 进「机种设置」并确保选中机种、工序已拉过（此时 S.bindsByCode 也一起拉好了）
    await js(`document.querySelector('.nav-item[data-view="models"]').click()`);
    await sleep(900);
    await js(`(() => {
      if (S.mdModelId) return 'kept';
      const chip = document.querySelector('#mdList [data-mid]');
      if (chip) chip.click();
      return chip ? 'picked' : 'no-model';
    })()`);
    await sleep(800);
    await js(`loadMdProcesses()`);
    await sleep(1200);

    const firstRow = () => js(`(() => {
      const tr = document.querySelector('#stTbody tr[data-row]');
      if (!tr) return null;
      const btn = tr.querySelector('.cell-bind');
      return {
        code: (tr.querySelector('.cell-code') || {}).textContent || '',
        cell: btn ? (btn.innerText || '').replace(/\\s+/g, ' ').trim() : '(没有屏列)',
        hasBad: btn ? btn.classList.contains('bad') : false,
        cols: tr.children.length
      };
    })()`);

    result.row = await firstRow();
    code = result.row.code;

    // 线体：取这台机种可生产的第一条（没有就用服务端第一条）
    const mdLines = await js('(S.mdLines || []).map(l => ({ id: l.id, code: l.code }))');
    const lines = mdLines.length ? mdLines : (await apiJson('/api/lines')).lines.map((l) => ({ id: l.id, code: l.code }));
    lineId = lines[0].id;
    result.line = lines[0].code;

    const before = await apiJson('/api/binds?lineId=' + encodeURIComponent(lineId));
    const ob = before.binds.find((b) => b.processCode === code);
    origBind = ob ? { ip: ob.ip, lineCode: ob.lineCode } : null;
    result.bindBefore = ob ? `${ob.lineCode}/${ob.processCode} → ${ob.ip} (${ob.state})` : '无';

    // 截图：工序表（要有「屏」列）
    await js(`(() => { const tb = document.getElementById('stTbody'); if (tb) tb.scrollIntoView({ block: 'center' }); })()`);
    await sleep(500);
    await win.webContents.capturePage();
    await sleep(400);
    fs.writeFileSync(PNG_TABLE, (await win.webContents.capturePage()).toPNG());

    // 点这一格 → 弹窗
    await js(`(() => { const b = document.querySelector('#stTbody tr[data-row] .cell-bind'); if (b) b.click(); })()`);
    await sleep(1600);

    result.modal = await js(`(() => ({
      open: document.getElementById('bindModal').classList.contains('show'),
      title: (document.getElementById('bindTitle') || {}).textContent || '',
      blocks: [...document.querySelectorAll('.bind-line')].map((b) => ({
        line: (b.querySelector('.bind-lh b') || {}).textContent || '',
        now: (b.querySelector('.bind-now-row') || {}).innerText.replace(/\\s+/g, ' ').trim(),
        cands: b.querySelectorAll('.bind-cand').length,
        firstIsMatch: !!(b.querySelector('.bind-cand') || {}).classList?.contains('match')
      })),
      hint: (document.getElementById('bindHint') || {}).textContent || ''
    }))()`);

    await win.webContents.capturePage();
    await sleep(400);
    fs.writeFileSync(PNG_MODAL, (await win.webContents.capturePage()).toPNG());

    // 点第一块线体里的第一个候选 → 应落库
    await js(`(() => {
      const b = document.querySelector('.bind-line .bind-cand');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1500);

    const afterBind = await apiJson('/api/binds?lineId=' + encodeURIComponent(lineId));
    const nb = afterBind.binds.find((b) => b.processCode === code);
    touchedIp = nb ? nb.ip : '';
    touchedSeen = nb ? { line: nb.seenLineCode || '', op: nb.seenOpCode || '' } : null;
    result.bindAfterClick = nb ? `${nb.lineCode}/${nb.processCode} → ${nb.ip} (${nb.state})` : '没绑上';
    result.cellAfterClick = (await firstRow()).cell;

    // 改号：把那台客户端自报的工序号改成别的，服务端应判 moved
    if (nb) {
      await postJson('/api/telemetry', {
        ip: nb.ip, line: nb.seenLineCode || result.line,
        op: 'OPXX', ver: '1.7.1', res: '1920x1080'
      });
      await sleep(300);
      const moved = await apiJson('/api/binds?lineId=' + encodeURIComponent(lineId));
      const mb = moved.binds.find((b) => b.processCode === code);
      result.stateAfterOpChange = mb ? mb.state : '(绑定没了)';
      // 页面重拉一次，格子和弹窗都要跟着变
      await js(`refreshBindClients()`);
      await sleep(800);
      result.modalAfterOpChange = await js(`(() => {
        const row = document.querySelector('.bind-line .bind-now-row');
        return row ? row.innerText.replace(/\\s+/g, ' ').trim() : '';
      })()`);
      await js(`closeBindModal()`);
      await sleep(400);
      await js(`loadMdProcesses()`);
      await sleep(900);
      const r2 = await firstRow();
      result.cellAfterOpChange = r2.cell;
      result.cellBadAfterOpChange = r2.hasBad;
    }

    // 「终端监控 → 按客户端」：全厂设备列表
    await js(`document.querySelector('.nav-item[data-view="terms"]').click()`);
    await sleep(1000);
    await js(`document.getElementById('tmClient').click()`);
    await sleep(1500);
    result.clientView = await js(`(() => ({
      mode: S.termMode,
      sub: (document.getElementById('termSub') || {}).textContent || '',
      rows: [...document.querySelectorAll('#clientTable tbody tr')].map((tr) =>
        [...tr.children].map((td) => (td.innerText || '').replace(/\\s+/g, ' ').trim()).join(' | '))
    }))()`);
    await js(`(() => { const t = document.getElementById('termClientWrap'); if (t) t.scrollIntoView({ block: 'center' }); })()`);
    await sleep(500);
    await win.webContents.capturePage();
    await sleep(400);
    fs.writeFileSync(PNG_TELEMETRY, (await win.webContents.capturePage()).toPNG());

    // 把它的自报值改回原样（上面为了演示"改号"把它改成了 OPXX）。
    // 注意拍回的是"它自己原来报的值"，不是这道工序的号 —— 选中的候选未必是原来那台。
    if (touchedIp && touchedSeen) {
      await postJson('/api/telemetry', {
        ip: touchedIp,
        line: touchedSeen.line || result.line,
        op: touchedSeen.op || code,
        ver: '1.7.1', res: '1920x1080'
      });
    }
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }

  await finish();
});

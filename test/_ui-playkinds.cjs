// 「播放方式 / 播放内容」位置的界面点检（一次性脚本）。
//
//   VWI_UI_BASE=http://127.0.0.1:8108 electron test/_ui-playkinds.cjs
//
// ⚠️ 服务要在外面先起好（Electron 的 process.execPath 是 electron.exe，起不了 node 服务）。
// 4.5.0 起这两项只在「机种设置」的工序表里设，媒体库不再重复一遍。验五件事：
//   1) 工序表第一行有「播放内容」三连勾，勾选状态和库里一致
//   2) 点掉一类会立刻存库，重新拉一遍还是没勾
//   3) 媒体库卡片上不再有「播放 / 播放内容」控件
//   4) 被关掉的那一类内容在媒体库里标「不放」
//   5) 页面没有 console 报错
// 跑完按库里的原值还原，不改开发库的配置；失败也还原（finally 里做）。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.VWI_UI_BASE || 'http://127.0.0.1:8108';
const PNG = path.join(ROOT, 'docs', 'ui-4.3.1-play-kinds.png');
const PNG_MEDIA = path.join(ROOT, 'docs', 'ui-4.3.1-media-noplay.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiJson = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return r.json();
};

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(BASE + '/api/status')).ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }

  // 基准要跟"页面上真正选中的机种"一致：当前生产机种（/api/status）未必就是它。
  // 所以等页面进到机种设置、拿到 S.mdModelId 和第一行的工序 id 之后再取真值。
  let modelId = '';
  let p0 = null;
  let origKinds = [];

  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const errs = [];
  win.webContents.on('console-message', (e) => {
    const msg = (e && e.message) || '';
    const level = (e && e.level) || '';
    if ((level === 'error' || level === 2) && !/Content-Security-Policy/.test(msg)) errs.push(msg);
  });

  const reGet = async () => (await apiJson('/api/processes?modelId=' + encodeURIComponent(modelId)))
    .processes.find((x) => x.id === p0.id);

  const restore = async () => {
    if (!p0) return null;
    await fetch(BASE + '/api/processes/' + encodeURIComponent(p0.id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playKinds: origKinds })
    });
    return (await reGet()).playKinds;
  };

  const result = {};
  let quit = false;
  const finish = async () => {
    if (quit) return;
    quit = true;
    result.restoredApi = await restore();
    result.errors = errs;
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
    win.destroy();
    app.quit();
  };

  try {
    await win.loadURL(BASE);
    await sleep(2000);
    const js = (s) => win.webContents.executeJavaScript(s, true);

    // 进「机种设置」→ 保证有选中机种 → 强制重拉工序（读的一定是库里的最新值）
    const enterModels = async () => {
      await js(`document.querySelector('.nav-item[data-view="models"]').click()`);
      await sleep(900);
      await js(`(() => {
        if (S.mdModelId) return 'kept';
        const chip = document.querySelector('#mdList [data-mid]');
        if (chip) chip.click();
        return chip ? 'picked' : 'no-model';
      })()`);
      await sleep(700);
      await js(`loadMdProcesses()`);
      await sleep(1000);
    };
    await enterModels();

    const readRow = () => js(`(() => {
      const tr = document.querySelector('#stTbody tr[data-row]');
      if (!tr) return null;
      const code = (tr.querySelector('.cell-code') || {}).textContent || '';
      const pks = [...tr.querySelectorAll('.cell-pk')].map((l) => ({
        kind: l.querySelector('input').dataset.kind,
        label: (l.innerText || '').trim(),
        checked: !!l.querySelector('input').checked,
        on: l.classList.contains('on')
      }));
      const playSel = tr.querySelector('[data-play]');
      return { code, pks, playMode: playSel ? playSel.value : '' };
    })()`);
    result.domBefore = await readRow();
    modelId = await js('S.mdModelId');
    const rowId = await js(`(document.querySelector('#stTbody tr[data-row]') || {dataset:{}}).dataset.row || ''`);
    p0 = (await apiJson('/api/processes?modelId=' + encodeURIComponent(modelId)))
      .processes.find((x) => x.id === rowId);
    origKinds = (p0.playKinds || []).slice();
    result.model = modelId;
    result.proc = p0.code;
    result.apiBefore = origKinds;

    // 挑一类"当前勾着"的去取消（勾着的才能取消）
    const dropKind = (result.domBefore.pks.find((p) => p.checked) || {}).kind;
    result.dropKind = dropKind;
    await js(`(() => {
      const cb = document.querySelector('#stTbody tr[data-row] .cell-pk input[data-kind="${dropKind}"]');
      if (cb) cb.click();
      return !!cb;
    })()`);
    await sleep(900);

    result.domAfterClick = await readRow();
    result.apiAfterClick = (await reGet()).playKinds;

    await enterModels();     // 重新拉库：验证真的落盘了，不只是 DOM 变了
    result.domReloaded = await readRow();

    // 切到媒体库：卡片上不该再有播放方式 / 播放内容，被关掉的那类标「不放」
    await js(`document.querySelector('.nav-item[data-view="media"]').click()`);
    await sleep(1200);
    await js(`(() => {
      const sel = document.getElementById('mlModelPick');
      if (!sel || !sel.options.length) return 'no-model';
      const i = [...sel.options].findIndex((o) => o.value === '${modelId}');
      sel.selectedIndex = i >= 0 ? i : 0;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    await sleep(1600);
    await js(`(() => { const it = document.querySelector('#stList [data-spick]'); if (it) it.click(); })()`);
    await sleep(1200);

    result.mediaCard = await js(`(() => {
      const rows = [...document.querySelectorAll('.st-reqs')].map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim());
      return {
        hasCard: !!document.querySelector('.station'),
        hasPlayMode: !!document.querySelector('[data-f="playMode"]'),
        hasKdd: !!document.querySelector('[data-kddbtn]'),
        reqRow: rows[0] || '',
        offTags: [...document.querySelectorAll('.sitem .offtag')].length,
        items: [...document.querySelectorAll('.sitem')].map((x) => (x.querySelector('.sm') || {}).innerText || '')
      };
    })()`);

    // 媒体库那张卡也留一张图：删掉「播放 / 播放内容」后这一行要还是齐的
    await js(`(() => { const r = document.querySelector('.station .st-reqs'); if (r) r.scrollIntoView({ block: 'center' }); })()`);
    await sleep(500);
    await win.webContents.capturePage();
    await sleep(400);
    fs.writeFileSync(PNG_MEDIA, (await win.webContents.capturePage()).toPNG());

    // 截图：回到机种设置的工序表
    await enterModels();
    await js(`(() => { const tb = document.getElementById('stTbody'); if (tb) tb.scrollIntoView({ block: 'center' }); })()`);
    await sleep(600);
    await win.webContents.capturePage();
    await sleep(400);
    fs.writeFileSync(PNG, (await win.webContents.capturePage()).toPNG());
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }

  await finish();
});

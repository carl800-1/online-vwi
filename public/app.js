// 管理端逻辑：作业内容 + 机种设置 + 媒体库 + 终端监控 + 系统
// 无框架、无构建，浏览器直接跑。所有状态都在内存，一次刷新从服务端重建。
//
// 5.0.1 的位置：这是一台「线头主机」，只干一件事 —— 把视频和 VWI 送到线上的屏。
// 所以页面只有四页，判断标准只有一条：**不在"送到屏"这条链上的，一律不要**。
//   作业内容 = 选线 → 选机种 → 点「推送」，屏立即换内容。现场天天看的就是这一页。
//   机种设置 = **定义层**：这个机种有哪些工序、各做什么、放哪几类内容。
//   媒体库   = **内容层**：先选机种、再选工序、再传图片 / PDF / 视频。
//   终端监控 = 哪些屏连上来了、报的哪道工序。线号工序号屏上自己填，这里只读。
//   系统     = 本机设置 + 本厂线体清单（名称 / 状态）。
//
// 内容怎么到屏上（不是"推"，是"通知 + 屏来拉"）：
//   改内容 / 改当前机种 → contentRev+1 → 叫醒挂起的长轮询 → 屏自己来拉清单和文件。
//   屏永远是发起方，现场不用给屏开任何入站端口。

const H = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const $ = (id) => document.getElementById(id);

const S = {
  tab: 'board',
  version: '',

  lines: [],
  board: [],
  boardTimer: null,

  // 运行产线「推送」面板：选一条运行中的线 + 该线下要推的机种
  focusLineId: '',       // 推送面板里选中的运行产线
  pushModelCodes: [],    // 该线下多选出的机种 code 列表

  models: [],
  nextCode: '',   // 新建机种弹窗里「机种编号」的预填值（服务端扫空号给 M1、M2…）

  // 机种设置（定义层）：只看"有哪些工序、各做什么"，不碰内容
  mdModelId: '',
  mdStations: [],
  mdQuery: '',
  mdLines: [],          // 这个机种能在哪几条线上做

  // 媒体库（内容层）：选机种 → 选工序 → 传文件
  modelId: '',
  stations: [],
  // 一个机种普遍有 15–25 道工序，全摊成一列会变成几千像素的长条，
  // 所以改成「左边工序索引、右边只编一个」：索引永远一屏看得完，编辑区高度固定。
  stPickId: '',      // 正在编辑哪道工序
  stFilter: 'all',   // all | has | empty
  stQuery: '',       // 工序索引里的搜索词

  processes: [],

  clients: null,

  // 上传落在哪道工序
  uploadStation: '',
  uploading: false
};

// ---------- 基础 ----------
async function api(path, opt) {
  const r = await fetch(path, opt);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}

const postJson = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});
const putJson = (p, body) => api(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 4200 : 2400);
}

function fmtBytes(n) {
  if (!n) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function mmss(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * 型号的显示名。
 * 种子数据把 name 写成「X200 型」，直接拼 code 就成了「X200 X200 型」，
 * 下拉框和标题里都是这副德性 —— 现场看着像系统出错了。
 */
function modelLabel(m) {
  const code = (m.code || '').trim();
  const name = (m.name || '').trim();
  if (!name) return code;
  if (!code) return name;
  return name.toLowerCase().includes(code.toLowerCase()) ? name : code + ' ' + name;
}

// ---------- 对话框 ----------
/**
 * 自己画的输入/确认框。
 *
 * 起因很实际：Electron 里 window.prompt() 是**直接抛异常**的
 * （"prompt() is and will not be supported"），点「+ 新型号」毫无反应就是这么来的；
 * confirm() 虽然还能用，但弹的是英文 OK/Cancel 的原生框，中文产线工具上很跳。
 *
 * html 用来塞自定义内容（比如选机种/选线体的列表）；
 * 配 read(body) 可以自己决定返回什么，不写就返回 true。
 */
function dialog({ title, message = '', fields = [], okText = '确定', danger = false, html = '', htmlAfter = '', read = null, hideCancel = false }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML =
      (message ? `<div class="dlg-msg" style="margin-bottom:14px">${H(message)}</div>` : '') +
      (html || '') +
      fields.map((f, i) => `
        <div class="dlg-row">
          ${f.label ? `<label for="dlgF${i}">${H(f.label)}</label>` : ''}
          <input type="text" id="dlgF${i}" data-fk="${H(f.key)}"
                 value="${H(f.value || '')}" placeholder="${H(f.placeholder || '')}">
          ${f.tip ? `<div class="tip">${H(f.tip)}</div>` : ''}
        </div>`).join('') +
      (htmlAfter || '');

    const ok = $('dlgOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    // 纯告知类弹窗（校验结果）没有"取消"这回事，留着只会让人以为点了会撤销什么
    $('dlgCancel').style.display = hideCancel ? 'none' : '';
    $('dialog').classList.add('show');

    const inputs = [...$('dlgBody').querySelectorAll('[data-fk]')];
    const finish = (val) => {
      $('dialog').classList.remove('show');
      ok.onclick = null;
      $('dlgCancel').onclick = null;
      $('dlgX').onclick = null;
      $('dialog').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const submit = () => {
      if (read) return finish(read($('dlgBody')));
      if (!inputs.length) return finish(true);
      const out = {};
      for (const el of inputs) out[el.dataset.fk] = el.value.trim();
      finish(out);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      // 多行输入框里回车要换行，所以提交另给一个 Ctrl+Enter
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    };

    ok.onclick = submit;
    $('dlgCancel').onclick = () => finish(null);
    $('dlgX').onclick = () => finish(null);
    $('dialog').onclick = (e) => { if (e.target === $('dialog')) finish(null); };
    document.addEventListener('keydown', onKey);

    // 批量输入框没有 input，光标要直接落进 textarea，否则得先点一下才能贴
    const first = inputs[0] || $('dlgBody').querySelector('textarea');
    if (first) { first.focus(); first.select(); } else ok.focus();
  });
}

/** confirm 的替身，语义一致：确定 true，取消 null */
async function ask(title, message, okText = '确定', danger = false) {
  const r = await dialog({ title, message, okText, danger });
  return r === true ? true : null;
}

/**
 * 批量输入弹窗：一个多行文本框，一行一条。
 *
 * 现场一条线十几二十道工序，逐个弹窗输入要来回点二十遍 —— 而且每个弹窗
 * 都只放得下两个输入框，本身就是"内容过长"的第一现场。
 * 所以这里统一改成"贴一段文本进来"：从 Excel 两列复制过来就能直接用。
 */
function bulkDialog({ title, message, placeholder = 'OP10 压装\nOP20 焊接', okText = '添加' }) {
  return dialog({
    title,
    html: `<div class="dlg-msg" style="margin-bottom:10px">${H(message)}</div>
      <textarea id="dlgTa" class="dlg-ta" placeholder="${H(placeholder)}" spellcheck="false"></textarea>
      <div class="tip">一行一条，格式：<b>编码 名称</b>（空格 / 逗号 / Tab 分隔均可，名称可省）。
        从 Excel 复制两列直接粘，<b>Ctrl+Enter</b> 提交。</div>`,
    okText,
    read: (body) => body.querySelector('#dlgTa').value
  });
}

/** 「OP10 压装」/「OP10,压装」/「OP10」→ { code, name }，空行与 # 注释行跳过 */
function parseBulk(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [code, ...rest] = line.split(/[\s,，\t]+/).filter(Boolean);
    if (!code) continue;
    out.push({ code, name: rest.join(' ').trim() || code });
  }
  return out;
}

// ---------- 左侧功能区切换 ----------
const VIEW_TITLE = {
  board: '作业内容',
  models: '机种设置',
  media: '媒体库',
  terms: '终端监控',
  system: '系统'
};

// 「系统」只有桌面程序能提供（托盘、自启、本机路径），浏览器版连导航都不显示
let loadSysPanel = null;

function syncNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach((x) =>
    x.classList.toggle('active', x.dataset.view === S.tab));
  for (const v of Object.keys(VIEW_TITLE)) {
    const el = $('view-' + v);
    if (el) el.classList.toggle('hide', v !== S.tab);
  }
  $('viewTitle').textContent = VIEW_TITLE[S.tab] || '作业内容';
}

document.querySelectorAll('.nav-item[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.view;
    // 系统页不再是弹层，跟其它页一样切视图；浏览器版没有这一项，点了也不动
    if (v === 'system' && !loadSysPanel) return;
    S.tab = v;
    syncNav();
    if (v === 'board') loadBoard().catch(() => {});
    if (v === 'models') loadModels().catch(() => {});       // 定义层：工序清单
    if (v === 'media') loadStations().catch(() => {});      // 内容层：按工序传文件
    if (v === 'terms') loadClients().catch(() => {});
    if (v === 'system') loadSysPanel();
    renderTopStats();
  });
});

// ---------- 总览 ----------
/**
 * 总览的数据来自 /api/board：一次把全部线体给全。
 * 为什么不做"选中一条线再看"：现场要的是一眼扫完 ——
 * 今天哪几条线在跑、各做什么、哪块屏卡住了。逐条点进去看不到全局。
 */
async function loadBoard() {
  const d = await api('/api/board');
  S.board = d.lines || [];
  renderBoard();
  renderPushPanel();
  renderTopStats();
  renderSideFoot();
}

/**
 * 运行产线：一行一条，只列 status = running 的线。
 * 一行只有三块：哪条线 / 正在生产哪个机种（可点「改」对正）/ 几块屏在线。
 * 换型不在这儿点 —— 上面推送面板选机种、点「推送」就直接切了。
 */
function renderBoard() {
  const run = runningLines();
  $('runSub').innerHTML = run.length ? `${run.length} 条线在运行` : '没有线在运行';

  if (!run.length) {
    $('board').innerHTML = `<div class="run-empty">
      <b>现在没有产线在运行。</b>
      <span>${S.board.length
        ? '到「系统 → 本厂线体」把某条线的状态改成「运行中」，它就会出现在这里。'
        : '还没有线体 —— 交付包应当自带，去「系统 → 本厂线体」看。'}</span>
    </div>`;
    return;
  }

  $('board').innerHTML = run.map((l) => {
    const cur = l.currentModelCode
      ? `<b class="rl-big">${H(l.currentModelCode)}</b>
         <span class="rl-nm">${H(l.currentModelName || '')}</span>
         <button class="rl-edit" data-pickcur="${H(l.id)}" title="改：这条线正在生产的机种">改</button>`
      : `<b class="rl-big none">未指定</b>
         <button class="rl-add" data-pickcur="${H(l.id)}">+ 指定正在生产的机种</button>`;

    // 当前机种在这条线上有工序没配内容 —— 推送过去屏上也是空的，提前亮出来
    const warn = l.currentModelCode && l.noContentCount > 0
      ? `<button class="rl-warn" data-goto-model="${H(l.currentModelId)}"
                 title="点这里去媒体库补内容">⚠ ${l.noContentCount} 道工序没配</button>`
      : '';

    return `<div class="rl" data-lid="${H(l.id)}">
      <div class="rl-id">
        <b class="rl-name">${H(l.name)}</b>
        <span class="rl-code">${H(l.code)}</span>
      </div>
      <div class="rl-cur"><span class="rl-k">正在生产</span>${cur}</div>
      <div class="rl-side">
        ${warn}
        <span class="rl-on" title="这条线上有几块屏在线">在线 <b>${l.onlineCount}</b>/${l.clients.length}</span>
      </div>
    </div>`;
  }).join('');
}

/* ================= 运行产线「推送」面板 =================
   选一条运行中的线 → 选它下面要推的机种（多选）→ 逐个点「推送」。
   「推送」= 把该机种设为这条线「正在生产」的机种，屏立即切到它各工序内容
   （走 /api/board/current，直切、不等屏举手）。同一时间一条线只有一个"正在生产"，
   所以多选只是候选池，点哪个就切哪个。 */

function runningLines() {
  return S.board.filter((l) => l.status === 'running');
}

function renderPushPanel() {
  const run = runningLines();
  const sel = $('pushLine');
  if (!run.length) {
    sel.innerHTML = '<option value="">没有运行中的产线</option>';
    $('pushModels').innerHTML = '';
    $('pushList').hidden = true;
    $('pushList').innerHTML = '';
    S.focusLineId = '';
    return;
  }

  const prev = S.focusLineId && run.some((l) => l.id === S.focusLineId) ? S.focusLineId : run[0].id;
  S.focusLineId = prev;
  sel.innerHTML = run.map((l) =>
    `<option value="${H(l.id)}"${l.id === prev ? ' selected' : ''}>${H(l.name)}（${H(l.code)}）</option>`
  ).join('');
  renderPushModels();
}

async function renderPushModels() {
  const lineId = S.focusLineId;
  const line = S.board.find((l) => l.id === lineId);
  const sel = $('pushModels');
  if (!line) { sel.innerHTML = ''; $('pushList').hidden = true; return; }

  // 该线下可生产的机种：S.lines 带 modelCodes，懒加载一次（loadLines 只在进线体设置页时拉）
  if (!S.lines.length) { try { S.lines = (await api('/api/lines')).lines || []; } catch { S.lines = []; } }
  const lrow = S.lines.find((l) => l.id === lineId);
  const codes = lrow ? (lrow.modelCodes || []) : [];

  if (!codes.length) {
    sel.innerHTML = '<option value="">这条线还没挂机种</option>';
    S.pushModelCodes = [];
    $('pushList').hidden = true;
    $('pushList').innerHTML = '';
    return;
  }

  S.pushModelCodes = S.pushModelCodes.filter((c) => codes.includes(c));
  sel.innerHTML = codes.map((c) =>
    `<option value="${H(c)}"${S.pushModelCodes.includes(c) ? ' selected' : ''}>${H(c)}</option>`
  ).join('');
  renderPushList();
}

function renderPushList() {
  const box = $('pushList');
  if (!S.pushModelCodes.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const line = S.board.find((l) => l.id === S.focusLineId);
  const curCode = line ? line.currentModelCode : '';
  box.innerHTML = S.pushModelCodes.map((c) => `
    <div class="push-row">
      <span class="push-mc">${H(c)}${c === curCode ? ' <em class="push-cur">正在生产</em>' : ''}</span>
      <button class="btn sm primary" data-pushmodel="${H(c)}"
        title="把 ${H(c)} 设为这条线「正在生产」的机种，屏立即切到它各工序内容">推送</button>
    </div>`).join('');
}

async function pushModel(code) {
  const lineId = S.focusLineId;
  const line = S.board.find((l) => l.id === lineId);
  if (!line) return toast('先选一条运行中的产线', 'err');
  try {
    await postJson('/api/board/current', { lineId, modelCode: code });
    toast(`已推送：${line.name} → ${code}，屏正在切换`, 'ok');
    await loadBoard();
  } catch (e) { toast(e.message, 'err'); }
}

$('pushLine').addEventListener('change', () => {
  S.focusLineId = $('pushLine').value;
  S.pushModelCodes = [];
  renderPushModels();
});
$('pushModels').addEventListener('change', () => {
  S.pushModelCodes = [...$('pushModels').selectedOptions].map((o) => o.value);
  renderPushList();
});
$('pushList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pushmodel]');
  if (!b) return;
  b.disabled = true;
  try { await pushModel(b.dataset.pushmodel); }
  finally { b.disabled = false; }
});

async function pickCurrentModel(lineId) {
  const line = S.board.find((x) => x.id === lineId);
  if (!line) return;
  if (!S.models.length) await loadModels().catch(() => {});

  const opts = S.models.filter((m) => m.enabled)
    .map((m) => `<option value="${H(m.code)}"${m.code === line.currentModelCode ? ' selected' : ''}>${H(modelLabel(m))}</option>`)
    .join('');
  if (!opts) return toast('还没有机种，先去「机种设置」新建一个', 'err');

  const pick = await dialog({
    title: `指定：${line.name} 正在生产的机种`,
    message: line.currentModelCode
      ? `现在记的是 ${line.currentModelCode}，改成哪个？`
      : '这一行现在显示「未指定」。先把正在做的机种填上，屏才知道该播哪一套。',
    html: `<select id="curPick" class="dlg-sel">${opts}</select>
           <div class="tip">确定即生效：<b>不等屏下载完</b> —— 在线终端下一轮轮询
             就会自己来取新内容，下完自己翻页，中途继续播旧的。</div>`,
    okText: '确定',
    read: (body) => body.querySelector('#curPick').value
  });
  if (!pick) return;

  try {
    await postJson('/api/board/current', { lineId, modelCode: pick });
    toast(`已指定：${line.name} 正在生产 ${pick}`, 'ok');
    await loadBoard();
  } catch (e) { toast(e.message, 'err'); }
}

$('board').addEventListener('click', async (e) => {
  const pcur = e.target.closest('[data-pickcur]');
  if (pcur) return pickCurrentModel(pcur.dataset.pickcur);

  const goto = e.target.closest('[data-goto-model]');
  if (goto) {
    S.tab = 'media';
    S.modelId = goto.dataset.gotoModel || '';
    syncNav();
    await loadStations();
  }
});

$('runRefresh').addEventListener('click', () => {
  loadBoard().then(() => toast('已刷新')).catch((e) => toast(e.message, 'err'));
});

// 运行产线 2 秒刷一次：在线数、屏正在播的机种要实时；切走页面就停
S.boardTimer = setInterval(() => {
  if (S.tab !== 'board' || document.hidden) return;
  loadBoard().catch(() => {});
}, 2000);

// ---------- 侧栏底部 ----------
function renderSideFoot() {
  const on = S.board.filter((l) => l.status === 'running');
  const online = S.board.reduce((s, l) => s + l.onlineCount, 0);
  $('onlineTxt').textContent = online;
  $('dot').classList.toggle('on', online > 0);
  // v3.5.0 起可以多条线同时跑：一条就报名字，多条报条数（报名字会写不下）
  $('curTxt').textContent = !on.length ? '未指定'
    : on.length === 1 ? on[0].name
      : `${on.length} 条`;
  $('verTxt').textContent = S.version || '—';
}

function renderTopStats() {
  const bits = [];
  if (S.tab === 'board') {
    const on = S.board.filter((l) => l.status === 'running');
    bits.push(`共 <b>${S.board.length}</b> 条线`);
    bits.push(`运行 <b>${on.length}</b> 条`);
    const online = S.board.reduce((s, l) => s + l.onlineCount, 0);
    bits.push(`在线 <b>${online}</b> 台`);
  } else if (S.tab === 'models') {
    bits.push(`共 <b>${S.models.length}</b> 个机种`);
    const m = S.models.find((x) => x.id === S.mdModelId);
    if (m) bits.push(`当前 <b>${H(m.code)}</b>`);
  } else if (S.tab === 'terms') {
    const c = S.clients;
    if (c) bits.push(`在线 <b>${c.online}</b> / ${c.total} 台`);
  }
  // 没统计的页面（媒体库还没选工序时）就空着 —— 顶栏挂个「—」像是加载失败
  $('topStats').innerHTML = bits.join('　·　');
}

$('refreshBtn').addEventListener('click', async () => {
  try {
    if (S.tab === 'board') await loadBoard();
    else if (S.tab === 'models') await loadModels();
    else if (S.tab === 'media') await loadStations();
    else if (S.tab === 'terms') await loadClients();
    toast('已刷新');
  } catch (e) { toast(e.message, 'err'); }
});

async function loadModels(keepId) {
  const d = await api('/api/models');
  S.models = d.models || [];
  S.nextCode = d.nextCode || '';
  const want = keepId || S.mdModelId;
  S.mdModelId = (want && S.models.some((m) => m.id === want))
    ? want : ((S.models[0] && S.models[0].id) || '');
  renderMdList();
  renderMlModelPick();
  await loadMdProcesses();
  renderTopStats();
}

/** 机种胶囊：一个机种一枚，横排、可换行。没选中的时候整页下半是空的。 */
function renderMdList() {
  const kw = ($('mdSearch').value || '').trim().toLowerCase();
  const list = S.models.filter((m) =>
    !kw || m.code.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw));

  $('mdList').innerHTML = list.map((m) => {
    const done = m.done || 0;
    const total = m.total || 0;
    const cls = total && done === total ? 'full' : (done ? 'part' : '');
    const ls = (m.lines || []).map((l) => l.code);
    return `<button class="md-chip${m.id === S.mdModelId ? ' on' : ''}${m.enabled ? '' : ' off'}"
        data-mid="${H(m.id)}">
      <span class="mc-top"><b class="mc-code">${H(m.code)}</b>
        <span class="mc-dot ${cls}" title="${done}/${total} 道工序已配内容">${done}/${total}</span></span>
      <span class="mc-name">${H(m.name)}</span>
      <span class="mc-lines">${ls.length ? H(ls.join(' · ')) : '未安排线体'}</span>
    </button>`;
  }).join('') || '<div class="sub" style="padding:10px">没有匹配的机种</div>';

  $('mdSub').textContent = S.models.length
    ? `${S.models.length} 个机种 · 点一个看它的工序`
    : '还没有机种，点右上角新建';
}

$('mdSearch').addEventListener('input', () => {
  clearTimeout(renderMdList._t);
  renderMdList._t = setTimeout(renderMdList, 150);
});

$('mdList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mid]');
  if (!b || b.dataset.mid === S.mdModelId) return;
  S.mdModelId = b.dataset.mid;
  renderMdList();
  await loadMdProcesses();
});

/* ================= 机种设置下半：这个机种的工序 ================= */

/**
 * 取选中机种的工序。这一页不再按线体取 —— 工序归机种，一个机种只有一套。
 * S.mdLines 是"这个机种能在哪几条线上做"，信息栏里显示并可改。
 */
async function loadMdProcesses() {
  const m = S.models.find((x) => x.id === S.mdModelId);
  if (!m) {
    S.mdStations = [];
    S.mdLines = [];
    $('mdMeta').innerHTML = '<span class="sub">上面选一个机种</span>';
    $('stTableSub').textContent = '—';
    renderStTable();
    return;
  }

  try {
    const d = await api('/api/processes?modelId=' + encodeURIComponent(m.id));
    S.mdStations = d.processes || [];
    S.mdLines = d.lines || [];
    Object.assign(m, { lines: d.lines || [] });
  } catch (e) {
    S.mdStations = [];
    S.mdLines = [];
    toast(e.message, 'err');
  }

  renderMdMeta(m);
  renderStTable();
}

function renderMdMeta(m) {
  const lines = S.mdLines || [];
  const filled = S.mdStations.filter((x) => x.items.length > 0).length;
  const items = S.mdStations.reduce((s, x) => s + x.items.length, 0);
  const bytes = S.mdStations.reduce((s, x) => s + x.items.reduce((a, i) => a + (i.bytes || 0), 0), 0);
  const over = lines.length && (m.total || S.mdStations.length) > Math.min(...S.lines.filter((l) => lines.some((x) => x.id === l.id)).map((l) => l.slots), 99);

  $('mdMeta').innerHTML = `
    <div class="mm-main">
      <div class="mm-blk">
        <span class="mm-k">机种编号</span><b class="mono">${H(m.code)}</b>
      </div>
      <div class="mm-blk">
        <span class="mm-k">可生产线体</span>
        <button class="mm-lines" data-mlines="${H(m.id)}" title="点击勾选这个机种能在哪几条线上做">
          ${lines.length
            ? lines.map((l) => `<span class="lp2 ${l.status === 'running' ? 'live' : ''}">${H(l.name)}</span>`).join('')
            : '<span class="badge warn">还没安排线体</span>'}
        </button>
      </div>
      ${over ? '<span class="badge warn">工序数超过线体工位数</span>' : ''}
      <div class="spacer"></div>
      <div class="mm-stats">
        <span><b>${S.mdStations.length}</b> 道工序</span>
        <span><b>${filled}</b> 已配</span>
        <span><b>${items}</b> 个文件</span>
        <span>${bytes ? fmtBytes(bytes) : '—'}</span>
      </div>
      <button class="btn sm" data-mact="ren" title="改机种编号和产品名称">改编号 / 名称</button>
      <button class="btn sm danger" data-mact="del">删除机种</button>
    </div>`;
}

$('mdMeta').addEventListener('click', async (e) => {
  const m = S.models.find((x) => x.id === S.mdModelId);
  if (!m) return;

  const lb = e.target.closest('[data-mlines]');
  if (lb) return editModelLines(m);

  const act = e.target.closest('[data-mact]');
  if (!act) return;

  if (act.dataset.mact === 'ren') {
    const r = await dialog({
      title: '改机种',
      message: '机种编号是终端和工艺文件里对外的标识，改它不影响已配的内容；'
        + '产品名称改了，媒体库里这个机种的文件夹会跟着改名（位置不变，还是那些文件）。',
      fields: [
        { key: 'code', label: '机种编号', value: m.code },
        { key: 'name', label: '产品名称', value: m.name },
      ],
      okText: '保存'
    });
    if (!r) return;
    try {
      await putJson('/api/models/' + encodeURIComponent(m.id), {
        code: r.code || m.code, name: r.name || m.name,
      });
      await loadModels(m.id);
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (act.dataset.mact === 'del') {
    const ok = await dialog({
      title: `删除机种「${m.code}」？`,
      message: `它的 ${S.mdStations.length} 道工序和里面的文件会一起从本机种上摘掉，不可恢复。`
        + '文件实体还留在 data\\media 里（占空间），要彻底清掉找厂家。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/models/' + encodeURIComponent(m.id), { method: 'DELETE' });
      await loadModels('');
      toast('已删除 ' + m.code, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
});

/* ---- 「使用线体」选择器（新建机种 / 改可生产线体两处共用） ----
   现场原话：「使用线体要 + 按钮，然后下拉增加」。
   所以不做一屏复选框（线一多就是一整页勾选框），改成：已选的挂成小胶囊，
   右边「+ 添加线体」拉一个下拉，挑一条加一枚；胶囊上的 ✕ 摘掉。 */
const LPK = { read: () => [], cleanup: () => {} };

function linePickerHTML() {
  return `<div class="lpk" id="lpk">
      <div class="lpk-chips" id="lpkChips"></div>
      <button type="button" class="lpk-add" id="lpkAdd">+ 添加线体</button>
      <div class="lpk-menu" id="lpkMenu" hidden></div>
    </div>`;
}

/** 挂上事件。dialog() 是先插 DOM 再返回 Promise，所以调完 dialog() 立刻就能挂。 */
function mountLinePicker(picked) {
  const box = $('lpk');
  if (!box) return;
  const chips = $('lpkChips');
  const add = $('lpkAdd');
  const menu = $('lpkMenu');
  let sel = (picked || []).slice();

  const draw = () => {
    chips.innerHTML = sel.length
      ? sel.map((id) => {
          const l = S.lines.find((x) => x.id === id);
          return `<span class="lpk-chip">${H(l ? l.name : '已删线体')}
            <i data-lpkr="${H(id)}" title="移除">✕</i></span>`;
        }).join('')
      : '<span class="lpk-none">还没选线体</span>';

    const rest = S.lines.filter((l) => !sel.includes(l.id));
    menu.innerHTML = rest.length
      ? rest.map((l) => `<button type="button" class="lpk-item" data-lpkadd="${H(l.id)}">
          <b>${H(l.name)}</b>
          <small>${H(l.code)} · ${l.slots || 0} 块屏${l.status === 'running' ? ' · 运行中' : ''}</small>
        </button>`).join('')
      : '<div class="lpk-empty">没有更多线体了</div>';
  };
  draw();

  add.onclick = (e) => {
    e.stopPropagation();
    // 弹窗底部空间不够就往上翻，不然菜单会被 .dlg-body 的滚动区切掉半截
    const body = $('dlgBody');
    const room = body ? body.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom : 999;
    menu.classList.toggle('up', room < 196);
    menu.hidden = !menu.hidden;
  };
  menu.onclick = (e) => {
    const b = e.target.closest('[data-lpkadd]');
    if (!b) return;
    sel.push(b.dataset.lpkadd);
    menu.hidden = true;
    draw();
  };
  chips.onclick = (e) => {
    const x = e.target.closest('[data-lpkr]');
    if (!x) return;
    sel = sel.filter((id) => id !== x.dataset.lpkr);
    draw();
  };

  // 点别处把下拉收起来（弹窗关掉时 listener 由 LPK.cleanup 摘掉）
  const away = (e) => { if (!box.contains(e.target)) menu.hidden = true; };
  document.addEventListener('click', away);

  LPK.read = () => sel.slice();
  LPK.cleanup = () => document.removeEventListener('click', away);
}

/** 勾选「使用线体」：一个机种可以安排好几条线，工艺共用一套。 */
async function editModelLines(m) {
  if (!S.lines.length) await loadLines().catch(() => {});
  const have = (S.mdLines || []).map((l) => l.id);
  const p = dialog({
    title: `${m.code} 能生产于哪些线`,
    message: '加进来的线可以在「作业内容」里排产这个机种。工艺只有一套，几条线共用。',
    html: `<div class="dlg-row"><label>使用线体</label>${linePickerHTML()}
        <div class="tip">点「+ 添加线体」挑一条加进来，胶囊上的 ✕ 摘掉。</div></div>`,
    read: () => LPK.read(),
    okText: '保存'
  });
  mountLinePicker(have);
  const r = await p;
  LPK.cleanup();
  if (!r) return;
  try {
    await putJson('/api/models/' + encodeURIComponent(m.id), { lineIds: r });
    await loadModels(m.id);
    await loadLines();
    toast(`已安排到 ${r.length} 条线`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

$('mdNewBtn').addEventListener('click', async () => {
  if (!S.lines.length) await loadLines().catch(() => {});

  // 默认把"运行中"的线先放进去 —— 新建机种九成是给正在跑的那几条线加的
  const picked = S.lines.filter((l) => l.status === 'running').map((l) => l.id);
  const p = dialog({
    title: '新建机种',
    message: '四件事一次定下来：机种编号、产品名称、几道工序、在哪些线做。'
      + '工序码默认 OP1、OP2…，建完在下面逐道改名称。',
    html: `
      <div class="dlg-row"><label for="nmCode">机种编号</label>
        <input type="text" id="nmCode" value="${H(S.nextCode || '')}" placeholder="如 X300">
        <div class="tip">终端和工艺文件按它认这个机种。已经预填了一个没被占用的号，
          不想改就用它；留空也会自动编号。</div></div>
      <div class="dlg-row"><label for="nmName">产品名称</label>
        <input type="text" id="nmName" placeholder="如 X300 前壳组件">
        <div class="tip">留空就先叫编号，之后随时改。</div></div>
      <div class="dlg-row"><label for="nmCnt">几道工序</label>
        <input type="number" id="nmCnt" min="1" max="60" value="5">
        <div class="tip">默认生成 OP1…OPn，建完在下面逐道改名称。工序数别超过线体的工位数。</div></div>
      <div class="dlg-row"><label>使用线体</label>${linePickerHTML()}
        <div class="tip">点「+ 添加线体」挑，可以加好几条。几条线做同一个机种时，
          工序和内容是一套，不用重复录。</div></div>`,
    read: (body) => ({
      code: body.querySelector('#nmCode').value.trim(),
      name: body.querySelector('#nmName').value.trim(),
      processCount: Number(body.querySelector('#nmCnt').value) || 5,
      lineIds: LPK.read()
    }),
    okText: '创建'
  });
  mountLinePicker(picked);
  const r = await p;
  LPK.cleanup();
  if (!r) return;
  try {
    const made = await postJson('/api/models', r);
    await loadModels(made.id);
    await loadLines();
    toast(`已新建 ${made.code}：${made.processes} 道工序，${made.lineCount} 条线`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/* ==================== 媒体库 ==================== */

/** 媒体库：选机种 → 左索引点工序 → 右边上传。不再选线体（内容不按线分）。 */
async function loadStations() {
  if (!S.models.length) await loadModels().catch(() => {});
  if (!S.modelId || !S.models.some((m) => m.id === S.modelId)) {
    S.modelId = S.mdModelId || (S.models[0] && S.models[0].id) || '';
  }
  renderMlModelPick();

  const m = S.models.find((x) => x.id === S.modelId);
  if (!m) {
    S.stations = [];
    S.stPickId = '';
    $('mediaSub').textContent = '还没有机种，先去「机种设置」新建一个';
    $('stNav').innerHTML = '';
    $('stations').innerHTML = '<div class="empty">先选机种。</div>';
    renderStIndex();
    return;
  }

  try {
    const d = await api('/api/processes?modelId=' + encodeURIComponent(m.id));
    S.stations = d.processes || [];
  } catch (e) {
    S.stations = [];
    toast(e.message, 'err');
  }

  const filled = S.stations.filter((x) => x.items.length > 0).length;
  $('mediaSub').textContent = `${m.code} · ${S.stations.length} 道工序`
    + (S.stations.length ? ` · 已配 ${filled}` : ' · 先去「机种设置」加工序');

  renderStations();
}

/** 媒体库顶部的机种下拉。这一页的重点是工序，机种只是入口 */
function renderMlModelPick() {
  const sel = $('mlModelPick');
  if (!sel) return;
  sel.innerHTML = S.models.map((m) =>
    `<option value="${H(m.id)}"${m.id === S.modelId ? ' selected' : ''}>${H(modelLabel(m))}</option>`
  ).join('') || '<option value="">还没有机种</option>';
}

$('mlModelPick').addEventListener('change', async (e) => {
  S.modelId = e.target.value;
  S.stPickId = '';   // 换机种，上一套工序 id 全部作废，交给 ensurePick 重挑
  await loadStations();
});

const PLAY_MODES = [
  ['loop', '循环播放', '播完最后一张从第一张重新开始（默认）'],
  ['once', '播一遍停', '顺序播完停在最后一屏，不再重头开始'],
];

// 「播放内容」按界面顺序：图片 / PDF / 视频（存库顺序也按这个，导出时照这个排）
const PLAY_KINDS = ['image', 'pdf', 'video'];
const PLAY_CN = { image: '图片', pdf: 'PDF', video: '视频' };

/** 勾选状态：接口回满三项时就是"全放"，等于没限 */
function playKindsOfSt(st) {
  const set = (st && Array.isArray(st.playKinds) && st.playKinds.length)
    ? st.playKinds
    : PLAY_KINDS;
  return PLAY_KINDS.filter((k) => set.includes(k));
}

/**
 * 工序清单表格。
 * 25 道工序用表格而不是卡片：一行 34px，表头固定、表内滚动，
 * 页面高度不随工序数增长；「内容」列直接点进媒体库对应的工序。
 */
/** 工序表副标题：几道工序、几道配了内容 */
function renderStSub() {
  const el = $('stTableSub');
  if (!el) return;
  const total = S.mdStations.length;
  if (!total) { el.innerHTML = '—'; return; }
  const filled = S.mdStations.filter((x) => x.items.length > 0).length;
  el.innerHTML = `${total} 道工序 · 已配 <b>${filled}</b> 道`;
}

function renderStTable() {
  const tb = $('stTbody');
  if (!tb) return;

  renderStSub();
  const total = S.mdStations.length;

  if (!S.mdModelId) {
    tb.innerHTML = '<tr><td colspan="9" class="st-empty">上面选一个机种，这里显示它的工序。</td></tr>';
    return;
  }
  if (!total) {
    tb.innerHTML = `<tr><td colspan="9" class="st-empty">
      这个机种还没有工序。点右上「+ 批量加工序」一次贴多行（一行 <b>OP1 装配</b>）。</td></tr>`;
    return;
  }

  const kw = (S.mdQuery || '').trim().toLowerCase();
  const shown = S.mdStations.filter((st) =>
    !kw || (st.code || '').toLowerCase().includes(kw) || (st.name || '').toLowerCase().includes(kw));

  if (!shown.length) {
    tb.innerHTML = '<tr><td colspan="9" class="st-empty">没有匹配的工序</td></tr>';
    return;
  }

  tb.innerHTML = shown.map((st) => {
    const n = st.items.length;
    const on = playKindsOfSt(st);
    return `<tr data-row="${H(st.id)}">
      <td><span class="cell-code" title="工序码就是终端上的 op 参数">${H(st.code)}</span></td>
      <td><input class="cell-in" data-f="name" maxlength="40"
                 value="${H(st.name)}" placeholder="工序名称"></td>
      <td><input class="cell-in" data-f="note" maxlength="200"
                 value="${H(st.note || '')}" placeholder="这道工序做什么…"></td>
      <td>
        <select class="cell-sel" data-play="${H(st.id)}">
          ${PLAY_MODES.map(([v, t, tip]) => `<option value="${v}" title="${H(tip)}"${
            (st.playMode || 'loop') === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td class="cell-pkwrap">${PLAY_KINDS.map((k) => `
        <label class="cell-pk${on.includes(k) ? ' on' : ''}"${on.length === 1 && on.includes(k)
          ? ' title="只剩这一类时不能去掉，至少留一类"' : ''}><input type="checkbox"
          data-pk="${H(st.id)}" data-kind="${k}"${on.includes(k) ? ' checked' : ''}><span>${PLAY_CN[k]}</span></label>`).join('')}</td>
      <td>${n
        ? `<button class="cell-n on" data-jump="${H(st.id)}">${n} 项</button>`
        : `<button class="cell-n" data-jump="${H(st.id)}">未配</button>`}</td>
      <td><button class="cell-x" data-del="${H(st.id)}" title="删除这道工序">✕</button></td>
    </tr>`;
  }).join('');
}

$('stTableSearch').addEventListener('input', (e) => {
  S.mdQuery = e.target.value;
  clearTimeout(renderStTable._t);
  renderStTable._t = setTimeout(renderStTable, 150);
});

// 改一格就存一格：change 只在"值真的变了且离开输入框"时触发，不会一路敲一路发请求
$('stTbody').addEventListener('change', async (e) => {
  const inp = e.target.closest('.cell-in');
  if (!inp) return;
  const tr = inp.closest('[data-row]');
  const st = S.mdStations.find((x) => x.id === tr.dataset.row);
  if (!st) return;

  const f = inp.dataset.f;
  const raw = inp.value.trim();
  let v = raw;

  if (inp.dataset.num) {
    // 工时是数字：留空 = 没测（存 0），乱填直接退回去 —— 别让「8,5」静默变成 0
    if (!raw) {
      v = 0;
    } else {
      v = Number(raw.replace(/[，,]/g, '.'));
      if (!Number.isFinite(v) || v < 0) {
        inp.value = st[f] ? st[f] : '';
        return toast('工时填秒数，例如 8.5；留空表示还没测', 'err');
      }
      v = round1(v);
    }
    if ((Number(st[f]) || 0) === v) {
      inp.value = v ? v : '';   // 把「8.50」这种顺手规整掉
      return;
    }
  } else if ((st[f] || '') === v) return;

  inp.classList.add('saving');
  try {
    const out = await putJson('/api/processes/' + encodeURIComponent(st.id), { [f]: v });
    Object.assign(st, out.process || {});
    inp.classList.remove('saving');
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 1200);
    if (inp.dataset.num) {
      inp.value = v ? v : '';
      renderStSub();         // 合计 / 瓶颈在副标题上，只更那一行，表体不动（Tab 连着填不丢焦点）
    }
    renderMdList();          // 徽标跟着变
    renderMdMeta(S.models.find((x) => x.id === S.mdModelId));
  } catch (err) {
    inp.value = inp.dataset.num ? (st[f] ? st[f] : '') : (st[f] || '');
    inp.classList.remove('saving');
    toast(err.message, 'err');
  }
});

// 播放方式：选完立刻存，不写"保存"按钮
$('stTbody').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-play]');
  if (!sel) return;
  const st = S.mdStations.find((x) => x.id === sel.dataset.play);
  if (!st || st.playMode === sel.value) return;
  try {
    await putJson('/api/processes/' + encodeURIComponent(st.id), { playMode: sel.value });
    st.playMode = sel.value;
    toast(`「${st.code}」改为${(PLAY_MODES.find(([v]) => v === sel.value) || [, ''])[1]}`, 'ok');
  } catch (err) { toast(err.message, 'err'); renderStTable(); }
});

// 播放内容：勾/去勾立刻存。至少留一类 —— 全都不勾等于这块屏什么都不放
$('stTbody').addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-pk]');
  if (!cb) return;
  const st = S.mdStations.find((x) => x.id === cb.dataset.pk);
  if (!st) return;
  const set = new Set(playKindsOfSt(st));
  if (cb.checked) set.add(cb.dataset.kind); else set.delete(cb.dataset.kind);
  if (!set.size) {
    cb.checked = true;
    toast('播放内容至少要留一类，不然这块屏什么都不放', 'err');
    return;
  }
  const playKinds = PLAY_KINDS.filter((k) => set.has(k));
  try {
    const out = await putJson('/api/processes/' + encodeURIComponent(st.id), { playKinds });
    Object.assign(st, out.process || {});
    // 只改这一格的勾选样式，不重绘表体（重绘会丢焦点，也会把滚动位置弹回去）
    const td = cb.closest('td');
    for (const lab of td.querySelectorAll('.cell-pk')) {
      lab.classList.toggle('on', set.has(lab.querySelector('input').dataset.kind));
    }
  } catch (err) {
    cb.checked = !cb.checked;
    toast(err.message, 'err');
  }
});

$('stTbody').addEventListener('click', async (e) => {
  // 点「内容」列 → 切到媒体库并直接把那道工序选中
  const jump = e.target.closest('[data-jump]');
  if (jump) { await openInMedia(jump.dataset.jump); return; }

  // 点「屏」列 → 分配客户端。用工序码而不是 process id：绑定键是 (线体, 工序码)
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const st = S.mdStations.find((x) => x.id === del.dataset.del);
  if (!st) return;
  if (st.items.length && !await ask('删除工序',
    `「${st.code} ${st.name}」里还有 ${st.items.length} 项内容，删掉工序会一起删掉，确定吗？`,
    '删除', true)) return;
  try {
    await api('/api/processes/' + encodeURIComponent(st.id), { method: 'DELETE' });
    await loadMdProcesses();
    toast('已删除工序 ' + st.code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/** 从机种设置跳到媒体库，落点就是刚点的那道工序 */
async function openInMedia(processId) {
  S.tab = 'media';
  S.modelId = S.mdModelId;
  S.stPickId = processId;
  syncNav();
  await loadStations();
  renderTopStats();
}

const KIND_CN = { image: '图片', video: '视频', pdf: 'PDF' };
const KINDS = ['image', 'video', 'pdf'];

function stationReq(st, kind) {
  return (st.reqs || []).find((r) => r.kind === kind) || null;
}

function renderStations() {
  ensurePick();
  renderStIndex();
  renderStEdit();
}

/** 选中的工序要一直有效：切机种 / 删工序之后，老 id 就指不到了 */
function ensurePick() {
  if (!S.stations.length) { S.stPickId = ''; return; }
  if (S.stations.some((x) => x.id === S.stPickId)) return;
  // 优先落在"第一个还没配内容的"——十几二十道工序里，最想知道的就是下一个该配哪个
  const next = S.stations.find((x) => !x.items.length);
  S.stPickId = (next || S.stations[0]).id;
}

/** 工序索引：一屏看完这个机种有哪些工序、哪些配好了、哪些还空着 */
function renderStIndex() {
  const list = $('stList');
  if (!list) return;

  const total = S.stations.length;
  const filled = S.stations.filter((x) => x.items.length > 0).length;
  $('stCount').innerHTML = total ? `<b>${filled}</b>/${total}` : '0';
  $('stBar').style.width = total ? `${Math.round((filled / total) * 100)}%` : '0';

  if (!total) {
    list.innerHTML = '<div class="si-empty">还没有工序</div>';
    return;
  }

  const q = S.stQuery.trim().toLowerCase();
  const shown = S.stations.filter((st) => {
    if (S.stFilter === 'has' && !st.items.length) return false;
    if (S.stFilter === 'empty' && st.items.length) return false;
    if (!q) return true;
    return (st.code || '').toLowerCase().includes(q) || (st.name || '').toLowerCase().includes(q);
  });

  if (!shown.length) {
    list.innerHTML = '<div class="si-empty">没有符合条件的工序</div>';
    return;
  }

  list.innerHTML = shown.map((st) => {
    // 三种状态要能一眼分开：有内容 / 有要求但空 / 连要求都没配
    const noReq = !(st.reqs || []).length;
    const cls = st.items.length ? 'ok' : (noReq ? 'warn' : 'idle');
    const bytes = st.items.reduce((a, i) => a + (i.bytes || 0), 0);
    const tip = `${st.code} ${st.name} · ${st.items.length} 项`
      + (bytes ? ' · ' + fmtBytes(bytes) : '')
      + (noReq ? '（还没配要求）' : '');
    return `<button class="si-row${st.id === S.stPickId ? ' on' : ''}" data-spick="${H(st.id)}"
        title="${H(tip)}">
      <span class="si-dot ${cls}"></span>
      <span class="si-code">${H(st.code)}</span>
      <span class="si-name">${H(st.name)}</span>
      <span class="si-n">${st.items.length || ''}</span>
    </button>`;
  }).join('');
}

/** 右侧编辑区：只渲染当前这一道工序，高度不随工序数增长 */
function renderStEdit() {
  const box = $('stations');
  if (!S.stations.length) {
    $('stNav').innerHTML = '';
    box.innerHTML = '<div class="empty">这个机种还没有工序。去「机种设置」点「+ 批量加工序」，'
      + '或者新建机种时直接填「几道工序」。</div>';
    return;
  }
  renderStNav();
  box.innerHTML = stationHtml(pickedStation());
}

/** 编辑区顶部那条：只报"现在这道工序什么状态"，工序码与名称下面的卡里已经有，不重复 */
function renderStNav() {
  const nav = $('stNav');
  const st = pickedStation();
  if (!st) { nav.innerHTML = ''; return; }
  const i = S.stations.findIndex((x) => x.id === S.stPickId);
  const prev = S.stations[i - 1];
  const next = S.stations[i + 1];
  const bytes = st.items.reduce((a, x) => a + (x.bytes || 0), 0);
  const noReq = !(st.reqs || []).length;

  const stat = st.items.length
    ? `已配 <b>${st.items.length}</b> 项${bytes ? ' · ' + fmtBytes(bytes) : ''}`
    : (noReq ? '<span class="se-warn">还没勾「允许」类型，这道工序不限制文件类型</span>' : '还没有内容');

  nav.innerHTML = `<span class="se-stat">${stat}</span>
    <div class="spacer"></div>
    <span class="se-pos">第 ${i + 1} / ${S.stations.length} 个</span>
    <button class="btn sm" data-snav="-1"${prev ? '' : ' disabled'}>‹ 上一个</button>
    <button class="btn sm" data-snav="1"${next ? '' : ' disabled'}>下一个 ›</button>`;
}

function pickedStation() {
  return S.stations.find((x) => x.id === S.stPickId) || S.stations[0];
}

// ---- 工序索引交互 ----
$('stList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-spick]');
  if (!b || b.dataset.spick === S.stPickId) return;
  S.stPickId = b.dataset.spick;
  renderStations();
  // 切到另一道工序后把编辑区滚回顶部，否则会停在上一张卡的滚动位置
  $('stations').scrollIntoView({ block: 'nearest' });
});

$('stFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sf]');
  if (!b) return;
  S.stFilter = b.dataset.sf;
  for (const x of $('stFilter').querySelectorAll('[data-sf]')) {
    x.classList.toggle('on', x.dataset.sf === S.stFilter);
  }
  renderStIndex();
});

$('stSearch').addEventListener('input', (e) => {
  S.stQuery = e.target.value;
  renderStIndex();
});

$('stNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-snav]');
  if (!b || b.disabled) return;
  const i = S.stations.findIndex((x) => x.id === S.stPickId);
  const t = S.stations[i + Number(b.dataset.snav)];
  if (!t) return;
  S.stPickId = t.id;
  renderStations();
  $('stations').scrollIntoView({ block: 'nearest' });
});

function stationHtml(st) {
  const bytes = st.items.reduce((s, i) => s + (i.bytes || 0), 0);
  const reqCells = KINDS.map((k) => {
    const r = stationReq(st, k);
    const on = !!r;
    return `<label class="req ${on ? 'on' : ''}">
      <input type="checkbox" data-sid="${H(st.id)}" data-kind="${k}" ${on ? 'checked' : ''}>
      <span>${KIND_CN[k]}</span>
      <input class="knum" type="number" min="0" max="99" data-sid="${H(st.id)}" data-kn="${k}"
             value="${on ? (r.minCount || 0) : 0}" ${on ? '' : 'disabled'} title="至少几份">
      ${k === 'image'
        ? `<span class="kres">≥<input type="number" data-sid="${H(st.id)}" data-kw="image"
             value="${on ? (r.minWidth || '') : ''}" placeholder="宽" ${on ? '' : 'disabled'}>×
           <input type="number" data-sid="${H(st.id)}" data-kh="image"
             value="${on ? (r.minHeight || '') : ''}" placeholder="高" ${on ? '' : 'disabled'}></span>`
        : ''}
    </label>`;
  }).join('');

  const items = st.items.length
    ? st.items.map((it, i) => `
      <div class="sitem" data-media="${H(it.mediaId)}">
        <span class="sidx">${i + 1}</span>
        <span class="spic">${it.kind === 'image'
          ? `<img src="${H(it.url)}" alt="" loading="lazy">`
          : `<span class="vtxt">${it.kind === 'video' ? '视频' : 'PDF'}</span>`}</span>
        <div class="sinfo">
          <div class="sn" title="${H(it.name)}">${H(it.name)}</div>
          <div class="sm">${it.srcSha ? 'PDF 页' : (KIND_CN[it.kind] || it.kind)} · ${fmtBytes(it.bytes)}${
            it.kind === 'image' && it.width ? ` · ${it.width}×${it.height}` : ''}${
            playKindsOfSt(st).includes(it.srcSha ? 'pdf' : it.kind)
              ? '' : ' · <i class="offtag" title="「播放内容」里没勾这一类，终端不会放它">不放</i>'}</div>
          <div class="sctrls">
            ${it.kind === 'image'
              ? `<label class="dwell">停留 <input type="number" min="1" max="120" value="${it.dwellSec}"
                   data-sid="${H(st.id)}" data-dwell="${i}"> 秒</label>`
              : '<span class="dwell dim">播完自动下一项</span>'}
            <select class="minisel" data-sid="${H(st.id)}" data-fit="${i}">
              <option value="contain"${it.fit === 'cover' ? '' : ' selected'}>适应 · 不裁</option>
              <option value="cover"${it.fit === 'cover' ? ' selected' : ''}>铺满 · 裁边</option>
            </select>
            <label class="dwell">缩放
              <input type="number" min="50" max="200" step="5" value="${it.zoom || 100}"
                     data-sid="${H(st.id)}" data-zoom="${i}" style="width:64px"> %
            </label>
          </div>
        </div>
        <div class="sacts">
          <button class="iconbtn" data-sid="${H(st.id)}" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-sid="${H(st.id)}" data-down="${i}" ${
            i === st.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" data-sid="${H(st.id)}" data-del="${i}">✕</button>
        </div>
      </div>`).join('')
    : `<div class="sempty">还没有内容。把 PDF、图片或视频拖进上面那个框。</div>`;

  return `<div class="station${st.items.length ? ' has-items' : ''}" data-st="${H(st.id)}">
    <div class="st-head">
      <span class="st-code">${H(st.code)}</span>
      <input class="st-name" data-sid="${H(st.id)}" data-f="name" value="${H(st.name)}" maxlength="40">
      <span class="st-meta">${st.items.length} 项${bytes ? ' · ' + fmtBytes(bytes) : ''}</span>
      <div class="spacer"></div>
      <button class="btn sm" data-sid="${H(st.id)}" data-stdel>删除工序</button>
    </div>

    <div class="st-reqs">
      <span class="st-lbl">允许</span>
      ${reqCells}
      <span class="st-pair"><span class="st-lbl">单文件 ≤</span>
        <input class="knum" type="number" min="0" max="9999" data-sid="${H(st.id)}" data-f="maxMb"
               value="${st.maxMb || 0}" title="0 = 不限"> MB</span>
    </div>

    <div class="st-drop" data-sid="${H(st.id)}">
      拖入文件，或 <button class="btn sm" data-sid="${H(st.id)}" data-pick>选择文件</button>
      <span class="dim">　PDF 自动按页拆成图片；类型以「允许」里勾的为准</span>
    </div>

    <div class="st-items">${items}</div>
  </div>`;
}

/** 只在某张工序卡片内部重绘，避免整页重绘丢焦点 */
function renderOneStation(sid) {
  const el = $('stations').querySelector(`[data-st="${sid}"]`);
  const st = S.stations.find((x) => x.id === sid);
  if (!el || !st) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = stationHtml(st);
  el.replaceWith(tmp.firstElementChild);
}

/** 把某道工序的当前内存状态整体提交（内容/要求都走这一个接口） */
async function saveStation(sid, payload) {
  const st = S.stations.find((x) => x.id === sid);
  if (!st) return null;
  const body = { ...payload };
  if (Array.isArray(body.items)) {
    body.items = body.items.map((it) => ({
      mediaId: it.mediaId, dwellSec: it.dwellSec, fit: it.fit, zoom: it.zoom
    }));
  }
  const out = await putJson('/api/processes/' + encodeURIComponent(sid), body);
  const i = S.stations.findIndex((x) => x.id === sid);
  // 接口回 { ok, process }：整份最新的工序（含要求与内容）在这里换掉旧的那份
  if (i >= 0 && out && out.process) S.stations[i] = { ...S.stations[i], ...out.process };
  // 索引上的项数与体积、顶部那行状态都跟着改，否则要刷新整页才对
  refreshMediaSub();
  renderStIndex();
  renderStNav();
  return out;
}

/** 媒体库副标题：机种内容一改，已配数就变了 */
function refreshMediaSub() {
  const el = $('mediaSub');
  const m = S.models.find((x) => x.id === S.modelId);
  if (!el || !m) return;
  const filled = S.stations.filter((x) => x.items.length > 0).length;
  el.textContent = `${m.code} · ${S.stations.length} 道工序`
    + (S.stations.length ? ` · 已配 ${filled}` : '');
}

// ---- 工序交互 ----
$('stations').addEventListener('click', async (e) => {
  const t = e.target;
  const sid = t.dataset.sid;

  if (t.matches('[data-pick]')) {
    S.uploadStation = sid;
    $('fileInput').value = '';
    $('fileInput').click();
    return;
  }

  if (t.matches('[data-up],[data-down],[data-del]')) {
    const st = S.stations.find((x) => x.id === sid);
    if (!st) return;
    const items = [...st.items];
    if (t.dataset.up !== undefined) {
      const i = +t.dataset.up;
      if (i <= 0) return;
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
    } else if (t.dataset.down !== undefined) {
      const i = +t.dataset.down;
      if (i >= items.length - 1) return;
      [items[i + 1], items[i]] = [items[i], items[i + 1]];
    } else {
      items.splice(+t.dataset.del, 1);
    }
    try {
      await saveStation(sid, { items });
      renderOneStation(sid);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (t.matches('[data-stdel]')) {
    const st = S.stations.find((x) => x.id === sid);
    if (!st) return;
    const ok = await dialog({
      title: `删除工序 ${st.code}？`,
      message: '删的是这个机种下的这道工序，别的机种和文件库都不受影响。' +
        (st.items.length ? `\n\n注意：这道工序还有 ${st.items.length} 项内容，删了要重传。` : ''),
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/processes/' + encodeURIComponent(sid), { method: 'DELETE' });
      await loadStations();
      toast('已删除工序 ' + st.code, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
});

// 名称/上限：失焦提交
$('stations').addEventListener('change', async (e) => {
  const t = e.target;
  const sid = t.dataset.sid;
  if (!sid) return;

  // 允许的类型：勾/去勾要联动数字框能不能填，只能重画这一块
  if (t.dataset.kind) {
    const st = S.stations.find((x) => x.id === sid);
    if (!st) return;
    const kind = t.dataset.kind;
    let reqs = (st.reqs || []).filter((r) => r.kind !== kind);
    if (t.checked) {
      reqs.push({
        kind,
        minCount: 1,
        minWidth: kind === 'image' ? 1280 : 0,
        minHeight: kind === 'image' ? 720 : 0
      });
    }
    reqs.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    try {
      await saveStation(sid, { reqs });
      renderOneStation(sid);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const numField = t.dataset.f === 'maxMb';
  if (t.dataset.f || t.dataset.kn || t.dataset.kw || t.dataset.kh) {
    const st = S.stations.find((x) => x.id === sid);
    if (!st) return;
    const payload = {};
    if (numField) payload.maxMb = Math.max(0, Number(t.value) || 0);
    else if (t.dataset.f === 'name') payload.name = t.value.trim() || st.code;

    if (t.dataset.kn || t.dataset.kw || t.dataset.kh) {
      const kind = t.dataset.kn || t.dataset.kw || t.dataset.kh;
      const reqs = JSON.parse(JSON.stringify(st.reqs || []));
      const r = reqs.find((x) => x.kind === kind);
      if (!r) return;
      const v = Math.max(0, Number(t.value) || 0);
      if (t.dataset.kn) r.minCount = v;
      if (t.dataset.kw) r.minWidth = v;
      if (t.dataset.kh) r.minHeight = v;
      payload.reqs = reqs;
    }

    try {
      await saveStation(sid, payload);
      if (payload.name !== undefined) renderMdList();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  // 播放参数
  const st = S.stations.find((x) => x.id === sid);
  if (!st) return;
  let items = null;
  if (t.dataset.dwell !== undefined) {
    items = st.items.map((it, i) => i === +t.dataset.dwell
      ? { ...it, dwellSec: Math.min(120, Math.max(1, Number(t.value) || 10)) } : it);
  } else if (t.dataset.fit !== undefined) {
    items = st.items.map((it, i) => i === +t.dataset.fit
      ? { ...it, fit: t.value === 'cover' ? 'cover' : 'contain' } : it);
  } else if (t.dataset.zoom !== undefined) {
    items = st.items.map((it, i) => i === +t.dataset.zoom
      ? { ...it, zoom: Math.min(200, Math.max(50, Number(t.value) || 100)) } : it);
  }
  if (!items) return;
  try { await saveStation(sid, { items }); } catch (err) { toast(err.message, 'err'); }
});

// 拖拽上传到工序
['dragenter', 'dragover'].forEach((ev) =>
  $('stations').addEventListener(ev, (e) => {
    const box = e.target.closest('.st-drop');
    if (!box) return;
    e.preventDefault();
    box.classList.add('hot');
  }));
['dragleave', 'drop'].forEach((ev) =>
  $('stations').addEventListener(ev, (e) => {
    const box = e.target.closest('.st-drop');
    if (!box) return;
    e.preventDefault();
    box.classList.remove('hot');
  }));
$('stations').addEventListener('drop', (e) => {
  const box = e.target.closest('.st-drop');
  if (!box) return;
  if (e.dataTransfer?.files?.length) {
    S.uploadStation = box.dataset.sid;
    handleFiles(e.dataTransfer.files);
  }
});

// ---------- 导出 / 导入 / 模板：工序清单（全厂一张表） ----------
// 导出的表和导入模板逐列同构：机种 | 线体 | 工序码 | 名称 | 做什么。
// 导出来改完，用「导入」能整份导回去 —— 这是这套东西存在的唯一理由。

const IMP_LIMIT = 300;   // 预览最多渲染这么多行，再多就只剩统计有意义
const IMP_BADGE = {
  new: '<span class="badge ok">新增</span>',
  diff: '<span class="badge warn">有变化</span>',
  same: '<span class="badge muted">没变化</span>',
  bad: '<span class="badge danger">不合要求</span>'
};
const IMP_FIELD = {
  code: '工序码', name: '名称', note: '做什么', model: '机种', line: '线体',
  // 4.3.0：全量导出里的「工序参数」页多这几列，认到哪列就报哪列
  play: '播放方式', maxMb: '单文件上限',
  kinds: '允许类型', minSize: '图片最小尺寸', playKinds: '播放内容'
};

function blobSave(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// 前端自己拼 CSV：未导入明细要当场能存，不值得为它多开一条接口。
// \ufeff 是 BOM —— 不加的话 Excel 双击打开中文全是乱码；CRLF 同理。
function saveCsv(name, rows) {
  const line = (r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
  blobSave(new Blob(['\ufeff' + rows.map(line).join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// 用 fetch 拿 blob 而不是把地址直接丢给浏览器：服务端拒绝时（比如"还没配过工序"）
// 返回的是 JSON，直接跳转会在新标签页里显示一段 JSON 报错，现场看不懂。
async function downloadFile(url, fallback) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) {
    let msg = `下载失败（${r.status}）`;
    try { const j = await r.json(); msg = j.error || msg; } catch { /* 不是 JSON 就用默认话术 */ }
    throw new Error(msg);
  }
  const cd = r.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallback;
  blobSave(await r.blob(), name);
  toast(`已下载 ${name}`, 'ok');
}

// 导出：先问范围。以前只能整厂导，想单独看一个机种得把整份文件翻一半。
$('stExportBtn').addEventListener('click', async () => {
  const m = S.models.find((x) => x.id === S.mdModelId);
  const opts = ['<option value="all">全厂 —— 所有机种的工序</option>'];
  if (m) opts.push(`<option value="model">只导出「${H(m.name)}」</option>`);

  const r = await dialog({
    title: '导出工序清单',
    message: '四列：机种 / 工序码 / 名称 / 做什么。在 Excel 里改完，可以用「导入」整份导回来。',
    html: `<div class="dlg-row"><label for="expRange">导出范围</label>
      <select id="expRange" class="dlg-sel">${opts.join('')}</select></div>`,
    read: (b) => b.querySelector('#expRange').value,
    okText: '下载'
  });
  if (!r) return;

  const qs = r === 'model' ? `?modelId=${encodeURIComponent(S.mdModelId)}` : '';
  try { await downloadFile('/api/export/processes.xlsx' + qs, '工序清单.xlsx'); }
  catch (err) { toast(err.message, 'err'); }
});

// 导入模板：与导出的表逐列同构，多两行示例 + 一页填写说明
$('stTplBtn').addEventListener('click', async () => {
  try { await downloadFile('/api/export/template.xlsx', '工序清单导入模板.xlsx'); }
  catch (err) { toast(err.message, 'err'); }
});

// 导入：选文件 → 服务端只解析不落库 → 预览逐行判定 → 确认才写。
// 不直接导入是因为工艺表格式五花八门，行一错位就得一条条删回来。
$('stImportBtn').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.csv,.txt';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;

    // 带上当前选中的机种：老的三列文件（没有机种列）要靠它定位。
    // 全厂表自带机种列，服务端优先用表里的。
    const qs = new URLSearchParams({ filename: f.name });
    if (S.mdModelId) qs.set('modelId', S.mdModelId);

    let d;
    try {
      d = await api('/api/import/parse?' + qs.toString(), { method: 'POST', body: await f.arrayBuffer() });
    } catch (err) { return toast(err.message, 'err'); }
    await showImportPreview(d);
  };
  inp.click();
});

/** 导入预览：一张逐行状态表 + 一个处理方式下拉。看清楚了才让点确认。 */
async function showImportPreview(d) {
  const c = d.counts;
  const flat = d.mode === 'flat';
  const cols = Object.keys(IMP_FIELD)
    .filter((f) => d.mapping[f] !== undefined)
    .map((f) => IMP_FIELD[f]).join(' · ');
  const scope = flat
    ? `表里带机种/线体，按行分到 <b>${d.targets.length}</b> 个「机种 · 线体」`
    : `表里没有机种/线体列，全部导到 <b>${H(d.targets[0].modelName)} · ${H(d.targets[0].lineName)}</b>`;

  const shown = d.rows.slice(0, IMP_LIMIT);
  const canImport = c.new + c.diff + c.same;

  const html = `
    <div class="imp-meta">
      <div>来源 <b>${H(d.filename)}</b>${d.sheet ? ` · 页签 <b>${H(d.sheet)}</b>` : ''} ｜ ${d.header ? `第 ${d.headerRow} 行是表头` : '没有表头，按前三列读'} ｜ 认到 <b>${H(cols)}</b></div>
      <div>${scope}</div>
      ${d.sheet === '工序参数' ? `<div class="imp-dim">这是老版「线体设置」导出的全量表里的「工序参数」页：
        除名称和做什么，还会把播放方式、播放内容、单文件上限、允许类型一起写回去（老表里的工时不认了）。</div>` : ''}
    </div>
    <div class="imp-sum">
      <span class="imp-k ok"><b>${c.new}</b> 道新增</span>
      <span class="imp-k warn"><b>${c.diff}</b> 道有变化</span>
      <span class="imp-k"><b>${c.same}</b> 道没变化</span>
      ${c.bad ? `<span class="imp-k bad"><b>${c.bad}</b> 行不合要求</span>` : ''}
    </div>
    <div class="imp-wrap">
      <table class="imp-table">
        <thead><tr>
          <th style="width:46px">行号</th><th style="width:74px">状态</th>
          ${flat ? '<th>机种</th><th>线体</th>' : ''}
          <th style="width:82px">工序码</th><th>名称</th><th>说明</th>
        </tr></thead>
        <tbody>${shown.map((r) => `
          <tr class="${r.status === 'bad' ? 'is-bad' : ''}">
            <td class="imp-no">${r.row}</td>
            <td>${IMP_BADGE[r.status] || H(r.status)}</td>
            ${flat ? `<td class="imp-dim">${H(r.modelName || '')}</td><td class="imp-dim">${H(r.lineName || '')}</td>` : ''}
            <td class="imp-code">${H(r.code || '—')}</td>
            <td>${H(r.name || '')}</td>
            <td class="imp-why">${H(r.reason || r.detail || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${d.rows.length > shown.length ? `<p class="imp-more">表里共 ${d.rows.length} 行，预览只列前 ${shown.length} 行，导入按全表走。</p>` : ''}
    ${c.bad ? '<p class="imp-more">不合要求的行不会导入，导入完成后可以一键导出明细（带原因）。</p>' : ''}
    <div class="dlg-row" style="margin-top:12px">
      <label for="impMode">已存在的工序怎么处理</label>
      <select id="impMode" class="dlg-sel">
        <option value="update"${c.diff ? ' selected' : ''}>加新的 + 更新有变化的（${c.diff} 道）</option>
        <option value="merge"${c.diff ? '' : ' selected'}>只加新的，已存在的一律跳过</option>
        <option value="update-only">只更新已存在的，不新建工序</option>
      </select>
    </div>`;

  const r = await dialog({
    title: canImport ? `导入预览 · ${canImport} 道可导` : '导入预览 · 没有可导的行',
    html,
    read: (b) => b.querySelector('#impMode').value,
    okText: '确认导入'
  });
  if (!r) return;

  // extra 要原样带上（播放方式 / 上限 / 工时 / 允许类型 / 最小尺寸），
  // 少了它预览说有变化、导进去却只改了名字
  const send = d.rows
    .filter((x) => x.status !== 'bad')
    .map(({ row, modelId, code, name, note, extra }) => ({ row, modelId, code, name, note, extra }));

  let out;
  try { out = await postJson('/api/processes/import', { rows: send, mode: r }); }
  catch (err) { return toast(err.message, 'err'); }

  await loadMdProcesses();
  await showImportResult(out, d);
}

/** 导入结果：写进去多少 + 没导进去的逐行原因 + 导出明细 / 撤销本次导入 */
async function showImportResult(out, d) {
  const bad = d.rows.filter((x) => x.status === 'bad').map((x) => ({
    row: x.row, model: x.modelName || '', line: x.lineName || '',
    code: x.code || '', name: x.name || '', reason: x.reason
  }));
  // 落库阶段又失败的（预览本该拦住，兜底留证，别只留一个数字）
  (out.bad || []).forEach((b) => bad.push({
    row: b.row, model: '', line: '', code: b.code || '', name: '', reason: b.reason
  }));

  const parts = [];
  if (out.created) parts.push(`新增 <b>${out.created}</b> 道`);
  if (out.updated) parts.push(`更新 <b>${out.updated}</b> 道`);
  if (out.kept) parts.push(`没变化 <b>${out.kept}</b> 道`);
  if (out.skipped) parts.push(`跳过 <b>${out.skipped}</b> 道`);
  if (!parts.length) parts.push('没有需要写库的行');

  const list = bad.slice(0, 200).map((b) => `
    <tr><td class="imp-no">${b.row}</td>
      <td class="imp-code">${H(b.code || '—')}</td>
      <td>${H(b.name || '')}</td>
      <td class="imp-why">${H(b.reason)}</td></tr>`).join('');

  const acts = `
      ${bad.length ? '<button class="btn sm" data-imp="csv">导出未导入明细 CSV</button>' : ''}
      ${out.batchId ? `<button class="btn sm danger" data-imp="undo" data-batch="${H(out.batchId)}" data-n="${out.created}">撤销本次导入（${out.created} 道）</button>` : ''}`;

  const html = `
    <div class="imp-meta"><div>${parts.join(' ｜ ')}</div></div>
    ${bad.length ? `
      <div class="imp-sub">没导进去的 ${bad.length} 行</div>
      <div class="imp-wrap">
        <table class="imp-table">
          <thead><tr><th style="width:46px">行号</th><th style="width:82px">工序码</th><th>名称</th><th>原因</th></tr></thead>
          <tbody>${list}</tbody>
        </table>
      </div>
      ${bad.length > 200 ? '<p class="imp-more">只列前 200 行，导出的 CSV 里是全的。</p>' : ''}` : ''}
    <div class="imp-acts">${acts}</div>`;

  window.__impBad = bad;
  window.__impActs = acts;   // 「算了」时把按钮换回来
  await dialog({ title: '导入完成', html, okText: '知道了', hideCancel: true });
}

// 结果窗口里的两个动作走委托，不给 HTML 塞内联 onclick ——
// 以后加按钮只改 data-imp，不用再挂一个 window 全局函数。
$('dlgBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-imp]');
  if (!btn) return;

  if (btn.dataset.imp === 'csv') {
    const rows = window.__impBad || [];
    if (!rows.length) return toast('这次没有未导入的行', 'warn');
    saveCsv('未导入明细_' + fileStamp() + '.csv', [
      ['行号', '机种', '线体', '工序码', '名称', '未导入原因'],
      ...rows.map((x) => [x.row, x.model, x.line, x.code, x.name, x.reason])
    ]);
    toast(`已导出 ${rows.length} 条未导入明细`, 'ok');
    return;
  }

  if (btn.dataset.imp === 'undo') {
    // 二次确认直接在结果窗里换按钮，不再弹一层 ——
    // 所有对话框共用 #dialog 这一个元素，叠一层会把结果窗连同未导入明细一起冲掉。
    const n = Number(btn.dataset.n) || 0;
    btn.parentElement.innerHTML =
      `<div class="imp-warn">会把这次新建的 ${n} 道工序删掉，已经配上去的图片/视频也一起没；改过名字的工序不会还原。</div>
       <button class="btn sm danger" data-imp="undo-do" data-batch="${H(btn.dataset.batch)}">确定撤销</button>
       <button class="btn sm" data-imp="undo-cancel">算了</button>`;
    return;
  }

  if (btn.dataset.imp === 'undo-cancel') {
    const html = window.__impActs || '';
    btn.parentElement.innerHTML = html;
    return;
  }

  if (btn.dataset.imp === 'undo-do') {
    btn.disabled = true;
    try {
      const r = await postJson('/api/processes/import/undo', { batchId: btn.dataset.batch });
      toast(`已撤销 ${r.deleted} 道工序`, 'ok');
      await loadMdProcesses();
      $('dlgOk').click();   // 把结果窗收掉，别让人对着一个已经过期的数字
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'err');
    }
  }
});

// 机种设置页：批量加工序（给这个机种补工序定义）
// 一行一条从 Excel 贴过来，比一个个弹窗快二十倍 —— 现场一个机种十几道工序是常态
$('stAddBtn').addEventListener('click', async () => {
  if (!S.mdModelId) return toast('先选一个机种', 'err');
  const text = await bulkDialog({
    title: '批量加工序',
    message: '一行一条，格式「工序码 名称」。工序码就是终端上的 op 参数，默认从 OP1 起编。',
    placeholder: 'OP1 装配\nOP2 调试\nOP3 检验'
  });
  if (!text) return;
  const rows = parseBulk(text);
  if (!rows.length) return toast('没有可用的行', 'err');

  let okN = 0;
  const bad = [];
  for (const r of rows) {
    try {
      await postJson('/api/processes', { modelId: S.mdModelId, code: r.code, name: r.name });
      okN += 1;
    } catch (err) { bad.push(`${r.code}：${err.message}`); }
  }
  await loadMdProcesses();
  renderMdList();               // 徽标分母变了
  if (okN) toast(`已加 ${okN} 道工序`, 'ok');
  if (bad.length) {
    await dialog({
      title: `${bad.length} 个没加上`,
      message: bad.join('\n'),
      okText: '知道了',
      hideCancel: true
    });
  }
});

// ==================== 上传 ====================
/**
 * 上传。4.4.0 起文件按「机种 / 工序」落盘，所以要带上归属：
 * 拖进哪张工序卡就落到 media/<机种编号>/<工序码>/，媒体库右上角直接传的进 _未分配。
 */
function uploadFile(file, onProgress, owner) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ filename: file.name });
    if (owner && owner.modelId) qs.set('modelId', owner.modelId);
    if (owner && owner.processId) qs.set('processId', owner.processId);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media/upload?' + qs.toString());
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch { d = { error: xhr.responseText }; }
      if (xhr.status >= 400) return reject(new Error(d.error || ('上传失败 HTTP ' + xhr.status)));
      resolve(d);
    };
    xhr.onerror = () => reject(new Error('上传失败：网络中断'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(file);
  });
}

function uplRow(name) {
  const box = $('uplList');
  box.classList.remove('hide');
  const el = document.createElement('div');
  el.className = 'uplrow';
  el.innerHTML = '<span class="nm"></span><span class="pct">0%</span><span class="pg"><i></i></span>';
  el.querySelector('.nm').textContent = name;
  box.appendChild(el);
  const bar = el.querySelector('.pg i');
  const pct = el.querySelector('.pct');
  return {
    set(v, text) {
      const p = Math.max(0, Math.min(1, v || 0));
      bar.style.width = (p * 100) + '%';
      pct.textContent = text || Math.round(p * 100) + '%';
    },
    ok(text) { el.classList.add('ok'); bar.style.width = '100%'; pct.textContent = text || '完成'; },
    err(text) { el.classList.add('err'); bar.style.width = '100%'; pct.textContent = text || '失败'; }
  };
}

function clearUplIfIdle() {
  const box = $('uplList');
  if (!box.querySelector('.uplrow')) { box.classList.add('hide'); return; }
  setTimeout(() => {
    if (!box.querySelector('.uplrow')) box.classList.add('hide');
  }, 2600);
}

/**
 * 上传落库 → 直接把文件追加到这道工序的内容里。
 * 为什么不先进媒体库再引用：现场的动作是"这道工序要这几张图"，
 * 让他先传完再挑一遍是多余的两步。
 */
async function handleFiles(files) {
  const sid = S.uploadStation;
  const st = S.stations.find((x) => x.id === sid);
  if (!st) return toast('先选一个工序', 'err');
  const list = [...files];
  if (!list.length) return;

  const allowed = (st.reqs || []).map((r) => r.kind);
  const items = [...st.items];
  let added = 0;

  for (const f of list) {
    const row = uplRow(f.name);
    try {
      const d = await uploadFile(f, (v) => row.set(v, v >= 1 ? '处理中' : Math.round(v * 100) + '%'),
        { modelId: st.modelId || S.modelId, processId: sid });

      if (d.kind === 'pdf') {
        for (const p of d.pages || []) {
          if (allowed.length && !allowed.includes(p.kind)) continue;
          if (items.some((x) => x.mediaId === p.id)) continue;
          items.push({ mediaId: p.id, kind: p.kind, name: p.name, bytes: p.bytes,
            url: p.url, width: p.width, height: p.height, dwellSec: 10, fit: 'contain', zoom: 100 });
          added++;
        }
        row.ok(`${d.pageCount} 页`);
        continue;
      }

      if (d.kind === 'file') {
        row.err('类型不支持');
        toast(`不是图片、视频或 PDF，已跳过：${f.name}`, 'err');
        continue;
      }
      if (allowed.length && !allowed.includes(d.kind)) {
        row.err('类型不允许');
        toast(`这道工序不允许放${KIND_CN[d.kind] || d.kind}：${f.name}。\n需要的话先在这道工序上勾选该类型。`, 'err');
        continue;
      }
      if (items.some((x) => x.mediaId === d.id)) { row.ok('已在清单'); continue; }

      items.push({
        mediaId: d.id, kind: d.kind, name: d.name, bytes: d.bytes, url: d.url,
        width: d.width, height: d.height,
        dwellSec: d.kind === 'image' ? 10 : 0, fit: 'contain', zoom: 100
      });
      added++;
      row.ok(d.duplicated ? '复用' : '完成');
    } catch (err) {
      row.err('失败');
      toast(err.message, 'err');
    }
  }

  if (added) {
    try {
      await saveStation(sid, { items });
      renderOneStation(sid);
      toast(`已加入 ${added} 项到 ${st.code}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  clearUplIfIdle();
}

$('fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

// ==================== 媒体库 ====================
/** 线体清单：机种设置里要用（这个机种能在哪几条线上做），系统页也要用 */
async function loadLines() {
  const d = await api('/api/lines');
  S.lines = d.lines || [];
  return S.lines;
}

// ==================== 终端监控 ====================
/**
 * 一张表看完：谁连上来了、报的哪条线哪道工序、多久没心跳、什么版本。
 * 线体 / 工序是屏自己填的，这里只读不写 —— 单机单线场景，屏上填错直接到屏前改更快。
 * 唯一要报的异常是「两台屏报同一道工序」，那一定有一台填错了号。
 */
async function loadClients() {
  try {
    S.clients = await api('/api/clients');
  } catch {
    S.clients = null;
  }
  renderClientTable();
  renderTopStats();
}

function ageShort(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + ' 秒';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' 分钟';
  return Math.round(min / 60) + ' 小时';
}

function renderClientTable() {
  const tb = $('clientTable').querySelector('tbody');
  const d = S.clients;
  if (!d) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">读不到屏列表</td></tr>';
    $('termSub').textContent = '—';
    return;
  }
  if (!d.clients.length) {
    $('termSub').textContent = '还没有屏连上来';
    tb.innerHTML = `<tr><td colspan="8" class="empty">
      还没有任何屏连上来。屏第一次启动时在设置里填服务端地址，之后每 5 秒自动登记一次，这里就会出现。</td></tr>`;
    return;
  }

  // 同一道工序被两台屏报到 = 一定有一台填错了号（换屏时最容易发生）
  const seen = new Map();
  for (const c of d.clients) {
    if (!c.lineCode || !c.opCode) continue;
    const k = c.lineCode + '|' + c.opCode;
    seen.set(k, (seen.get(k) || 0) + 1);
  }

  $('termSub').textContent = `共 ${d.total} 台 · 在线 ${d.online} 台 · 每 2 秒自动刷新`;

  tb.innerHTML = d.clients.map((c) => {
    const key = c.lineCode && c.opCode ? c.lineCode + '|' + c.opCode : '';
    const dup = key && (seen.get(key) || 0) > 1;

    let state;
    if (!c.online) state = `<span class="badge danger">离线 ${H(ageShort(c.ageMs))}</span>`;
    else if (dup) state = '<span class="badge warn">工序重号 · 两台屏报同一道</span>';
    else if (c.status === 'playing') state = '<span class="badge ok">在线 · 播放中</span>';
    else state = '<span class="badge ok">在线</span>';

    return `<tr>
      <td class="mono">${H(c.ip)}</td>
      <td>${c.name ? H(c.name) : '<span class="muted">—</span>'}</td>
      <td class="mono">${H(c.lineCode || '—')}</td>
      <td class="mono">${H(c.opCode || '—')}</td>
      <td class="num">${H(ageShort(c.ageMs))}前</td>
      <td class="mono">${c.ver ? 'v' + H(c.ver) : '—'}</td>
      <td>${state}</td>
      <td><button class="btn xs ghost danger" data-cdel="${H(c.ip)}"
        title="只删台账记录；屏还在跑的话 5 秒后会重新出现">删除</button></td>
    </tr>`;
  }).join('');
}

$('termRefresh').addEventListener('click', () => loadClients().catch(() => {}));

$('clientTable').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-cdel]');
  if (!del) return;
  const ip = del.dataset.cdel;
  const ok = await ask('删除这条屏记录？',
    `${ip} 会从列表里消失。\n\n`
    + '这只清服务端的台账，不是封禁：如果这台屏还在运行，下一次心跳（5 秒内）就会把它重新登记回来。');
  if (!ok) return;
  try {
    await api('/api/clients/' + encodeURIComponent(ip), { method: 'DELETE' });
    toast('已删除记录', 'ok');
    await loadClients();
  } catch (err) { toast(err.message, 'err'); }
});

// 终端监控页 2 秒刷新；不在这一页就不占带宽
setInterval(() => {
  if (S.tab !== 'terms' || document.hidden) return;
  loadClients().catch(() => {});
}, 2000);

// ==================== 系统页：本厂线体 ====================
const LINE_STATUS_TEXT = [
  ['running', '运行中'],
  ['stopped', '停用'],
  ['maintain', '维修中'],
  ['care', '保养中']
];

function renderSysLines(rows) {
  const box = $('sysLines');
  if (!box) return Promise.resolve();
  const paint = (lines) => {
    if (!lines.length) {
      box.innerHTML = '<div class="lan-item">还没有线体 —— 交付包应当自带 11 条，这里空的说明库不对</div>';
      return;
    }
    box.innerHTML = lines.map((l) => `<div class="sys-line">
        <b class="sl-name">${H(l.name)}</b>
        <span class="sl-code">${H(l.code)}</span>
        <span class="sl-on">在线 ${l.onlineCount || 0}</span>
        <div class="spacer"></div>
        <select class="btn xs" data-lstatus="${H(l.id)}" style="padding:4px 6px">
          ${LINE_STATUS_TEXT.map(([v, t]) =>
            `<option value="${v}"${l.status === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="btn xs" data-lname="${H(l.id)}">改名</button>
      </div>`).join('');
  };
  if (rows) { paint(rows); return Promise.resolve(); }
  return loadLines().then(paint);
}

$('sysLines').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-lstatus]');
  if (!sel) return;
  try {
    await putJson('/api/lines/' + encodeURIComponent(sel.dataset.lstatus), { status: sel.value });
    toast(sel.value === 'running' ? '已改为运行中，这条线的屏开始播内容' : '已改为' + sel.options[sel.selectedIndex].text, 'ok');
    await loadBoard();
    await renderSysLines();
  } catch (err) { toast(err.message, 'err'); await renderSysLines(); }
});

$('sysLines').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-lname]');
  if (!btn) return;
  const id = btn.dataset.lname;
  const line = (S.lines || []).find((l) => l.id === id);
  if (!line) return;
  const out = await dialog({
    title: '改线体名称',
    message: '编码（' + line.code + '）是终端寻址用的，这里只改显示名称。',
    fields: [{ key: 'name', label: '名称', value: line.name }],
    okText: '保存'
  });
  if (!out || !out.name) return;
  try {
    await putJson('/api/lines/' + encodeURIComponent(id), { name: out.name });
    toast('已改名', 'ok');
    await loadBoard();
    await renderSysLines();
  } catch (err) { toast(err.message, 'err'); }
});

// ==================== 桌面程序：系统面板 ====================
const desk = window.vwiDesktop;

if (desk) {
  document.body.classList.add('is-desktop');

  // 系统页跟其它视图一样切过来就渲染，不再是弹层
  const openSys = () => {
    desk.info().then((info) => {
      $('sysVer').textContent = 'v' + info.version;
      $('sysPort').textContent = info.port;
      $('sysData').textContent = info.dataDir;
      $('sysData').title = info.dataDir;
      $('sysLog').textContent = info.logFile;
      $('sysLog').title = info.logFile;
      $('sysAuto').checked = !!info.autoStart;
      $('sysAutoTxt').textContent = info.autoStart ? '已开启' : '已关闭';

      // 开发模式（直接跑 electron .）下不能写开机自启：那会把 electron.exe 注册进去
      if (info.dev) {
        $('sysAuto').disabled = true;
        $('sysAutoTxt').textContent = '仅打包后可用（当前为开发模式）';
      }

      // 终端装机要填的地址。127.0.0.1 单独提醒 —— 填到别的机器上必然连不上
      const lan = info.lan || [];
      $('sysLan').innerHTML = lan.length
        ? '<div class="lan-list">' + lan.map((it) => (
            '<div class="lan-item"><b>' + H(it.url) + '</b>' +
            '<span class="nic">' + H(it.name) + '</span>' +
            '<div class="spacer"></div>' +
            '<button class="btn" data-copy="' + H(it.url) + '">复制</button></div>'
          )).join('') + '</div>' +
          (lan.length > 1 ? '<div class="lan-tip">有多张网卡时，选名字对得上现场网线的那张。' +
            '带 vEthernet / VMnet / WSL 的是虚拟网卡，填了终端连不上。</div>' : '')
        : '<div class="lan-item">没有检测到局域网地址，请确认网线已插、IP 已配置</div>';
    }).catch((err) => {
      // 拿不到桌面信息时至少给句人话，别留一片「—」
      toast('读取系统信息失败：' + (err && err.message ? err.message : err), 'err');
    });
  };

  loadSysPanel = openSys;

  // 本厂线体：终端按「线号 + 工序号」寻址，只有 running 的线屏才播
  renderSysLines().catch(() => {});

  $('sysLan').addEventListener('click', async (e) => {
    const url = e.target.dataset && e.target.dataset.copy;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('已复制 ' + url, 'ok');
    } catch { toast('复制失败，请手动选中地址复制', 'err'); }
  });

  $('sysOpenData').addEventListener('click', () => desk.openData());
  $('sysOpenLog').addEventListener('click', () => desk.openLog());

  $('sysAuto').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const real = await desk.setAutoStart(on);
    e.target.checked = !!real;
    $('sysAutoTxt').textContent = real ? '已开启' : '已关闭';
    toast(real ? '已设为开机自动启动' : '已取消开机自动启动', 'ok');
  });

  $('sysHide').addEventListener('click', () => desk.hide());

  $('sysQuit').addEventListener('click', async () => {
    const n = S.board.reduce((s, l) => s + l.onlineCount, 0);
    if (n > 0) {
      const ok = await ask(
        '终端还在线',
        '还有 ' + n + ' 台终端在线。\n\n退出会中断它们的播放，等于整线停产。确定要退出吗？',
        '仍然退出',
        true
      );
      if (!ok) return;
    }
    desk.quit();
  });

  desk.info().then((info) => {
    $('verTxt').textContent = info.version;
    S.version = info.version;
    document.title = 'ESOP 服务端 v' + info.version;
  });
}

// ==================== 启动 ====================
(async function boot() {
  try {
    syncNav();
    // 机种列表要早一点拿到：总览的换型下拉、机种设置都靠它
    const m = await api('/api/models');
    S.models = m.models || [];
    await loadBoard();
    renderSysLines().catch(() => {});   // 系统页的线体清单（浏览器版也填，桌面版还有托盘信息）
    const st = await api('/api/status').catch(() => null);
    if (st && st.version) { S.version = st.version; renderSideFoot(); }
  } catch (err) {
    toast('连接服务端失败：' + err.message, 'err');
  }
})();

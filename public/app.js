// 管理端逻辑：总览 + 线体/机种设置 + 媒体库 + 终端监控
// 无框架、无构建，浏览器直接跑。所有状态都在内存，一次刷新从服务端重建。
//
// 页面分工（v3.2.0）：定义和内容彻底分开，一页只干一件事。
//   作业内容 = 总览，只读 + 换型。现场天天看的就是这一页。
//   线体设置 = 这条线上有几块屏（工序），以及今天哪条线在跑。
//   机种设置 = **定义层**：这个机种在某条线上有哪些工序、各做什么。
//              表格里只有工序码 / 名称 / 做什么，不含任何文件。
//   媒体库   = **内容层**：先选机种、再选工位、再上传图片 / PDF / 视频。
//              允许类型与体积上限也在这里勾，因为它们只在上传时起作用。
//   文件查询 = 全库文件：搜索、规格体检、清理未引用。
//   终端监控 / 系统 = 设备台账与本机设置。

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

  models: [],

  // 机种设置（定义层）：只看"有哪些工序、各做什么"，不碰内容
  mdModelId: '',
  mdLineId: '',
  mdStations: [],
  mdQuery: '',

  // 媒体库（内容层）：选机种 → 选工位 → 传文件
  modelId: '',
  stLineId: '',
  stations: [],
  // 一个机种普遍有 15–25 道工序，全摊成一列会变成几千像素的长条，
  // 所以改成「左边工位索引、右边只编一个」：索引永远一屏看得完，编辑区高度固定。
  stPickId: '',      // 正在编辑哪个工位
  stFilter: 'all',   // all | has | empty
  stQuery: '',       // 工位索引里的搜索词

  procLineId: '',
  processes: [],

  terms: null,
  termLineId: '',

  media: null,
  libAll: null,

  // 上传落在哪个工位
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
function dialog({ title, message = '', fields = [], okText = '确定', danger = false, html = '', read = null, hideCancel = false }) {
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
        </div>`).join('');

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
  lines: '线体设置',
  models: '机种设置',
  media: '媒体库',
  files: '文件查询',
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
    if (v === 'lines') { loadLines().catch(() => {}); }
    if (v === 'models') { loadModels().catch(() => {}); }   // 定义层：工序清单
    if (v === 'media') loadStations().catch(() => {});      // 内容层：按工序传文件
    if (v === 'files') loadMedia();                         // 全库查询：体检与清理
    if (v === 'terms') loadTerms().catch(() => {});
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
  renderTopStats();
  renderSideFoot();
}

function clientChip(c, curCode) {
  const noContent = curCode && !c.hasContent;
  let cls = 'muted';
  let text = '未上线';

  if (c.status === 'ready') { cls = 'ok'; text = '已就绪'; }
  else if (c.status === 'playing') { cls = 'run'; text = '运行中'; }
  else if (c.status === 'loading') {
    cls = 'warn';
    text = c.total > 0 ? `下载 ${c.done}/${c.total}` : '下载中';
  }
  else if (c.status === 'preparing') { cls = 'warn'; text = '准备中'; }
  else if (c.status === 'stale') { cls = 'warn'; text = '未刷新'; }
  else if (c.status === 'offline') { cls = 'off'; text = '离线'; }
  else if (c.status === 'nomodel') { text = '无机种'; }
  else if (c.status === 'absent') { text = '未上线'; }

  // 这个机种在这个工位上压根没内容 —— 换型必然卡在这里，必须提前看见
  const warn = noContent ? '<i class="cl-warn" title="当前机种在这个工位没有内容"></i>' : '';

  return `<span class="cl ${cls}" title="${H(c.name)} ${H(c.ip || '')}">${warn}<b>${H(c.op)}</b>${H(c.name)} · ${H(text)}</span>`;
}

function renderBoard() {
  const box = $('board');
  if (!S.board.length) {
    box.innerHTML = '<div class="empty">还没有线体。先到「线体设置」建一条。</div>';
    $('boardHint').textContent = '';
    return;
  }

  const enabledModels = S.models.filter((m) => m.enabled);
  const opts = (cur) => enabledModels.map((m) =>
    `<option value="${H(m.code)}"${m.code === cur ? ' selected' : ''}>${H(modelLabel(m))}</option>`
  ).join('');

  box.innerHTML = S.board.map((l) => {
    const preparing = l.phase === 'prepare';
    const left = l.deadline ? l.deadline - Date.now() : 0;

    const modelBlock = preparing
      ? `<div class="bc-model switching">
           <span class="k">换型中</span>
           <b>${H(l.currentModelCode || '—')}</b>
           <span class="arrow">→</span>
           <b class="to">${H(l.pendingModelCode || '')}</b>
           <span class="prog"><i style="width:${l.clients.length ? Math.round(l.readyCount / l.clients.length * 100) : 0}%"></i></span>
           <span class="sub">已就绪 ${l.readyCount}/${l.clients.length}　超时强切 ${mmss(left)}</span>
         </div>`
      : `<div class="bc-model ${l.currentModelCode ? '' : 'none'}">
           <span class="k">当前机种</span>
           <b>${H(l.currentModelCode || '未指定')}</b>
           <span class="nm">${H(l.currentModelCode ? (l.currentModelName || '') : '从右边选一个机种换型')}</span>
         </div>`;

    const missing = l.currentModelCode
      ? l.clients.filter((c) => !c.hasContent).map((c) => c.op)
      : [];
    // 内容覆盖：当前机种有几个工位配了内容。没指定机种时不显示（0/5 会误导成"没配"）
    const withContent = l.clients.filter((c) => c.hasContent).length;

    return `<div class="bcard ${l.enabled ? 'on' : ''}${preparing ? ' preparing' : ''}" data-lid="${H(l.id)}">
      <div class="bc-head">
        <span class="bc-name">${H(l.name)}</span>
        <span class="bc-code">${H(l.code)}</span>
        ${l.enabled ? '<span class="badge ok">启用中</span>' : '<span class="badge muted">未启用</span>'}
        <div class="spacer"></div>
        ${l.currentModelCode ? `<span class="bc-online" title="当前机种有几个工位配了内容">内容 <b>${withContent}</b>/${l.clients.length}</span>` : ''}
        <span class="bc-online">在线 <b>${l.onlineCount}</b>/${l.clients.length}</span>
      </div>

      ${modelBlock}

      <div class="bc-clients">
        ${l.clients.map((c) => clientChip(c, l.currentModelCode)).join('') || '<span class="sub">这条线还没有工序</span>'}
      </div>

      ${missing.length
        ? `<div class="bc-alert">当前机种在这几个工位没有内容：<b>${missing.map(H).join('、')}</b>
             <button class="btn sm" data-goto-model="${H(l.currentModelId)}">去机种设置补</button></div>`
        : ''}

      <div class="bc-acts">
        <select class="bc-sel" data-sel="${H(l.id)}">
          ${opts(l.pendingModelCode || l.currentModelCode)}
        </select>
        <button class="btn sm primary" data-switch="${H(l.id)}"
          ${l.enabled ? '' : 'disabled title="这条线没启用，终端不会读它"'}>换型</button>
        ${preparing ? `<button class="btn sm danger" data-cancel="${H(l.id)}">放弃切换</button>` : ''}
      </div>
    </div>`;
  }).join('');

  $('boardHint').innerHTML =
    '卡片上绿的是已就绪、黄的是正在下载或还没刷新、灰的是没上线。' +
    '<b>换型</b>只会下发到这条线的终端；内容不齐时终端仍会播旧的一套，不会出现半新半旧。';
}

$('board').addEventListener('click', async (e) => {
  const goto = e.target.closest('[data-goto-model]');
  if (goto) {
    S.tab = 'models';
    S.modelId = goto.dataset.gotoModel || '';
    syncNav();
    await loadModels();
    return;
  }

  const sw = e.target.closest('[data-switch]');
  if (sw) {
    const lid = sw.dataset.switch;
    const sel = $('board').querySelector(`[data-sel="${lid}"]`);
    const code = sel ? sel.value : '';
    if (!code) return toast('没有可换的机种', 'err');
    const line = S.board.find((x) => x.id === lid);
    if (line && code === line.currentModelCode && line.phase !== 'prepare') {
      return toast(`「${line.name}」已经是 ${code}`);
    }
    try {
      sw.disabled = true;
      const r = await postJson('/api/board/switch', { lineId: lid, modelCode: code });
      toast(r.activated ? `已切换到 ${code}` : `已下发：各终端开始准备 ${code}`, 'ok');
      await loadBoard();
    } catch (err) {
      toast(err.message, 'err');
      sw.disabled = false;
    }
    return;
  }

  const cn = e.target.closest('[data-cancel]');
  if (cn) {
    try {
      await postJson('/api/switch/cancel', { lineId: cn.dataset.cancel });
      toast('已放弃本次切换，画面保持原机种');
      await loadBoard();
    } catch (err) { toast(err.message, 'err'); }
  }
});

// 总览 2 秒刷一次：换型进度和在线数要实时，切走页面就停
S.boardTimer = setInterval(() => {
  if (S.tab !== 'board' || document.hidden) return;
  loadBoard().catch(() => {});
}, 2000);

// ---------- 侧栏底部 ----------
function renderSideFoot() {
  const on = S.board.filter((l) => l.enabled);
  const online = S.board.reduce((s, l) => s + l.onlineCount, 0);
  $('onlineTxt').textContent = online;
  $('dot').classList.toggle('on', online > 0);
  $('curTxt').textContent = on.length ? on[0].name : '未指定';
  $('verTxt').textContent = S.version || '—';
}

function renderTopStats() {
  const bits = [];
  if (S.tab === 'board') {
    const on = S.board.filter((l) => l.enabled);
    bits.push(`共 <b>${S.board.length}</b> 条线`);
    bits.push(`启用 <b>${on.length ? H(on[0].name) : '无'}</b>`);
    const online = S.board.reduce((s, l) => s + l.onlineCount, 0);
    bits.push(`在线 <b>${online}</b> 台`);
    const prep = S.board.filter((l) => l.phase === 'prepare').length;
    if (prep) bits.push(`<b class="warn-txt">${prep} 条线换型中</b>`);
  } else if (S.tab === 'lines') {
    bits.push(`共 <b>${S.lines.length}</b> 条线体`);
    const on = S.lines.filter((l) => l.enabled);
    bits.push(`启用中 <b>${on.length ? H(on[0].name) : '无'}</b>`);
  } else if (S.tab === 'models') {
    bits.push(`共 <b>${S.models.length}</b> 个机种`);
    const m = S.models.find((x) => x.id === S.modelId);
    if (m) bits.push(`当前 <b>${H(m.code)}</b>`);
  } else if (S.tab === 'terms') {
    const t = S.terms;
    if (t) bits.push(`在线 <b>${t.onlineCount}</b> / ${t.total} 台`);
  } else if (S.tab === 'media') {
    if (S.media) bits.push(`${S.media.stats.count} 个文件 · ${fmtBytes(S.media.stats.bytes)}`);
  }
  $('topStats').innerHTML = bits.join('　·　') || '—';
}

$('refreshBtn').addEventListener('click', async () => {
  try {
    if (S.tab === 'board') await loadBoard();
    else if (S.tab === 'lines') await loadLines();
    else if (S.tab === 'models') await loadModels();
    else if (S.tab === 'media') await loadMedia();
    else if (S.tab === 'terms') await loadTerms();
    toast('已刷新');
  } catch (e) { toast(e.message, 'err'); }
});

// ==================== 线体设置 ====================
async function loadLines() {
  const d = await api('/api/lines');
  S.lines = d.lines || [];
  if (!S.procLineId || !S.lines.some((l) => l.id === S.procLineId)) {
    S.procLineId = (S.lines.find((l) => l.enabled) || S.lines[0] || {}).id || '';
  }
  renderLineTable();
  renderProcLinePick();
  await loadProcesses();
  renderTopStats();
}

function renderLineTable() {
  const tbody = $('lineTable').querySelector('tbody');
  if (!S.lines.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">还没有线体，点右上角「+ 新建线体」。</td></tr>';
    return;
  }
  const sorted = [...S.lines].sort((a, b) => (a.sort - b.sort) || a.code.localeCompare(b.code));

  tbody.innerHTML = sorted.map((l, i) => `
    <tr class="${l.enabled ? 'cur' : ''}" data-lid="${H(l.id)}">
      <td>
        <button class="ln-check${l.enabled ? ' on' : ''}" data-toggle="${H(l.id)}"
          title="${l.enabled ? '取消启用这条线' : '启用这条线'}"
          aria-pressed="${l.enabled ? 'true' : 'false'}">${l.enabled ? '✓' : ''}</button>
      </td>
      <td class="mono">${H(l.code)}</td>
      <td><b>${H(l.name)}</b>${l.id === S.procLineId ? ' <span class="badge info">正在看工序</span>' : ''}</td>
      <td class="num">${l.processes}</td>
      <td class="num">${l.coverage.done} / ${l.coverage.total}</td>
      <td>${l.currentModelCode ? H(l.currentModelCode) : '<span class="badge muted">未设定</span>'}</td>
      <td class="num">${l.online || 0}</td>
      <td>
        <div class="row-actions">
          <button class="btn sm" data-act="proc" data-lid="${H(l.id)}">工序</button>
          <button class="btn sm" data-act="rename" data-lid="${H(l.id)}">改名</button>
          <button class="iconbtn" data-act="up" data-lid="${H(l.id)}" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-act="down" data-lid="${H(l.id)}" title="下移" ${
            i === sorted.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn sm danger" data-act="del" data-lid="${H(l.id)}">删除</button>
        </div>
      </td>
    </tr>`).join('');
}

/** 启用/停用：同一时刻只有一条在跑 */
async function toggleLine(lineId) {
  const target = S.lines.find((l) => l.id === lineId);
  if (!target) return;

  if (!target.enabled) {
    try {
      await putJson('/api/lines/' + encodeURIComponent(lineId), { enabled: true });
      await loadLines();
      toast('已启用 ' + target.name + '，终端会自动切到这条线', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    return;
  }

  // 停用必问一句：enableOnlyLine 保证同一时刻只有一条在跑，
  // 停掉它意味着**没有任何线体在跑**，终端会 404、屏上内容停住。
  const ok = await dialog({
    title: `停用「${target.name}」？`,
    message: '停用后没有任何线体在跑，终端会连不上服务端、屏上的内容会停住不动。' +
      '如果是要换到别的线，请直接勾选那一条。',
    okText: '停用',
    danger: true
  });
  if (!ok) return;
  try {
    await putJson('/api/lines/' + encodeURIComponent(lineId), { enabled: false });
    await loadLines();
    toast('已停用 ' + target.name, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

$('lineTable').addEventListener('click', async (e) => {
  const tgl = e.target.closest('[data-toggle]');
  if (tgl) return toggleLine(tgl.dataset.toggle);

  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.lid;
  const target = S.lines.find((l) => l.id === id);
  if (!target) return;

  if (b.dataset.act === 'proc') {
    S.procLineId = id;
    renderLineTable();
    renderProcLinePick();
    await loadProcesses();
    return;
  }

  if (b.dataset.act === 'rename') {
    const r = await dialog({
      title: '改线体',
      message: '编码是终端装机时要填的标识，一般不改；显示名称可以随时改。',
      fields: [
        { key: 'name', label: '显示名称', value: target.name, placeholder: '例如：二线' },
        { key: 'code', label: '线体编码', value: target.code, placeholder: 'L2' }
      ],
      okText: '保存'
    });
    if (!r) return;
    try {
      await putJson('/api/lines/' + encodeURIComponent(id), {
        name: r.name || target.name, code: r.code || target.code
      });
      await loadLines();
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (b.dataset.act === 'up' || b.dataset.act === 'down') {
    // 交换相邻两条的 sort，不必重排全表
    const sorted = [...S.lines].sort((x, y) => (x.sort - y.sort) || x.code.localeCompare(y.code));
    const i = sorted.findIndex((l) => l.id === id);
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[i], c = sorted[j];
    try {
      await putJson('/api/lines/' + encodeURIComponent(a.id), { sort: c.sort });
      await putJson('/api/lines/' + encodeURIComponent(c.id), { sort: a.sort });
      await loadLines();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (b.dataset.act === 'del') {
    const ok = await dialog({
      title: `删除线体「${target.name}」？`,
      message: '删除后这条线上的工序会一并消失（那几块屏以后没有身份了）。' +
        '机种里的内容和文件不受影响，删的只是"这条物理线有几块屏"。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/lines/' + encodeURIComponent(id), { method: 'DELETE' });
      if (S.procLineId === id) S.procLineId = '';
      await loadLines();
      toast('已删除 ' + target.name, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('lnNewBtn').addEventListener('click', async () => {
  const r = await dialog({
    title: '新建线体',
    message: '线体就是一条物理产线。新建后会自动带 5 道标准工序（OP10…OP50），工序名可以之后改。',
    fields: [
      { key: 'code', label: '线体编码', placeholder: 'L2', tip: '终端装机时要填这个编码，建议与现场标识一致' },
      { key: 'name', label: '显示名称', placeholder: '二线' }
    ],
    okText: '创建'
  });
  if (!r) return;
  if (!r.code) return toast('线体编码不能为空', 'err');
  try {
    const made = await postJson('/api/lines', { code: r.code, name: r.name || r.code });
    S.procLineId = made.id;
    await loadLines();
    toast('已新建线体 ' + made.name + '（还没启用）', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- 工序（这块线体上有几块屏） ----------
function renderProcLinePick() {
  const sel = $('procLinePick');
  sel.innerHTML = S.lines.map((l) =>
    `<option value="${H(l.id)}">${H(l.name)}（${H(l.code)}）</option>`).join('')
    || '<option value="">还没有线体</option>';
  sel.value = S.procLineId || '';
  const cur = S.lines.find((l) => l.id === S.procLineId);
  $('procSub').textContent = cur ? `${cur.name} 上的工序，一块屏一道工序` : '还没有线体';
}

$('procLinePick').addEventListener('change', async () => {
  S.procLineId = $('procLinePick').value;
  renderLineTable();
  await loadProcesses();
});

async function loadProcesses() {
  if (!S.procLineId) { S.processes = []; renderProcTable(); return; }
  const d = await api('/api/processes?lineId=' + encodeURIComponent(S.procLineId));
  S.processes = d.processes || [];
  renderProcTable();
}

function renderProcTable() {
  const tbody = $('procTable').querySelector('tbody');
  if (!S.procLineId) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">先选一条线体。</td></tr>';
    return;
  }
  if (!S.processes.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">这条线还没有工序，点右上角「+ 添加工序」。</td></tr>';
    return;
  }

  tbody.innerHTML = S.processes.map((p) => `
    <tr data-pid="${H(p.id)}">
      <td class="num">${p.sort}</td>
      <td><input class="cell-input mono" data-f="code" value="${H(p.code)}" maxlength="16"></td>
      <td><input class="cell-input" data-f="name" value="${H(p.name)}" maxlength="40"></td>
      <td class="num">${p.modelsWithContent}</td>
      <td>
        <div class="row-actions">
          <button class="btn sm danger" data-act="delproc">删除</button>
        </div>
      </td>
    </tr>`).join('');
}

// 工序码/名称就地改：失焦或回车才提交，避免每敲一个字打一次接口
$('procTable').addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-f]');
  if (!inp) return;
  const tr = inp.closest('[data-pid]');
  const pid = tr.dataset.pid;
  const p = S.processes.find((x) => x.id === pid);
  if (!p) return;
  const v = inp.value.trim();
  if (!v || v === p[inp.dataset.f]) { inp.value = p[inp.dataset.f]; return; }
  try {
    await putJson('/api/processes/' + encodeURIComponent(pid), { [inp.dataset.f]: v });
    await loadProcesses();
    toast('已更新工序', 'ok');
  } catch (err) {
    inp.value = p[inp.dataset.f];
    toast(err.message, 'err');
  }
});

$('procTable').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="delproc"]')) return;
  const tr = e.target.closest('[data-pid]');
  const p = S.processes.find((x) => x.id === tr.dataset.pid);
  if (!p) return;
  const ok = await dialog({
    title: `删除工序 ${p.code}？`,
    message: `删掉后「${p.code}」这块屏就没有身份了，终端会连不上。` +
      '机种里同码的工位和内容不会被删，重新加回来还能用。',
    okText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/processes/' + encodeURIComponent(p.id), { method: 'DELETE' });
    await loadProcesses();
    await loadLines();
    toast('已删除工序 ' + p.code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('procAddBtn').addEventListener('click', async () => {
  if (!S.procLineId) return toast('先选一条线体', 'err');
  const text = await bulkDialog({
    title: '批量添加工序',
    message: '工序 = 这条线上的一块屏。一次可以贴十几二十条，建完各机种会自动长出对应工位。',
    placeholder: 'OP10 压装\nOP20 焊接\nOP30 检测'
  });
  if (!text) return;
  const rows = parseBulk(text);
  if (!rows.length) return toast('没有可用的行', 'err');

  let okN = 0;
  const bad = [];
  for (const r of rows) {
    try {
      await postJson('/api/processes', { lineId: S.procLineId, code: r.code, name: r.name });
      okN += 1;
    } catch (err) { bad.push(`${r.code}：${err.message}`); }
  }
  await loadProcesses();
  await loadLines();
  if (okN) toast(`已添加 ${okN} 道工序`, 'ok');
  if (bad.length) {
    await dialog({
      title: `${bad.length} 道没加上`,
      message: bad.join('\n'),
      okText: '知道了',
      hideCancel: true
    });
  }
});

// ==================== 机种设置 ====================
/** 取机种列表。列表徽标（x/y 道工序已配内容）按「机种设置」当前线体统计，媒体库的下拉不显示徽标。 */
async function loadModels(keepId) {
  if (!S.lines.length) await loadLines().catch(() => {});
  if (!S.mdLineId || !S.lines.some((l) => l.id === S.mdLineId)) {
    const dft = S.lines.find((l) => l.enabled) || S.lines[0];
    S.mdLineId = dft ? dft.id : '';
  }
  const d = await api('/api/models' + (S.mdLineId ? '?lineId=' + encodeURIComponent(S.mdLineId) : ''));
  S.models = d.models || [];
  const want = keepId || S.mdModelId;
  S.mdModelId = (want && S.models.some((m) => m.id === want))
    ? want : ((S.models[0] && S.models[0].id) || '');
  renderMdList();
  renderMlModelPick();
  await loadMdStations();
  renderTopStats();
}

function renderMdList() {
  const kw = ($('mdSearch').value || '').trim().toLowerCase();
  const list = S.models.filter((m) =>
    !kw || m.code.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw));

  $('mdList').innerHTML = list.map((m) => {
    const done = m.stDone || 0;
    const total = m.stTotal || 0;
    const full = total > 0 && done === total;
    return `<button class="md-item ${m.id === S.mdModelId ? 'on' : ''}${m.enabled ? '' : ' off'}"
        data-mid="${H(m.id)}">
      <span class="md-code">${H(m.code)}</span>
      <span class="md-dot ${full ? 'full' : (done ? 'part' : '')}"
            title="${done}/${total} 道工序已配内容">${done}/${total}</span>
    </button>`;
  }).join('') || '<div class="sub" style="padding:10px">没有匹配的机种</div>';
}

$('mdSearch').addEventListener('input', () => {
  clearTimeout(renderMdList._t);
  renderMdList._t = setTimeout(renderMdList, 150);
});

$('mdList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mid]');
  if (!b) return;
  S.mdModelId = b.dataset.mid;
  renderMdList();
  await loadMdStations();
});

/* ================= 机种设置：工序清单（定义层） ================= */

/** 取这个机种在这条线上的工序清单。只读内容数，不碰内容本身。 */
async function loadMdStations() {
  renderLinePick('mdLines', S.mdLineId);

  const m = S.models.find((x) => x.id === S.mdModelId);
  const line = S.lines.find((x) => x.id === S.mdLineId);

  if (!m || !line) {
    S.mdStations = [];
    $('mdTitle').textContent = m ? modelLabel(m) : '机种设置';
    $('mdSub').textContent = m ? '还没有线体，先去「线体设置」建一条' : '左边选一个机种';
    $('mdSummary').innerHTML = '';
    renderStTable();
    return;
  }

  try {
    const d = await api('/api/stations?modelId=' + encodeURIComponent(m.id)
      + '&lineId=' + encodeURIComponent(line.id));
    S.mdStations = d.stations || [];
  } catch (e) {
    S.mdStations = [];
    toast(e.message, 'err');
  }

  $('mdTitle').textContent = modelLabel(m);
  $('mdSub').innerHTML = `· <b>${H(line.name)}</b> ${line.processes} 道工序`
    + (m.enabled ? '' : '　（机种已停用，不会出现在换型下拉里）');
  renderMdSummary();
  renderStTable();
}

/**
 * 线体胶囊条，两页各一份，选中态各自独立：
 * 在媒体库切到二线传文件，机种设置那边还停在一线，互不干扰。
 * 只有一条线时整条隐藏 —— 现场一开始就一条线，不让人多点一次。
 */
function renderLinePick(boxId, activeId) {
  const box = $(boxId);
  if (!box) return;
  if (S.lines.length <= 1) { box.classList.add('hide'); return; }
  box.classList.remove('hide');
  box.innerHTML = '<span class="lp-lbl">线体</span>' + S.lines.map((l) => `
    <button class="lp${l.id === activeId ? ' on' : ''}" data-mline="${H(l.id)}"
            title="${l.enabled ? '正在启用' : '未启用'}">
      <span class="lp-dot${l.enabled ? ' live' : ''}"></span>${H(l.name)}
      <small>${l.processes} 道</small>
    </button>`).join('');
}

$('mdLines').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mline]');
  if (!b || b.dataset.mline === S.mdLineId) return;
  S.mdLineId = b.dataset.mline;
  // 徽标是按线统计的，切线体要连机种列表一起重取
  await loadModels();
});

/* ================= 媒体库：按工序配内容（内容层） ================= */

/** 媒体库：机种 → 线体 → 工位（左索引）+ 当前工位的内容（右编辑区） */
async function loadStations() {
  if (!S.models.length) await loadModels().catch(() => {});
  if (!S.stLineId || !S.lines.some((l) => l.id === S.stLineId)) {
    const dft = S.lines.find((l) => l.enabled) || S.lines[0];
    S.stLineId = dft ? dft.id : '';
  }
  if (!S.modelId || !S.models.some((m) => m.id === S.modelId)) {
    S.modelId = S.mdModelId || (S.models[0] && S.models[0].id) || '';
  }
  renderLinePick('mlLines', S.stLineId);
  renderMlModelPick();

  const m = S.models.find((x) => x.id === S.modelId);
  const line = S.lines.find((x) => x.id === S.stLineId);

  if (!m || !line) {
    S.stations = [];
    S.stPickId = '';
    $('mediaSub').textContent = m
      ? '还没有线体，先去「线体设置」建一条'
      : '还没有机种，先去「机种设置」新建一个';
    $('stNav').innerHTML = '';
    $('stations').innerHTML = '<div class="empty">先选机种和线体。</div>';
    renderStIndex();
    return;
  }

  try {
    const d = await api('/api/stations?modelId=' + encodeURIComponent(m.id)
      + '&lineId=' + encodeURIComponent(line.id));
    S.stations = d.stations || [];
  } catch (e) {
    S.stations = [];
    toast(e.message, 'err');
  }

  const filled = S.stations.filter((x) => x.items.length > 0).length;
  $('mediaSub').textContent = `${line.name} · ${S.stations.length} 个工位`
    + (S.stations.length ? ` · 已配 ${filled}` : '');

  renderStations();
}

/** 媒体库顶部的机种下拉。用下拉而不是列表：这一页的重点是工位，机种只是入口 */
function renderMlModelPick() {
  const sel = $('mlModelPick');
  if (!sel) return;
  sel.innerHTML = S.models.map((m) =>
    `<option value="${H(m.id)}"${m.id === S.modelId ? ' selected' : ''}>${H(modelLabel(m))}</option>`
  ).join('') || '<option value="">还没有机种</option>';
}

$('mlModelPick').addEventListener('change', async (e) => {
  S.modelId = e.target.value;
  S.stPickId = '';   // 换机种，上一台的工位 id 全部作废，交给 ensurePick 重挑
  await loadStations();
});

$('mlLines').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mline]');
  if (!b || b.dataset.mline === S.stLineId) return;
  S.stLineId = b.dataset.mline;
  S.stPickId = '';   // 换线体等于换一整套工位
  await loadStations();
});

/** 机种设置顶部的汇总：主语是"工序"，内容数只作参考 —— 真正配内容去媒体库 */
function renderMdSummary() {
  const total = S.mdStations.length;
  const filled = S.mdStations.filter((x) => x.items.length > 0).length;
  const items = S.mdStations.reduce((s, x) => s + x.items.length, 0);
  const bytes = S.mdStations.reduce((s, x) => s + x.items.reduce((a, i) => a + (i.bytes || 0), 0), 0);

  $('mdSummary').innerHTML = `
    <div class="ms">
      <div class="ms-item"><b>${total}</b><span>道工序</span></div>
      <div class="ms-item"><b>${filled}</b><span>已配内容</span></div>
      <div class="ms-item"><b>${total - filled}</b><span>待配内容</span></div>
      <div class="ms-item"><b>${items}</b><span>个文件</span></div>
      <div class="ms-item"><b>${bytes ? fmtBytes(bytes) : '—'}</b><span>合计体积</span></div>
    </div>`;
}

/**
 * 工序清单表格。
 * 25 道工序用表格而不是卡片：一行 34px，表头固定、表内滚动，
 * 页面高度不随工序数增长；「内容」列直接点进媒体库对应的工位。
 */
function renderStTable() {
  const tb = $('stTbody');
  if (!tb) return;

  const total = S.mdStations.length;
  const filled = S.mdStations.filter((x) => x.items.length > 0).length;
  $('stTableSub').innerHTML = total
    ? `${total} 道工序 · 已配 <b>${filled}</b> 道`
    : '—';

  if (!total) {
    tb.innerHTML = `<tr><td colspan="5" class="st-empty">
      这个机种在这条线上还没有工序。点右上「按本线工序补齐」按线体工序建一套，
      或「+ 批量加工序」一次贴多行。</td></tr>`;
    return;
  }

  const q = (S.mdQuery || '').trim().toLowerCase();
  const shown = S.mdStations.filter((st) =>
    !q || (st.code || '').toLowerCase().includes(q) || (st.name || '').toLowerCase().includes(q));

  if (!shown.length) {
    tb.innerHTML = '<tr><td colspan="5" class="st-empty">没有匹配的工序</td></tr>';
    return;
  }

  tb.innerHTML = shown.map((st) => {
    const n = st.items.length;
    return `<tr data-row="${H(st.id)}">
      <td><span class="cell-code" title="工序码由「线体设置」里的工序决定，这里不改">${H(st.code)}</span></td>
      <td><input class="cell-in" data-f="name" maxlength="40"
                 value="${H(st.name)}" placeholder="工序名称"></td>
      <td><input class="cell-in" data-f="note" maxlength="200"
                 value="${H(st.note || '')}" placeholder="这道工序做什么…"></td>
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
  const v = inp.value.trim();
  if ((st[f] || '') === v) return;

  inp.classList.add('saving');
  try {
    const out = await putJson('/api/stations/' + encodeURIComponent(st.id), { [f]: v });
    Object.assign(st, out);
    inp.classList.remove('saving');
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 1200);
    renderMdList();          // 徽标跟着变
    renderMdSummary();
    renderStTable();
  } catch (err) {
    inp.value = st[f] || '';
    inp.classList.remove('saving');
    toast(err.message, 'err');
  }
});

$('stTbody').addEventListener('click', async (e) => {
  // 点「内容」列 → 切到媒体库并直接把那个工位选中
  const jump = e.target.closest('[data-jump]');
  if (jump) { await openInMedia(jump.dataset.jump); return; }

  const del = e.target.closest('[data-del]');
  if (!del) return;
  const st = S.mdStations.find((x) => x.id === del.dataset.del);
  if (!st) return;
  if (st.items.length && !await ask('删除工序',
    `「${st.code} ${st.name}」里还有 ${st.items.length} 项内容，删掉工序会一起删掉，确定吗？`,
    '删除', true)) return;
  try {
    await api('/api/stations/' + encodeURIComponent(st.id), { method: 'DELETE' });
    await loadMdStations();
    toast('已删除工序 ' + st.code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/** 从机种设置跳到媒体库，落点就是刚点的那道工序 */
async function openInMedia(stationId) {
  S.tab = 'media';
  S.modelId = S.mdModelId;
  S.stLineId = S.mdLineId;
  S.stPickId = stationId;
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

/** 选中的工位要一直有效：切机种 / 切线体 / 删工位之后，老 id 就指不到了 */
function ensurePick() {
  if (!S.stations.length) { S.stPickId = ''; return; }
  if (S.stations.some((x) => x.id === S.stPickId)) return;
  // 优先落在"第一个还没配内容的"——十几二十道工序里，最想知道的就是下一个该配哪个
  const next = S.stations.find((x) => !x.items.length);
  S.stPickId = (next || S.stations[0]).id;
}

/** 工位索引：一屏看完这条线上有哪些屏、哪些配好了、哪些还空着 */
function renderStIndex() {
  const list = $('stList');
  if (!list) return;

  const total = S.stations.length;
  const filled = S.stations.filter((x) => x.items.length > 0).length;
  $('stCount').innerHTML = total ? `<b>${filled}</b>/${total}` : '0';
  $('stBar').style.width = total ? `${Math.round((filled / total) * 100)}%` : '0';

  if (!total) {
    list.innerHTML = '<div class="si-empty">还没有工位</div>';
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
    list.innerHTML = '<div class="si-empty">没有符合条件的工位</div>';
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

/** 右侧编辑区：只渲染当前这一个工位，高度不随工序数增长 */
function renderStEdit() {
  const box = $('stations');
  if (!S.stations.length) {
    $('stNav').innerHTML = '';
    const line = S.lines.find((x) => x.id === S.stLineId);
    box.innerHTML = `<div class="empty">「这个机种」在「${H(line ? line.name : '这条线')}」上还没有工位。`
      + '点「按本线工序补齐」按工序建一套，或左下「+ 添加工位」单个加。</div>';
    return;
  }
  renderStNav();
  box.innerHTML = stationHtml(pickedStation());
}

/** 编辑区顶部那条：只报"现在这个工位什么状态"，工序码与名称下面的卡里已经有，不重复 */
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
    : (noReq ? '<span class="se-warn">还没勾「允许」类型，这个工位不限制文件类型</span>' : '还没有内容');

  nav.innerHTML = `<span class="se-stat">${stat}</span>
    <div class="spacer"></div>
    <span class="se-pos">第 ${i + 1} / ${S.stations.length} 个</span>
    <button class="btn sm" data-snav="-1"${prev ? '' : ' disabled'}>‹ 上一个</button>
    <button class="btn sm" data-snav="1"${next ? '' : ' disabled'}>下一个 ›</button>`;
}

function pickedStation() {
  return S.stations.find((x) => x.id === S.stPickId) || S.stations[0];
}

// ---- 工位索引交互 ----
$('stList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-spick]');
  if (!b || b.dataset.spick === S.stPickId) return;
  S.stPickId = b.dataset.spick;
  renderStations();
  // 切到另一个工位后把编辑区滚回顶部，否则会停在上一张卡的滚动位置
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
          <div class="sm">${KIND_CN[it.kind] || it.kind} · ${fmtBytes(it.bytes)}${
            it.kind === 'image' && it.width ? ` · ${it.width}×${it.height}` : ''}</div>
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
      <button class="btn sm" data-sid="${H(st.id)}" data-stdel>删除工位</button>
    </div>

    <div class="st-reqs">
      <span class="st-lbl">允许</span>
      ${reqCells}
      <span class="st-lbl">单文件 ≤</span>
      <input class="knum" type="number" min="0" max="9999" data-sid="${H(st.id)}" data-f="maxMb"
             value="${st.maxMb || 0}" title="0 = 不限"> MB
    </div>

    <div class="st-drop" data-sid="${H(st.id)}">
      拖入文件，或 <button class="btn sm" data-sid="${H(st.id)}" data-pick>选择文件</button>
      <span class="dim">　PDF 自动按页拆成图片；类型以「允许」里勾的为准</span>
    </div>

    <div class="st-items">${items}</div>
  </div>`;
}

/** 只在某张工位卡片内部重绘，避免整页重绘丢焦点 */
function renderOneStation(sid) {
  const el = $('stations').querySelector(`[data-st="${sid}"]`);
  const st = S.stations.find((x) => x.id === sid);
  if (!el || !st) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = stationHtml(st);
  el.replaceWith(tmp.firstElementChild);
}

/** 把某工位的当前内存状态整体提交（内容/要求都走这一个接口） */
async function saveStation(sid, payload) {
  const st = S.stations.find((x) => x.id === sid);
  if (!st) return null;
  const body = { ...payload };
  if (Array.isArray(body.items)) {
    body.items = body.items.map((it) => ({
      mediaId: it.mediaId, dwellSec: it.dwellSec, fit: it.fit, zoom: it.zoom
    }));
  }
  const out = await putJson('/api/stations/' + encodeURIComponent(sid), body);
  const i = S.stations.findIndex((x) => x.id === sid);
  if (i >= 0) S.stations[i] = out;
  // 索引上的项数与体积、顶部那行状态都跟着改，否则要刷新整页才对
  refreshMediaSub();
  renderStIndex();
  renderStNav();
  return out;
}

/** 媒体库副标题：机种内容一改，已配数就变了 */
function refreshMediaSub() {
  const line = S.lines.find((x) => x.id === S.stLineId);
  const el = $('mediaSub');
  if (!el || !line) return;
  const filled = S.stations.filter((x) => x.items.length > 0).length;
  el.textContent = `${line.name} · ${S.stations.length} 个工位`
    + (S.stations.length ? ` · 已配 ${filled}` : '');
}

// ---- 工位交互 ----
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
      title: `删除工位 ${st.code}？`,
      message: '只删这个机种下面这块屏的配置。线体上的工序不动，别处的文件也不动。' +
        (st.items.length ? `\n\n注意：这个工位还有 ${st.items.length} 项内容，删了要重传。` : ''),
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/stations/' + encodeURIComponent(sid), { method: 'DELETE' });
      await loadStations();
      toast('已删除工位 ' + st.code, 'ok');
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

// 拖拽上传到工位
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

// 导出 / 模板：都走这条。用 fetch 拿 blob 而不是直接把地址丢给浏览器，
// 是因为服务端拒绝时（比如"还没有配过工序"）返回的是 JSON，
// 直接跳转会在新标签页里显示一段 JSON 报错，现场看不懂。
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

  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`已下载 ${name}`, 'ok');
}

// 导出全部机种：每个「机种 × 线体」一个工作表，三列跟导入一致
$('stExportBtn').addEventListener('click', async () => {
  try { await downloadFile('/api/export/stations.xlsx', '工序清单.xlsx'); }
  catch (err) { toast(err.message, 'err'); }
});

// 导入模板：标题行 + 一行示例，说明放在第二页
$('stTplBtn').addEventListener('click', async () => {
  try { await downloadFile('/api/export/template.xlsx', '工序清单导入模板.xlsx'); }
  catch (err) { toast(err.message, 'err'); }
});

// 从 Excel / CSV 导入工序清单：先让服务端解析成行给个预览，确认了才写库。
// 不直接导入是因为工艺表格式五花八门，列一错位就得一条条删回来。
$('stImportBtn').addEventListener('click', () => {
  if (!S.mdModelId) return toast('先选一个机种', 'err');
  if (!S.mdLineId) return toast('先选一条线体', 'err');

  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.csv,.txt';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;

    let d;
    try {
      d = await api('/api/import/parse?filename=' + encodeURIComponent(f.name), {
        method: 'POST',
        body: await f.arrayBuffer()
      });
    } catch (err) { return toast(err.message, 'err'); }

    const pad = (r) => [0, 1, 2].map((i) => (r[i] === undefined ? '' : String(r[i]))).join('  |  ');
    const more = d.total > d.preview.length ? `\n…… 还有 ${d.total - d.preview.length} 行` : '';

    const r = await dialog({
      title: `导入 ${d.total} 道工序`,
      message: (d.header ? `已跳过标题行：${d.header.join(' / ')}\n\n` : '')
        + `按「工序码 | 名称 | 做什么」三列读，预览：\n\n${d.preview.map(pad).join('\n')}${more}`
        + '\n\n读出来的内容不对？多半是列的顺序不同，把表调成「工序码、名称、做什么」再导一次。',
      html: `<div class="dlg-row">
        <label for="impMode">已有同名工序</label>
        <select id="impMode" class="dlg-sel">
          <option value="merge">跳过，保留原有名称与说明</option>
          <option value="update">覆盖名称与「做什么」，已配内容不动</option>
        </select>
      </div>`,
      read: (body) => ({ mode: body.querySelector('#impMode').value }),
      okText: '导入'
    });
    if (!r) return;

    try {
      const out = await postJson('/api/stations/import', {
        modelId: S.mdModelId, lineId: S.mdLineId, rows: d.rows, mode: r.mode
      });
      await loadMdStations();

      const bits = [`新增 ${out.created} 道`];
      if (out.updated) bits.push(`更新 ${out.updated} 道`);
      if (out.skipped) bits.push(`跳过 ${out.skipped} 道（已存在）`);
      toast('导入完成：' + bits.join('，'), 'ok');

      if (out.bad && out.bad.length) {
        await dialog({
          title: `${out.bad.length} 行没能导入`,
          message: out.bad.join('\n'),
          okText: '知道了',
          hideCancel: true
        });
      }
    } catch (err) { toast(err.message, 'err'); }
  };
  inp.click();
});

// 机种设置页：批量加工序（给这个机种在这条线上补工序定义）
$('stAddBtn').addEventListener('click', async () => {
  if (!S.mdModelId) return toast('先选一个机种', 'err');
  if (!S.mdLineId) return toast('先选一条线体', 'err');
  const text = await bulkDialog({
    title: '批量加工序',
    message: '一行一条。工序码要和这条线「线体设置」里的工序码一致，那块屏才拉得到内容。',
    placeholder: 'OP10 压装\nOP20 焊接'
  });
  if (!text) return;
  const rows = parseBulk(text);
  if (!rows.length) return toast('没有可用的行', 'err');

  let okN = 0;
  const bad = [];
  for (const r of rows) {
    try {
      await postJson('/api/stations', {
        modelId: S.mdModelId, lineId: S.mdLineId, code: r.code, name: r.name
      });
      okN += 1;
    } catch (err) { bad.push(`${r.code}：${err.message}`); }
  }
  await loadMdStations();
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

// 机种操作
$('mdNewBtn').addEventListener('click', async () => {
  const r = await dialog({
    title: '新建机种',
    message: '新建后会自动按每条线体现有的工序补出工位（一条线二十道工序就补二十个），进「机种设置」直接配内容即可。',
    fields: [
      { key: 'code', label: '机种编码', placeholder: 'X300', tip: '换型时按这个编码下发，建议与工艺文件一致' },
      { key: 'name', label: '显示名称', placeholder: '留空则用「X300 型」' }
    ],
    okText: '创建'
  });
  if (!r) return;
  if (!r.code) return toast('机种编码不能为空', 'err');
  try {
    const made = await postJson('/api/models', { code: r.code, name: r.name || r.code + ' 型' });
    await loadModels(made.id);
    toast('已新建机种 ' + r.code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('mdRenameBtn').addEventListener('click', async () => {
  const m = S.models.find((x) => x.id === S.mdModelId);
  if (!m) return;
  const r = await dialog({
    title: '改机种',
    fields: [
      { key: 'code', label: '机种编码', value: m.code },
      { key: 'name', label: '显示名称', value: m.name }
    ],
    okText: '保存'
  });
  if (!r) return;
  try {
    await putJson('/api/models/' + encodeURIComponent(m.id), { code: r.code, name: r.name });
    await loadModels(m.id);
    toast('已保存', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('mdDelBtn').addEventListener('click', async () => {
  const m = S.models.find((x) => x.id === S.mdModelId);
  if (!m) return;
  const ok = await dialog({
    title: `删除机种「${modelLabel(m)}」？`,
    message: '这个机种的所有工位和内容会一起删掉（文件还在媒体库里，可以重新引用）。\n\n' +
      '如果只是暂时不做，改成停用更好 —— 停用后不会出现在换型下拉里，内容都留着。',
    okText: '仍然删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/models/' + encodeURIComponent(m.id), { method: 'DELETE' });
    S.mdModelId = '';
    await loadModels();
    toast('已删除机种 ' + m.code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// 同步工序到线体：机种配了 5 个工位，线体只有 3 道工序时一键补齐
// 按本线的工序补齐这个机种的工位（线体新加了工序，这里一键跟上）
$('mdSyncBtn').addEventListener('click', async () => {
  const m = S.models.find((x) => x.id === S.mdModelId);
  const line = S.lines.find((x) => x.id === S.mdLineId);
  if (!m) return toast('先选一个机种', 'err');
  if (!line) return toast('先选一条线体', 'err');

  try {
    const out = await postJson('/api/stations/sync', { modelId: m.id, lineId: line.id });
    if (out.created.length) {
      toast(`「${line.name}」补上 ${out.created.length} 道工序：${out.created.join('、')}`, 'ok');
    } else {
      toast(`已经对上了，本线 ${out.total} 道工序不用补`, 'ok');
    }
    await loadLines().catch(() => {});
    await loadMdStations();
  } catch (err) { toast(err.message, 'err'); }
});

// 从另一条线整套复制过来（两条线工艺大同小异时最省事）
$('mdCopyBtn').addEventListener('click', async () => {
  const m = S.models.find((x) => x.id === S.modelId);
  const to = S.lines.find((x) => x.id === S.stLineId);
  if (!m) return toast('先选一个机种', 'err');
  if (!to) return toast('先选一条线体', 'err');

  const others = S.lines.filter((l) => l.id !== to.id);
  if (!others.length) return toast('只有一条线体，没有可复制的来源', 'err');

  const html = '<div class="linepick">' + others.map((l) => `
    <label class="linepick-row">
      <input type="radio" name="copyfrom" value="${H(l.id)}">
      <span class="lp-name">${H(l.name)}<small>${H(l.code)}</small></span>
      <span class="lp-meta">${l.processes} 道工序</span>
    </label>`).join('') + '</div>';

  const r = await dialog({
    title: `从其它线复制到「${to.name}」`,
    message: `把「${m.code}」在所选线体上的整套工位（允许类型 + 文件 + 顺序）复制到「${to.name}」。`
      + '复制出来是完全独立的一份，之后改这边不影响那边；本线已有内容的工位会跳过，'
      + '空着的工位直接填上。',
    html,
    read: (body) => {
      const pick = body.querySelector('input[name=copyfrom]:checked');
      return { fromLineId: pick ? pick.value : '' };
    },
    okText: '复制'
  });
  if (!r || !r.fromLineId) return;

  try {
    const out = await postJson('/api/stations/copy', {
      modelId: m.id, fromLineId: r.fromLineId, toLineId: to.id
    });
    let h = `<p>从「${H(out.fromName)}」复制到「${H(out.toName)}」完成。</p>`;
    if (out.filled.length) h += `<p style="color:var(--ok)">填入：${out.filled.map(H).join('、')}</p>`;
    if (out.created.length) h += `<p style="color:var(--ok)">新建：${out.created.map(H).join('、')}</p>`;
    if (out.skipped.length) {
      h += `<p style="color:var(--ink3)">跳过（本线已有内容，未覆盖）：${out.skipped.map(H).join('、')}</p>`;
    }
    if (out.empty && out.empty.length) {
      h += `<p style="color:var(--ink3)">来源线本来就没内容：${out.empty.map(H).join('、')}</p>`;
    }
    if (!out.filled.length && !out.created.length && !out.replaced.length) {
      h += '<p style="color:var(--ink3)">没有搬任何内容 —— 来源线在这些工位上也是空的，或者本线已经全有了。</p>';
    }
    await dialog({ title: '复制完成', html: h, okText: '知道了', hideCancel: true });
    await loadStations();
  } catch (err) { toast(err.message, 'err'); }
});

// ==================== 上传 ====================
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media/upload?filename=' + encodeURIComponent(file.name));
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
 * 上传落库 → 直接把文件追加到这个工位的内容里。
 * 为什么不先进媒体库再引用：现场的动作是"这道工序要这几张图"，
 * 让他先传完再挑一遍是多余的两步。
 */
async function handleFiles(files) {
  const sid = S.uploadStation;
  const st = S.stations.find((x) => x.id === sid);
  if (!st) return toast('先选一个工位', 'err');
  const list = [...files];
  if (!list.length) return;

  const allowed = (st.reqs || []).map((r) => r.kind);
  const items = [...st.items];
  let added = 0;

  for (const f of list) {
    const row = uplRow(f.name);
    try {
      const d = await uploadFile(f, (v) => row.set(v, v >= 1 ? '处理中' : Math.round(v * 100) + '%'));

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
        toast(`这个工位不允许放${KIND_CN[d.kind] || d.kind}：${f.name}。\n需要的话先在工位上勾选该类型。`, 'err');
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
async function loadMedia() {
  const kw = ($('mediaSearch').value || '').trim();
  const kind = $('mediaKind').value;
  const qs = new URLSearchParams();
  if (kw) qs.set('q', kw);
  if (kind) qs.set('kind', kind);
  try {
    const d = await api('/api/media?' + qs.toString());
    S.media = d;
    $('mediaTxt').textContent = `${d.stats.count} 个文件 · ${fmtBytes(d.stats.bytes)}`;
    $('mediagrid').innerHTML = d.media.map((m) => `
      <div class="mediacard">
        <div class="thumb">${m.kind === 'image'
          ? `<img src="${H(m.url)}" loading="lazy" alt="">`
          : (m.kind === 'video' ? '视频' : 'PDF 页')}</div>
        <div class="meta">
          <div class="t" title="${H(m.name)}">${H(m.name)}</div>
          <div class="s">${fmtBytes(m.bytes)}${m.width ? ` · ${m.width}×${m.height}` : ''} · 被引用 <b>${m.used}</b> 次</div>
        </div>
      </div>
    `).join('') || '<div class="empty" style="grid-column:1/-1">媒体库是空的。点右上角「上传文件」，或在工位里直接拖进去。</div>';
    renderTopStats();
  } catch (err) {
    $('mediagrid').innerHTML = `<div class="empty" style="grid-column:1/-1">${H(err.message)}</div>`;
  }
}

$('mediaSearch').addEventListener('input', () => {
  clearTimeout(loadMedia._t);
  loadMedia._t = setTimeout(loadMedia, 250);
});
$('mediaKind').addEventListener('change', loadMedia);

$('uploadBtn').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = 'image/*,video/*,application/pdf,.pdf';
  inp.onchange = async () => {
    for (const f of inp.files) {
      try {
        const d = await uploadFile(f);
        toast(`已上传 ${d.kind === 'pdf' ? f.name + '（拆成 ' + d.pageCount + ' 页）' : d.name}${d.duplicated ? '（已存在）' : ''}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
    loadMedia();
  };
  inp.click();
});

$('gcBtn').addEventListener('click', async () => {
  try {
    const dry = await postJson('/api/media/gc', { dryRun: true });
    if (!dry.total) return toast('没有未引用的文件，不用清理', 'ok');
    const names = dry.list.slice(0, 8).map((x) => x.name).join('、');
    const ok = await ask(
      '清理未引用文件',
      `有 ${dry.total} 个文件没有被任何工位引用，共 ${fmtBytes(dry.bytes)}：\n` +
      `${names}${dry.total > 8 ? ' …' : ''}\n\n删除后不可恢复，确定删除？`,
      '删除',
      true
    );
    if (!ok) return;
    const r = await postJson('/api/media/gc', { dryRun: false });
    toast(`已删除 ${r.total} 个文件，释放 ${fmtBytes(r.bytes)}`, 'ok');
    loadMedia();
  } catch (err) { toast(err.message, 'err'); }
});

$('adviceBtn').addEventListener('click', async () => {
  try {
    const d = await api('/api/media/advice');
    const parts = [];
    if (d.ratioWarnings.length) parts.push(`${d.ratioWarnings.length} 张图不是 5:4（19 寸屏上会留黑边）`);
    if (d.sizeWarnings.length) parts.push(`${d.sizeWarnings.length} 张图超过 400KB`);
    if (!parts.length) return toast('规格都很合适', 'ok');
    toast(parts.join('；') + '，详见控制台');
    console.table([...d.ratioWarnings, ...d.sizeWarnings]);
  } catch (err) { toast(err.message, 'err'); }
});

// ==================== 终端监控 ====================
async function loadTerms() {
  if (!S.termLineId || !S.lines.some((l) => l.id === S.termLineId)) {
    S.termLineId = (S.lines.find((l) => l.enabled) || S.lines[0] || {}).id || '';
  }
  const sel = $('termLinePick');
  sel.innerHTML = S.lines.map((l) =>
    `<option value="${H(l.id)}">${H(l.name)}（${H(l.code)}）</option>`).join('')
    || '<option value="">还没有线体</option>';
  sel.value = S.termLineId || '';

  if (!S.termLineId) { S.terms = null; renderTermTable(); return; }
  try {
    S.terms = await api('/api/terminals?lineId=' + encodeURIComponent(S.termLineId));
  } catch {
    S.terms = null;
  }
  renderTermTable();
  renderTopStats();
}

$('termLinePick').addEventListener('change', () => {
  S.termLineId = $('termLinePick').value;
  loadTerms().catch(() => {});
});

function ageShort(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + ' 秒';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' 分钟';
  return Math.round(min / 60) + ' 小时';
}

function renderTermTable() {
  const tbody = $('termTable').querySelector('tbody');
  const t = S.terms;
  if (!t || !t.terminals.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">还没有线体，先在「线体设置」建一条。</td></tr>';
    $('termSub').textContent = '—';
    return;
  }

  $('termSub').textContent = `${t.lineName} · 在线 ${t.onlineCount} / ${t.total} 台 · 每 2 秒自动刷新`;

  tbody.innerHTML = t.terminals.map((r) => {
    const pct = r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : (r.ready ? 100 : 0);

    let stateBadge;
    if (!r.seen) stateBadge = '<span class="badge muted">从未上线</span>';
    else if (r.online) {
      stateBadge = r.ready
        ? '<span class="badge ok">在线 · 已就绪</span>'
        : '<span class="badge warn">在线 · 下载中</span>';
    } else {
      stateBadge = `<span class="badge danger">已离线 ${H(ageShort(r.ageMs))}</span>`;
    }

    const resText = r.res ? H(r.res.replace('x', '×')) : '—';
    const freeText = r.free ? fmtBytes(r.free) : '—';
    const progText = r.total > 0
      ? `${r.modelCode ? H(r.modelCode) + ' ' : ''}${r.done}/${r.total} 项`
      : (r.ready ? '内容已就绪' : (r.modelCode ? H(r.modelCode) + ' 等待下载' : '空闲'));

    return `<tr>
      <td><b>${H(r.op)}</b></td>
      <td>${H(r.name)}</td>
      <td class="mono">${H(r.ip || '—')}</td>
      <td class="num">${resText}</td>
      <td class="num">v${H(r.ver || '—')}</td>
      <td class="num">${freeText}</td>
      <td>
        <div class="progbar">
          <span class="track"><i class="${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></i></span>
          <em>${pct}%　${progText}</em>
        </div>
      </td>
      <td>${stateBadge}</td>
    </tr>`;
  }).join('');
}

$('termRefresh').addEventListener('click', () => loadTerms().catch(() => {}));

// 终端监控页 2 秒刷新；不在这一页就不占带宽
setInterval(() => {
  if (S.tab !== 'terms' || document.hidden || !S.termLineId) return;
  api('/api/terminals?lineId=' + encodeURIComponent(S.termLineId))
    .then((d) => { S.terms = d; renderTermTable(); })
    .catch(() => {});
}, 2000);

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
    const st = await api('/api/status').catch(() => null);
    if (st && st.version) { S.version = st.version; renderSideFoot(); }
  } catch (err) {
    toast('连接服务端失败：' + err.message, 'err');
  }
})();

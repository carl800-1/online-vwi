// 管理端逻辑：总览 + 线体/机种设置 + 媒体库 + 终端监控
// 无框架、无构建，浏览器直接跑。所有状态都在内存，一次刷新从服务端重建。
//
// 页面分工（v3.2.0）：定义和内容彻底分开，一页只干一件事。
//   作业内容 = 总览，只读 + 换型。现场天天看的就是这一页。
//   线体设置 = 这条线上有几块屏（工序），以及今天哪条线在跑。
//   机种设置 = **定义层**：这个机种在某条线上有哪些工序、各做什么。
//              表格里只有工序码 / 名称 / 做什么，不含任何文件。
//   媒体库   = **内容层**：先选机种、再选工序、再上传图片 / PDF / 视频。
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

  // 生产概况：空字符串 = 今天，翻页时改成 YYYY-MM-DD
  prod: null,
  prodDay: '',

  // 生产输入（机种设置页）：按产线一行一条线。同样支持翻日期，为的是补昨天的记录
  pi: null,
  piDay: '',

  models: [],
  nextCode: '',   // 新建机种弹窗里「机种编号」的预填值（服务端扫空号给 M1、M2…）

  // 机种设置（定义层）：只看"有哪些工序、各做什么"，不碰内容
  mdModelId: '',
  mdStations: [],
  mdQuery: '',
  mdLines: [],          // 这个机种能在哪几条线上做
  bindsByCode: {},      // 工序码 → [{lineCode, ip, state, ...}]，工序表「屏」那一列用
  bindCode: '',         // 正在给哪道工序分配屏
  bindClients: null,    // 分配弹窗里用的客户端清单（/api/clients 原样）

  // 媒体库（内容层）：选机种 → 选工序 → 传文件
  modelId: '',
  stations: [],
  // 一个机种普遍有 15–25 道工序，全摊成一列会变成几千像素的长条，
  // 所以改成「左边工序索引、右边只编一个」：索引永远一屏看得完，编辑区高度固定。
  stPickId: '',      // 正在编辑哪道工序
  stFilter: 'all',   // all | has | empty
  stQuery: '',       // 工序索引里的搜索词

  processes: [],

  terms: null,
  termLineId: '',
  termMode: 'op',    // op = 按工序看（这道工序的屏在不在）；client = 按客户端看（哪些机器连上来了）
  clients: null,

  media: null,
  libAll: null,

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
  lines: '线体设置',
  models: '机种设置',
  prod: '生产输入',
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
    if (v === 'board') { loadBoard().catch(() => {}); loadProd().catch(() => {}); }
    if (v === 'lines') { loadLines().catch(() => {}); }
    if (v === 'models') { loadModels().catch(() => {}); }   // 定义层：工序清单
    if (v === 'prod') { loadProdInput(true).catch(() => {}); }  // 生产台账：按线记的当日产量
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
  S.overview = d.overview || null;
  renderBsum();
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

  // 这个机种在这道工序上压根没内容 —— 换型必然卡在这里，必须提前看见
  const warn = noContent ? '<i class="cl-warn" title="当前机种在这道工序没有内容"></i>' : '';

  return `<span class="cl ${cls}" title="${H(c.name)} ${H(c.ip || '')}">${warn}<b>${H(c.op)}</b>${H(c.name)} · ${H(text)}</span>`;
}

/* ================= 作业内容（总览）：三段 ================= */

/** 第 1 段：产线概览。只数线体状态 —— 在线数是"屏连没连上"，另一回事。 */
function renderBsum() {
  const o = S.overview || { total: S.board.length, running: 0, stopped: 0, maintain: 0, care: 0 };
  const cells = [
    ['产线总数', o.total, ''],
    ['运行中', o.running, 'run'],
    ['停用', o.stopped, 'off'],
    ['维修中', o.maintain, 'warn'],
    ['保养中', o.care, 'care'],
  ];
  $('bsum').innerHTML = cells.map(([k, v, c]) => `
    <div class="bs"><span class="bs-k">${k}</span><b class="bs-v ${c}">${v}</b></div>`).join('');
  $('bsumSub').innerHTML = o.running
    ? `今天开线 <b>${o.running}</b> 条`
    : '今天还没开线';
}

/**
 * 第 2 段：运行产线。一行一条，只列 status = running 的线。
 * 工序细节不在这儿看 —— 这块屏现在播什么，在「线体设置」和「媒体库」。
 */
function renderBoard() {
  const run = S.board.filter((l) => l.status === 'running');
  $('runSub').innerHTML = run.length ? `${run.length} 条线在运行` : '没有线在运行';

  if (!run.length) {
    $('board').innerHTML = `<div class="run-empty">
      <b>现在没有产线在运行。</b>
      <span>${S.board.length
        ? '把「线体设置」里某条线的状态改成「运行中」，它就会出现在这里。'
        : '还没有建线体，先去「线体设置」建一条。'}</span>
    </div>`;
    return;
  }

  $('board').innerHTML = run.map((l) => {
    const preparing = l.phase === 'prepare';
    const left = l.deadline ? l.deadline - Date.now() : 0;
    const pct = l.clients.length ? Math.round(l.readyCount / l.clients.length * 100) : 0;

    // 第一个 +：这条线正在生产哪个机种。没指定就给个加号 ——
    // 上线第一天屏还没装、内容还空着，先得有个起点，否则"下一个"和"换型"都无从谈起。
    // 已经有了就点「改」，用来对正"现场已经换过料、管理端还停在老机种"。
    const cur = l.currentModelCode
      ? `<b class="rl-big">${H(l.currentModelCode)}</b>
         <span class="rl-nm">${H(l.currentModelName || '')}</span>
         <button class="rl-edit" data-pickcur="${H(l.id)}" title="改：这条线正在生产的机种">改</button>`
      : `<b class="rl-big none">未指定</b>
         <button class="rl-add" data-pickcur="${H(l.id)}">+ 指定正在生产的机种</button>`;

    // 第二个 +：排产下一个。排好了才给出「换型」——换型是"等所有屏备好再一起翻"，
    // 没目标就没得换，所以按钮留着但点不动（比直接消失好找）。
    const next = preparing
      ? `<b class="rl-nx go">${H(l.pendingModelCode || '')}</b>
         <span class="rl-bar"><i style="width:${pct}%"></i></span>
         <span class="rl-pg">已就绪 ${l.readyCount}/${l.clients.length} · 超时强切 ${mmss(left)}</span>
         <button class="btn sm rl-sw on" disabled>换型中</button>`
      : l.nextModelCode
        ? `<b class="rl-nx">${H(l.nextModelCode)}</b>
           <span class="rl-nm">${H(l.nextModelName || '')}</span>
           <button class="btn sm rl-sw" data-switch="${H(l.id)}">换型</button>
           <button class="rl-x" data-clearnext="${H(l.id)}" title="取消排产">✕</button>`
        : `<button class="rl-add" data-picknext="${H(l.id)}">+ 排产下一个机种</button>
           <button class="btn sm rl-sw" disabled title="先排产下一个机种，才有得换">换型</button>`;

    // 当前机种在这条线上有工序没配内容 —— 换型一定卡在那儿，提前亮出来
    const warn = l.currentModelCode && l.noContentCount > 0
      ? `<button class="rl-warn" data-goto-model="${H(l.currentModelId)}"
                 title="点这里去媒体库补内容">⚠ ${l.noContentCount} 道工序没配</button>`
      : '';

    return `<div class="rl${preparing ? ' preparing' : ''}" data-lid="${H(l.id)}">
      <div class="rl-id">
        <b class="rl-name">${H(l.name)}</b>
        <span class="rl-code">${H(l.code)}</span>
      </div>
      <div class="rl-cur"><span class="rl-k">正在生产</span>${cur}</div>
      <div class="rl-nx-box"><span class="rl-k">${preparing ? '换到' : '下一个'}</span>${next}</div>
      <div class="rl-side">
        ${warn}
        <span class="rl-on" title="这条线上有几块屏在线">在线 <b>${l.onlineCount}</b>/${l.clients.length}</span>
        ${preparing ? `<button class="btn sm danger" data-cancel="${H(l.id)}">放弃切换</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ================= 生产概况（右侧栏） =================
   这一块只回答四句话：今天做了多少 / 这一小时多少 / 效率多少 / 停了多久。
   数据来自「登记产量」+ 线体状态流水，不接 MES、不读终端 —— 见 src/api/prod.js。
   刻意不做趋势图：328px 宽画出来的折线没人看得清，要看趋势看「产量登记」里的明细。 */

/** 毫秒 → 「42 分」/「6.5 h」，超过 10 小时就不带小数了（6.5h 有信息量，14.3h 没有） */
function fmtDur(ms) {
  const m = Math.round((Number(ms) || 0) / 60000);
  if (m <= 0) return '0 分';
  if (m < 60) return `${m} 分`;
  const h = m / 60;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
}

function dayToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDay(day, n) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ================= 生产概况 =================
   作业内容页「运行产线」上方那一条。所有数字由服务端 /api/prod/day 算好，
   这里只排布 —— 口径只能有一处，界面里再算一遍迟早会和服务端对不上。

   数据来自左边「生产输入」录的台账（产线 × 日）。没录就明说没录，
   不做任何估算：这一栏是要被拿去开早会的，宁可空着也不能编。 */

async function loadProd() {
  const d = await api('/api/prod/day' + (S.prodDay ? '?day=' + encodeURIComponent(S.prodDay) : ''));
  S.prod = d;
  renderProd();
}

const fmtN = (n) => (n == null || n === '' || !Number.isFinite(Number(n))
  ? '—' : Number(n).toLocaleString('zh-CN'));

/** 一位小数：工时秒数用它，别让 62.500000001 上界面 */
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** 停机时长：满 1 小时给「1.2 h」，不到就给分钟 —— 现场对着表看分钟更准 */
function fmtDown(min) {
  const m = Math.round(Number(min) || 0);
  if (!m) return '0<i>分钟</i>';
  return m >= 60 ? `${(m / 60).toFixed(1)} <i>h</i>` : `${m} <i>分钟</i>`;
}

/** 效率的配色：≥95% 绿、≥80% 黄、其余红。null（没节拍）走灰，不算"差" */
function rateCls(r) {
  if (r == null) return 'mute';
  if (r >= 0.95) return 'ok';
  if (r >= 0.8) return 'warn';
  return 'bad';
}

function renderProd() {
  const d = S.prod;
  const today = dayToday();
  const day = (d && d.day) || S.prodDay || today;
  const isToday = day === today;

  $('pDayLabel').textContent = isToday ? '今天' : day.slice(5).replace('-', '/');
  $('pNext').disabled = day >= today;   // 明天还没发生，翻过去只有空表

  if (!d) { $('pBody').innerHTML = '<div class="p-empty">正在读取…</div>'; return; }

  const t = d.totals || {};
  const running = d.running || [];
  const rows = d.rows || [];        // 台账：一条线一笔
  const byModel = d.byModel || [];  // 同一个产品可能在两条线上做，合计层再并一次

  // 说「在开」不说「在运行」：线体状态是物理的，生产输入里的开不开是排产的，
  // 两条线状态都 running 但今天只开一条时，这里写「在运行 2 条」会让人以为数算错了
  $('pSub').textContent = `${isToday ? '今天' : day} · ${running.length} 条线在开`
    + (t.closedLines ? ` · ${t.closedLines} 条不开线` : '');
  $('pMissing').textContent = t.missing
    ? `${t.missing} 条线还没录生产输入` : '';
  $('pMissing').hidden = !t.missing;

  // 一条台账都没有：与其摆一排「—」，不如直接告诉人去哪录
  if (!rows.length) {
    $('pBody').innerHTML = `<div class="p-empty">
      <b>还没有生产输入</b>
      <span>去左边「生产输入」给当天在生产的产线填上计划开机、产量和停机，
      这里才有数可看。点右上角「去录入」直接过去。</span>
    </div>`;
    return;
  }

  const rate = t.rate;
  const cls = rateCls(rate);
  const pct = rate == null ? 0 : Math.max(0, Math.min(100, Math.round(rate * 100)));

  // ---- 四格主指标：用户点名要的四个数 ----
  const kpis = `
    <div class="pkpi">
      <span class="pk-k">当前每小时产能</span>
      <span class="pk-v"><b>${fmtN(t.hourQty)}</b><i>件/时</i></span>
      <span class="pk-s">各产线「实际每小时」之和</span>
    </div>
    <div class="pkpi">
      <span class="pk-k">累计产能</span>
      <span class="pk-v"><b>${fmtN(t.doneQty)}</b><i>件</i></span>
      <span class="pk-s">计划 ${fmtN(t.planQty)} 件${
        t.planQty > 0 ? ` · 完成 ${Math.round((t.doneQty / t.planQty) * 100)}%` : ''}</span>
    </div>
    <div class="pkpi">
      <span class="pk-k">生产效率</span>
      <span class="pk-v"><b class="${cls}">${rate == null ? '—' : pct + '%'}</b></span>
      <span class="p-bar ${cls}"><i style="width:${pct}%"></i></span>
      <span class="pk-s">${t.noTheory
        ? `${t.noTheory} 条线缺标准产能或工时，合计算不出`
        : `累计 ÷ 理论${t.theory ? `（理论 ${fmtN(t.theory)} 件）` : ''}`}</span>
    </div>
    <div class="pkpi">
      <span class="pk-k">停机时间</span>
      <span class="pk-v"><b>${fmtDown(t.downMin)}</b></span>
      <span class="pk-s">有效工时 ${t.effHours || 0} h / 计划 ${t.shiftHours || 0} h</span>
    </div>`;

  // ---- 当前生产的机种：实时取，不是台账 ----
  const liveHtml = running.length ? running.map((r) => `
    <div class="pg-line">
      <span class="pg-dot${r.hasInput ? '' : ' miss'}"></span>
      <span class="pg-ln">${H(r.lineName)}</span>
      ${r.modelCode
        ? `<b class="pg-mc">${H(r.modelCode)}</b><span class="pg-mn">${H(r.modelName)}</span>`
        : '<span class="pg-none-mc">未指定机种</span>'}
      ${r.hasInput
        ? `<span class="pg-qty">${fmtN(r.hourQty)} 件/时</span>`
          + (r.rate == null ? '' : `<em class="pg-rate ${rateCls(r.rate)}">${Math.round(r.rate * 100)}%</em>`)
        : '<span class="pg-tag">未录入</span>'}
    </div>`).join('')
    : '<div class="pg-empty-line">没有在运行的产线</div>';

  // ---- 效率明细：分子分母全部摊开，别让人只能看一个百分比 ----
  const detail = [
    ['录入产线', `${t.inputLines || 0} 条${t.closedLines ? `（${t.closedLines} 条不开线）` : ''}`],
    ['生产段数', `${t.segCount || 0} 段`],
    ['计划产量', `${fmtN(t.planQty)} 件`],
    ['理论产量', `${fmtN(t.theory)} 件`],
    ['产量缺口', t.gap == null ? '—' : `${fmtN(t.gap)} 件`, t.gap > 0 ? 'warn' : ''],
    ['平均节拍', t.effHours > 0 ? `${fmtN(Math.round(t.doneQty / t.effHours))} 件/时` : '—'],
    ['计划工时', `${t.shiftHours || 0} h`],
    ['有效工时', `${t.effHours || 0} h`]
  ].map(([k, v, c]) => `<div class="p-kv"><span>${k}</span><b class="${c || ''}">${v}</b></div>`).join('');

  // 多个型号、或同一条线分了段，才需要拆开看（一个型号一段时上面那些数已经是它的了）。
  // 放在左列「当前生产的机种」下面 —— 它回答的就是"这几个型号各做了多少"，
  // 和上面的实时列表是同一个问题的两个角度。
  const modelSec = (byModel.length > 1 || (t.segCount || 0) > (t.inputLines || 0)) ? `
    <div class="p-sec pg-mdl-sec">按产品</div>
    ${byModel.map((m) => {
      const extra = [m.lineCount > 1 ? `${m.lineCount} 条线` : '', m.segs > 1 ? `${m.segs} 段` : '']
        .filter(Boolean).join(' · ');
      return `
      <div class="pg-mdl">
        <b>${H(m.code)}</b>
        <span>${fmtN(m.doneQty)} / ${fmtN(m.theory)} 件${extra ? ' · ' + extra : ''}</span>
        <em class="${rateCls(m.rate)}">${m.rate == null ? '—' : Math.round(m.rate * 100) + '%'}</em>
      </div>`;
    }).join('')}` : '';

  $('pBody').innerHTML = `
    <div class="pkpis">${kpis}</div>
    <div class="p-cols">
      <div>
        <div class="p-sec">当前生产的机种</div>
        <div class="pg-live">${liveHtml}</div>
        ${modelSec}
      </div>
      <div>
        <div class="p-sec">效率明细</div>
        ${detail}
      </div>
    </div>`;
}

$('pPrev').addEventListener('click', () => {
  S.prodDay = shiftDay(S.prodDay || dayToday(), -1);
  loadProd().catch((e) => toast(e.message, 'err'));
});
$('pNext').addEventListener('click', () => {
  const next = shiftDay(S.prodDay || dayToday(), 1);
  if (next > dayToday()) return;
  S.prodDay = next;
  loadProd().catch((e) => toast(e.message, 'err'));
});
// 直接借导航按钮的现成逻辑切页，别在别处再写一份视图切换
$('pInputBtn').addEventListener('click', () => {
  const nav = document.querySelector('.nav-item[data-view="prod"]');
  if (nav) nav.click();
});

/** 排产：挑一个机种作为"下一个要生产的"。只记库，不动终端 —— 可能提前一天做。 */
async function pickNextModel(lineId) {
  const line = S.board.find((x) => x.id === lineId);
  if (!line) return;

  const opts = S.models
    .filter((m) => m.enabled && m.code !== line.currentModelCode)
    .map((m) => `<option value="${H(m.code)}">${H(m.code)}${m.name ? '　' + H(m.name) : ''}</option>`)
    .join('');
  if (!opts) return toast('没有可排产的机种（除了正在生产的那个）', 'err');

  const pick = await dialog({
    title: `排产：${line.name} 下一个生产的机种`,
    message: line.currentModelCode
      ? `现在做的是 ${line.currentModelCode}，做完之后换哪个？`
      : '这条线还没指定机种，之后要做哪个？',
    html: `<select id="nextPick" class="dlg-sel">${opts}</select>
           <div class="tip">这一步只记下来，不动终端。真要换，回到这一行点「换型」。</div>`,
    okText: '排产',
    read: (body) => body.querySelector('#nextPick').value,
  });
  if (!pick) return;

  try {
    await postJson('/api/board/next', { lineId, modelCode: pick });
    toast(`已排产：${line.name} 下一个做 ${pick}`, 'ok');
    await loadBoard();
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * 指定「正在生产的机种」。直接落库、不等终端 ——
 * 用在两个场合：① 上线第一天屏还没装、内容还空着；② 现场已经换过料，管理端还停在老机种。
 * 要让所有屏备好再一起翻，用旁边的「换型」（那是两段式协议）。
 */
async function pickCurrentModel(lineId) {
  const line = S.board.find((x) => x.id === lineId);
  if (!line) return;
  if (!S.models.length) await loadModels().catch(() => {});
  if (line.phase === 'prepare') {
    return toast('这条线正在换型中，先「放弃切换」再改当前机种', 'err');
  }

  const opts = S.models.filter((m) => m.enabled)
    .map((m) => `<option value="${H(m.code)}"${m.code === line.currentModelCode ? ' selected' : ''}>${H(modelLabel(m))}</option>`)
    .join('');
  if (!opts) return toast('还没有机种，先去「机种设置」新建一个', 'err');

  const pick = await dialog({
    title: `指定：${line.name} 正在生产的机种`,
    message: line.currentModelCode
      ? `现在记的是 ${line.currentModelCode}，改成哪个？`
      : '这一行现在显示「未指定」。先把正在做的机种填上，排产和换型才有起点。',
    html: `<select id="curPick" class="dlg-sel">${opts}</select>
           <div class="tip">这一步直接改「正在生产」，<b>不等屏下载完</b> —— 在线终端下一轮轮询
             就会自己来取新内容。要让所有屏都备好再一起翻，回去点旁边的「换型」。</div>`,
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

  const pick = e.target.closest('[data-picknext]');
  if (pick) return pickNextModel(pick.dataset.picknext);

  const clr = e.target.closest('[data-clearnext]');
  if (clr) {
    try {
      await postJson('/api/board/next', { lineId: clr.dataset.clearnext, modelCode: '' });
      toast('已取消排产');
      await loadBoard();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const goto = e.target.closest('[data-goto-model]');
  if (goto) {
    S.tab = 'media';
    S.modelId = goto.dataset.gotoModel || '';
    syncNav();
    await loadStations();
    return;
  }

  const sw = e.target.closest('[data-switch]');
  if (sw) {
    const lid = sw.dataset.switch;
    const line = S.board.find((x) => x.id === lid);
    if (!line) return;
    const code = line.nextModelCode;
    if (!code) return toast('先排产一个「下一个机种」', 'err');
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

$('runRefresh').addEventListener('click', () => {
  loadBoard().then(() => toast('已刷新')).catch((e) => toast(e.message, 'err'));
});

// 总览 2 秒刷一次：换型进度和在线数要实时，切走页面就停
// 生产概况跟着刷，但隔一轮（4 秒）—— 它要算整条时间轴，比 /api/board 重，
// 而且产能是按小时记的，2 秒和 4 秒刷新看到的数是同一个。
let prodTick = 0;
S.boardTimer = setInterval(() => {
  if (S.tab !== 'board' || document.hidden) return;
  loadBoard().catch(() => {});
  if (++prodTick % 2 === 0) loadProd().catch(() => {});
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
    const prep = S.board.filter((l) => l.phase === 'prepare').length;
    if (prep) bits.push(`<b class="warn-txt">${prep} 条线换型中</b>`);
  } else if (S.tab === 'lines') {
    bits.push(`共 <b>${S.lines.length}</b> 条线体`);
    const on = S.lines.filter((l) => l.status === 'running');
    bits.push(`运行中 <b>${on.length}</b> 条`);
  } else if (S.tab === 'models') {
    bits.push(`共 <b>${S.models.length}</b> 个机种`);
    const m = S.models.find((x) => x.id === S.mdModelId);
    if (m) bits.push(`当前 <b>${H(m.code)}</b>`);
  } else if (S.tab === 'terms') {
    const t = S.terms;
    if (t) bits.push(`在线 <b>${t.onlineCount}</b> / ${t.total} 台`);
  } else if (S.tab === 'media') {
    if (S.media) bits.push(`${S.media.stats.count} 个文件 · ${fmtBytes(S.media.stats.bytes)}`);
  }
  // 没统计的页面（媒体库还没选工序时）就空着 —— 顶栏挂个「—」像是加载失败
  $('topStats').innerHTML = bits.join('　·　');
}

$('refreshBtn').addEventListener('click', async () => {
  try {
    if (S.tab === 'board') await loadBoard();
    else if (S.tab === 'lines') await loadLines();
    else if (S.tab === 'models') await loadModels();
    else if (S.tab === 'media') await loadStations();
    else if (S.tab === 'files') await loadMedia();
    else if (S.tab === 'terms') await loadTerms();
    toast('已刷新');
  } catch (e) { toast(e.message, 'err'); }
});

// ==================== 线体设置 ====================
async function loadLines() {
  const d = await api('/api/lines');
  S.lines = d.lines || [];
  renderLineTable();
  renderTopStats();
}

/** 线体四种状态。只有「运行」会让终端读这条线的内容。 */
const LINE_ST = [
  ['running', '运行'],
  ['stopped', '停线'],
  ['maintain', '维修'],
  ['care', '保养'],
];
const stName = (v) => (LINE_ST.find(([x]) => x === v) || [, v])[1];

/**
 * 线体表：名称 / 工位数 / 可生产机种 / 状态 / 在线 / 操作。
 *
 * 4.0.0 去掉了「编码」「工序数」「内容覆盖」「当前机种」四列：
 *   编码自动生成，只在「改」里能看到（终端装机要填，别让人以为它不重要）；
 *   工序数属于机种，不属于线体；内容覆盖同理；
 *   「当前机种」改成「可生产机种」—— 正在生产哪个去作业内容页看，这里看的是"能做什么"。
 */
function renderLineTable() {
  const tbody = $('lineTable').querySelector('tbody');
  if (!S.lines.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">还没有线体，点右上角「+ 新建线体」。</td></tr>';
    return;
  }
  const sorted = [...S.lines].sort((a, b) => (a.sort - b.sort) || a.code.localeCompare(b.code));

  tbody.innerHTML = sorted.map((l, i) => `
    <tr class="${l.status === 'running' ? 'cur' : ''}" data-lid="${H(l.id)}">
      <td>
        <b>${H(l.name)}</b>
        ${l.currentModelCode ? `<span class="badge info">在做 ${H(l.currentModelCode)}</span>` : ''}
      </td>
      <td class="num">${l.slots || 0}</td>
      <td>${l.modelCount
        ? `<button class="cell-n on" data-models="${H(l.id)}"
             title="${H((l.modelCodes || []).join('、'))}">${l.modelCount} 个</button>`
        : '<span class="badge muted">未安排</span>'}</td>
      <td>
        <div class="ln-st">
          ${LINE_ST.map(([v, t]) => `<button class="ln-stb st-${v}${l.status === v ? ' on' : ''}"
             data-st="${v}" data-lid="${H(l.id)}" title="改成「${t}」">${t}</button>`).join('')}
        </div>
      </td>
      <td class="num">${l.online || 0}</td>
      <td>
        <div class="row-actions">
          <button class="btn sm" data-act="rename" data-lid="${H(l.id)}">修改</button>
          <button class="iconbtn" data-act="up" data-lid="${H(l.id)}" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-act="down" data-lid="${H(l.id)}" title="下移" ${
            i === sorted.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn sm danger" data-act="del" data-lid="${H(l.id)}">删除</button>
        </div>
      </td>
    </tr>`).join('');
}

/**
 * 改线体状态。v3.5.0 起允许多条线同时运行，所以这里不再"停掉别的线"。
 * 从运行中改成别的要问一句 —— 那条线的屏会停在最后一屏。
 */
async function setLineStatusUI(line, to) {
  if (!line || to === line.status) return;
  const name = stName(to);

  if (line.status === 'running' && to !== 'running') {
    const ok = await dialog({
      title: `把「${line.name}」改成${name}？`,
      message: `这条线的终端会连不上服务端，屏上的内容停在最后一屏，不会变成空白。`
        + `别的线不受影响；改回「运行」随时可以。`,
      okText: `改成${name}`,
      danger: to === 'stopped',
    });
    if (!ok) return renderLineTable();   // 取消要把按钮高亮复位
  }

  try {
    await putJson('/api/lines/' + encodeURIComponent(line.id), { status: to });
    await loadLines();
    toast(`「${line.name}」已改为${name}`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
    renderLineTable();
  }
}

$('lineTable').addEventListener('click', async (e) => {
  // 状态四态按钮
  const st = e.target.closest('[data-st]');
  if (st) {
    const line = S.lines.find((l) => l.id === st.dataset.lid);
    await setLineStatusUI(line, st.dataset.st);
    return;
  }

  // 「可生产机种」点开看清单
  const mm = e.target.closest('[data-models]');
  if (mm) {
    const line = S.lines.find((l) => l.id === mm.dataset.models);
    if (!line) return;
    const codes = (line.modelCodes || []);
    await dialog({
      title: `「${line.name}」可生产 ${codes.length} 个机种`,
      html: `<div class="prod-list">${codes.map((c) => `<span class="prod-tag">${H(c)}</span>`).join('')
        || '<span class="sub">还没有机种勾这条线</span>'}</div>
        <div class="tip">在「机种设置」里改：选中机种 → 那条信息栏上的「可生产线体」。</div>`,
      hideCancel: true,
      okText: '知道了'
    });
    return;
  }

  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.lid;
  const target = S.lines.find((l) => l.id === id);
  if (!target) return;

  if (b.dataset.act === 'rename') {
    const r = await dialog({
      title: '修改线体',
      message: '编码是终端 config.json 里填的标识，一般不用改；工位数是这条线实际有几块屏。',
      fields: [
        { key: 'name', label: '线体名称', value: target.name, placeholder: '例如：二线' },
        { key: 'slots', label: '工位数（几块屏）', value: String(target.slots || 0), placeholder: '5' },
        { key: 'code', label: '编码（终端用）', value: target.code, placeholder: 'L1', tip: '改了编码，现场终端也要跟着改配置' }
      ],
      okText: '保存'
    });
    if (!r) return;
    try {
      await putJson('/api/lines/' + encodeURIComponent(id), {
        name: r.name || target.name,
        code: r.code || target.code,
        slots: Number(r.slots) || target.slots
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
      message: '只断掉「哪些机种能在这条线上做」的关系，机种和里面的文件一个都不会丢。' +
        `${target.currentModelCode ? `注意：这条线现在在生产 ${target.currentModelCode}，删了终端会立刻找不到线。` : ''}`,
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/lines/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadLines();
      toast('已删除 ' + target.name, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('lnNewBtn').addEventListener('click', async () => {
  const r = await dialog({
    title: '新建线体',
    message: '线体就是一条物理产线。编码会自动生成（L1、L2…），终端装机时用得到。',
    fields: [
      { key: 'name', label: '线体名称', placeholder: '二线' },
      { key: 'slots', label: '工位数（几块屏）', value: '5', placeholder: '5', tip: '一个机种几道工序要几块屏，工序数别超过这个数' }
    ],
    htmlAfter: `<div class="dlg-row">
        <label>线体状态</label>
        <div class="ln-st dlg-st" id="dlgNewSt">
          ${LINE_ST.map(([v, t]) => `<button type="button" class="ln-stb st-${v}${v === 'stopped' ? ' on' : ''}"
             data-st="${v}">${t}</button>`).join('')}
        </div>
        <div class="tip">先建成「停线」最安全；确认现场就位了再点「运行」。</div>
      </div>`,
    read: (body) => {
      const on = body.querySelector('#dlgNewSt .ln-stb.on');
      const vals = {};
      body.querySelectorAll('[data-fk]').forEach((el) => { vals[el.dataset.fk] = el.value.trim(); });
      return { name: vals.name, slots: vals.slots, status: on ? on.dataset.st : 'stopped' };
    },
    okText: '创建'
  });
  if (!r) return;
  if (!r.name) return toast('线体名称不能为空', 'err');
  try {
    const made = await postJson('/api/lines', {
      name: r.name, slots: Number(r.slots) || 5, status: r.status
    });
    await loadLines();
    toast(`已新建 ${made.name}（编码 ${made.code}，状态${stName(made.status)}）`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// 新建弹窗里的状态按钮：点哪个亮哪个
$('dialog').addEventListener('click', (e) => {
  const b = e.target.closest('#dlgNewSt .ln-stb');
  if (!b) return;
  e.preventDefault();
  $('dlgNewSt').querySelectorAll('.ln-stb').forEach((x) => x.classList.toggle('on', x === b));
});

// ==================== 线体：Excel 导入 / 导出 ====================
// 和工序那条链同一个套路：导出一份表 → 在 Excel 里改 → 整份导回，
// 先逐行判定给预览，确认了才写库。线体只有几条到几十条，风险不在"行多"，
// 而在**改错编码** —— 现场终端 config.json 里填的就是它。
const LN_IMP_FIELD = { name: '线体名称', code: '编码', slots: '工位数', status: '状态' };

$('lnExportBtn').addEventListener('click', async () => {
  const n = S.lines.length;
  const r = await dialog({
    title: '导出线体 Excel',
    message: `当前 ${n} 条线体。导出后可以在 Excel 里改，改完拿「导入 Excel」导回来。`,
    html: `<div class="dlg-row"><label for="lnExpWhat">导出内容</label>
        <select id="lnExpWhat" class="dlg-sel">
          <option value="full">全量参数（5 页：线体清单 / 线体配置 / 工时设定 / 工序参数 / 字段说明）</option>
          <option value="line">只有线体清单（4 列，文件小、打开快）</option>
          <option value="tpl">空白模板（表头 + 两行示例 + 填写说明）</option>
        </select>
      </div>
      <div class="tip">全量那份把工时、节拍、瓶颈、工序参数都带上了（1.6 万行，约 10 MB），
        换一套系统照着它就能重建。<b>第 1 页「线体清单」</b>改完导回改线体，
        <b>第 3 页「线体工时设定」</b>改「标准产能」能批量导回机种，
        <b>第 4 页「工序参数」</b>要到「机种设置 → 导入」里导回。
        「状态 / 当前机种 / 播放项数」这些是运行态和快照，只导出不导回。</div>`,
    read: (b) => b.querySelector('#lnExpWhat').value,
    okText: '下载'
  });
  if (!r) return;
  try {
    if (r === 'tpl') await downloadFile('/api/export/lines-template.xlsx', '线体清单导入模板.xlsx');
    else await downloadFile('/api/export/lines.xlsx?sheet=' + (r === 'line' ? 'line' : 'full'),
      r === 'line' ? '线体清单.xlsx' : '线体全量参数.xlsx');
  } catch (err) { toast(err.message, 'err'); }
});

// 导入：选文件 → 服务端只解析不落库 → 预览逐行判定 → 确认才写。
// 不直接导入是因为线体表是现场自己拼的，列一错位（把工位数填进名称列）
// 一导就得一条条改回来。
$('lnImportBtn').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.csv,.txt';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const qs = new URLSearchParams({ filename: f.name });
    let d;
    try {
      d = await api('/api/import/lines/parse?' + qs.toString(), { method: 'POST', body: await f.arrayBuffer() });
    } catch (err) { return toast(err.message, 'err'); }
    await showLineImportPreview(d);
  };
  inp.click();
});

/** 线体导入预览：逐行状态表 + 一个处理方式下拉，看清楚了才让点确认。 */
async function showLineImportPreview(d) {
  const c = d.counts;
  const cols = ['name', 'code', 'slots', 'status']
    .filter((f) => d.mapping[f] !== undefined)
    .map((f) => LN_IMP_FIELD[f]).join(' · ');
  const shown = d.rows.slice(0, IMP_LIMIT);
  const canImport = c.new + c.diff + c.same;

  // 「线体工时设定」页：同一个文件里带着就一起导。标准产能是机种属性，
  // 和线体那张表分开算，所以单独一段，别混进上面的行表里。
  const std = d.std && d.std.rows ? d.std : null;
  const stdDiff = std ? std.rows.filter((r) => r.status === 'diff') : [];
  const stdBadRows = std ? std.rows.filter((r) => r.status === 'bad') : [];
  const stdBlock = !std ? '' : `
    <div class="imp-sub">「线体工时设定」页 · 标准产能</div>
    ${std.error ? `<p class="imp-more">${H(std.error)}</p>` : `
      <div class="imp-sum">
        <span class="imp-k warn"><b>${stdDiff.length}</b> 个机种有变化</span>
        <span class="imp-k"><b>${std.counts.same}</b> 个没变化</span>
        ${stdBadRows.length ? `<span class="imp-k bad"><b>${stdBadRows.length}</b> 行不合要求</span>` : ''}
      </div>
      ${stdDiff.length || stdBadRows.length ? `
      <div class="imp-wrap">
        <table class="imp-table">
          <thead><tr><th style="width:46px">行号</th><th style="width:92px">状态</th>
            <th style="width:110px">机种</th><th>说明</th></tr></thead>
          <tbody>${stdDiff.slice(0, 40).map((r) => `
            <tr><td class="imp-no">${r.row}</td><td>${IMP_BADGE.diff}</td>
              <td class="imp-code">${H(r.code)}</td><td class="imp-why">${H(r.detail)}</td></tr>`).join('')}
          ${stdBadRows.slice(0, 20).map((r) => `
            <tr class="is-bad"><td class="imp-no">${r.row}</td><td>${IMP_BADGE.bad}</td>
              <td class="imp-code">${H(r.code)}</td><td class="imp-why">${H(r.reason)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${stdDiff.length > 40 ? `<p class="imp-more">还有 ${stdDiff.length - 40} 个机种，导入按全表走。</p>` : ''}` : ''}
      <p class="imp-more">标准产能是<b>机种</b>的属性：同一个机种在多条线上只写一个值。
        这一页没填的机种保持原样，不会被清成 0。</p>`}`;

  const html = `
    <div class="imp-meta">
      <div>来源 <b>${H(d.filename)}</b> ｜ ${d.header ? `第 ${d.headerRow} 行是表头` : '没有表头，按前三列读（名称 / 编码 / 工位数）'} ｜ 认到 <b>${H(cols)}</b></div>
      ${d.statusIgnored ? '<div class="imp-dim">「状态」列认出来了但不导入 —— 它是现场实时状态，不是配置。</div>' : ''}
    </div>
    <div class="imp-sum">
      <span class="imp-k ok"><b>${c.new}</b> 条新增</span>
      <span class="imp-k warn"><b>${c.diff}</b> 条有变化</span>
      <span class="imp-k"><b>${c.same}</b> 条没变化</span>
      ${c.bad ? `<span class="imp-k bad"><b>${c.bad}</b> 行不合要求</span>` : ''}
    </div>
    <div class="imp-wrap">
      <table class="imp-table">
        <thead><tr>
          <th style="width:46px">行号</th><th style="width:92px">状态</th>
          <th>线体名称</th><th style="width:96px">编码</th>
          <th style="width:72px">工位数</th><th>说明</th>
        </tr></thead>
        <tbody>${shown.map((r) => `
          <tr class="${r.status === 'bad' ? 'is-bad' : ''}">
            <td class="imp-no">${r.row}</td>
            <td>${IMP_BADGE[r.status] || H(r.status)}</td>
            <td>${H(r.name || '—')}</td>
            <td class="imp-code">${H(r.code || '（自动）')}</td>
            <td class="num">${r.status === 'bad' ? '—' : (r.slots || 0)}</td>
            <td class="imp-why">${H(r.reason || r.detail || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${d.rows.length > shown.length ? `<p class="imp-more">表里共 ${d.rows.length} 行，预览只列前 ${shown.length} 行，导入按全表走。</p>` : ''}
    ${c.bad ? '<p class="imp-more">不合要求的行不会导入。</p>' : ''}
    ${stdBlock}
    <div class="dlg-row" style="margin-top:12px">
      <label for="lnMode">已存在的线体怎么处理</label>
      <select id="lnMode" class="dlg-sel">
        <option value="update"${c.diff ? ' selected' : ''}>加新的 + 更新有变化的（${c.diff} 条）</option>
        <option value="merge"${c.diff ? '' : ' selected'}>只加新的，已存在的一律跳过</option>
        <option value="update-only">只更新已存在的，不新建线体</option>
      </select>
    </div>
    <div class="tip">新导入的线体一律是「停线」，确认现场就位后再点「运行」。状态和排序不受导入影响。</div>`;

  const r = await dialog({
    title: canImport ? `导入预览 · ${canImport} 条可导` : '导入预览 · 没有可导的行',
    html,
    read: (b) => b.querySelector('#lnMode').value,
    okText: '确认导入'
  });
  if (!r) return;

  const send = d.rows
    .filter((x) => x.status !== 'bad')
    .map(({ row, name, code, slots }) => ({ row, name, code, slots }));

  // 标准产能只送「有变化」的：没变化的不用写库，bad 的不能写
  const stdSend = stdDiff.map(({ row, modelId, rate }) => ({ row, modelId, rate }));

  let out;
  try { out = await postJson('/api/lines/import', { rows: send, mode: r, stdRows: stdSend }); }
  catch (err) { return toast(err.message, 'err'); }

  await loadLines();
  await showLineImportResult(out, d);
}

/** 线体导入结果：写进去多少 + 没导进去的逐行原因。线体没有"撤销"（数量少，删两下就回去了）。 */
async function showLineImportResult(out, d) {
  const bad = d.rows.filter((x) => x.status === 'bad')
    .map((x) => ({ row: x.row, name: x.name, code: x.code, reason: x.reason }));
  // 落库阶段又失败的（预览本该拦住，兜底留证，别只留一个数字）
  (out.bad || []).forEach((b) => bad.push({ row: b.row, name: b.name || '', code: b.code || '', reason: b.reason }));

  const parts = [];
  if (out.created) parts.push(`新增 <b>${out.created}</b> 条`);
  if (out.updated) parts.push(`更新 <b>${out.updated}</b> 条`);
  if (out.kept) parts.push(`没变化 <b>${out.kept}</b> 条`);
  if (out.skipped) parts.push(`跳过 <b>${out.skipped}</b> 条`);
  // 标准产能是另一件事（写 model 不写 line），单独报一句，别混进线体那几个数里
  if (out.std && out.std.updated) parts.push(`标准产能改了 <b>${out.std.updated}</b> 个机种`);
  if (!parts.length) parts.push('没有需要写库的行');

  const made = (out.lines || []).slice(0, 200).map((l) => `
    <tr><td>${H(l.name)}</td>
      <td class="imp-code">${H(l.code)}</td>
      <td class="imp-dim">${l.from ? `原编码 ${H(l.from)}` : (l.kind === 'created' ? '新建' : '改名称 / 工位数')}</td></tr>`).join('');

  const list = bad.slice(0, 200).map((b) => `
    <tr><td class="imp-no">${b.row}</td>
      <td>${H(b.name || '—')}</td>
      <td class="imp-code">${H(b.code || '—')}</td>
      <td class="imp-why">${H(b.reason)}</td></tr>`).join('');

  const html = `
    <div class="imp-meta"><div>${parts.join(' ｜ ')}</div></div>
    ${made ? `
      <div class="imp-sub">写进库的线体</div>
      <div class="imp-wrap">
        <table class="imp-table">
          <thead><tr><th>线体名称</th><th style="width:96px">编码</th><th style="width:130px">说明</th></tr></thead>
          <tbody>${made}</tbody>
        </table>
      </div>` : ''}
    ${bad.length ? `
      <div class="imp-sub">没导进去的 ${bad.length} 行</div>
      <div class="imp-wrap">
        <table class="imp-table">
          <thead><tr><th style="width:46px">行号</th><th>线体名称</th><th style="width:96px">编码</th><th>原因</th></tr></thead>
          <tbody>${list}</tbody>
        </table>
      </div>
      ${bad.length > 200 ? '<p class="imp-more">只列前 200 行。</p>' : ''}` : ''}
    <div class="tip">导入不动线体状态：新线体是「停线」，已有的状态保持原样。</div>`;

  await dialog({ title: '导入完成', html, okText: '知道了', hideCancel: true });
}

/** 取机种列表。徽标上的 x/y 是这个机种配了几道工序的内容。 */
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
    // 绑定和工序一起取：工序表「屏」那一列要显示"这道工序在哪条线绑了哪台屏"，
    // 分两次串行取会让表格先画一遍再跳一下
    const [d, b] = await Promise.all([
      api('/api/processes?modelId=' + encodeURIComponent(m.id)),
      api('/api/binds').catch(() => ({ binds: [] }))
    ]);
    S.mdStations = d.processes || [];
    S.mdLines = d.lines || [];
    Object.assign(m, { lines: d.lines || [] });
    indexBinds(b.binds || []);
  } catch (e) {
    S.mdStations = [];
    S.mdLines = [];
    S.bindsByCode = {};
    toast(e.message, 'err');
  }

  renderMdMeta(m);
  renderStTable();
}

/* ================= 生产输入（左侧独立页） =================
   作业内容页「生产概况」的每一个数都从这块来。

   v4.2.1 起按产线记账；v4.2.2 起一条线一天可以**分几段**：
     · 小批量来回换型时一个型号只做半小时，一线一行根本填不下；
     · 段只是"这条线这天的第几段"，不带时间 —— 几点做的系统不知道，也没人记；
     · 「不开线」是整条线的开关。选了它，作业内容页的生产概况里就不出现这条线：
       线体状态还挂着 running 但今天没排产（待料、设备空着）时，
       那一栏不该顶一条"未录入"的红字。
     · 效率不填，由 累计 ÷（有效工时 × 产品标准产能）现算；
       标准产能是机种属性，在机种设置「改编号/名称」里维护，这儿不重复填。 */

let PI = null;   // { day, groups[{ ...,segments[] }], lines[], models[], defaultShift }

async function loadProdInput(force) {
  const day = S.piDay || dayToday();
  if (!force && PI && PI.day === day) { renderProdInput(); return; }
  try {
    const qs = new URLSearchParams();
    if (S.piDay) qs.set('day', S.piDay);
    const d = await api('/api/prod/input' + (qs.toString() ? '?' + qs.toString() : ''));
    PI = {
      ...d,
      groups: (d.groups || []).map((g) => ({ ...g, segments: g.segments || [] }))
    };
    PI.day = d.day;
    S.piDay = d.day;
    renderProdInput();
  } catch (e) { toast(e.message, 'err'); }
}

/** 空的一段 */
function piSegNew() {
  return {
    saved: false, modelId: '', modelCode: '', modelName: '', stdRate: 0,
    shiftHours: 0, planQty: 0, hourQty: 0, doneQty: 0, downMin: 0, theory: 0, rate: null
  };
}

/** 型号下拉：停用/已删的机种也要能显示出来，否则老台账一打开就成"别的型号" */
function piModelOpts(s) {
  const list = (PI.models || []).slice();
  if (s.modelId && !list.some((m) => m.id === s.modelId)) {
    list.unshift({
      id: s.modelId, code: s.modelCode || '(已停用)',
      name: s.modelName || '', stdRate: s.stdRate || 0
    });
  }
  return ['<option value="">— 选型号 —</option>']
    .concat(list.map((m) => `<option value="${H(m.id)}"${m.id === s.modelId ? ' selected' : ''}>`
      + `${H(m.code)}${m.name ? '\u3000' + H(m.name) : ''}</option>`))
    .join('');
}

/** 这行的标准产能：看选中型号的 std_rate（机种设置里维护的），没选就是 0。
 *  fallback 是台账行自带的 stdRate —— 型号已停用、不在下拉列表里时靠它兜住 */
function piStdOf(modelId, fallback) {
  const m = (PI.models || []).find((x) => x.id === modelId);
  if (m) return Math.max(0, Math.round(Number(m.stdRate) || 0));
  return modelId ? Math.max(0, Math.round(Number(fallback) || 0)) : 0;
}

/** 和服务端 derive() 同一条公式 —— 界面只做展示，准数以保存后返回的为准 */
function piDerive(shift, down, done, std) {
  const eff = Math.max(0, shift - down / 60);
  const theory = Math.round(eff * std);
  return { eff: +eff.toFixed(2), theory, rate: theory > 0 ? done / theory : null };
}

const pct = (r) => (r == null ? '—' : Math.round(r * 100) + '%');

/** 这一段一个字都没填过（没录过 + 四个数全 0）：效率显示「—」，不显示 0% */
function piBlank(s) {
  return !s.saved && !s.planQty && !s.doneQty && !s.hourQty && !s.downMin;
}
const numIn = (v) => (v == null || v === '' ? '' : v);

/** 一条产线 = 一行或几行。第一行带产线格（rowspan 撑住整组），后面的行只填数据。
 *  「+ 型号」和「开线 / 不开线」都挂在产线格里 —— 那是整线级的动作，
 *  放在段行上会让人以为"这一段不开线"。 */
function piGroupHtml(g, gi) {
  const open = g.isOpen !== false;
  const segs = g.segments.length ? g.segments : [piSegNew()];
  const dis = open ? '' : ' disabled';

  return segs.map((s, si) => {
    const std = piStdOf(s.modelId, s.stdRate);
    const d = piDerive(s.shiftHours || 0, s.downMin || 0, s.doneQty || 0, std);
    // 自动带出来、一个字都没填的行，效率给「—」：算出来是 0%，
    // 但那是"还没录"不是"干砸了"，红色 0% 会让人误会。
    // 不开线的线更不该有百分比 —— 它今天没生产。
    const shown = open && !piBlank(s) ? d.rate : null;
    const cls = rateCls(shown);

    const stdTip = open
      ? `<span class="pt-std${std ? '' : ' miss'}">${std ? `标准 ${std} 件/时` : '这个型号还没设标准产能'}</span>`
      : '<span class="pt-std off">今天不开线，不计入生产概况</span>';

    const lineCell = si === 0 ? `
      <td class="pt-ln" rowspan="${segs.length}">
        <b>${H(g.lineCode)}</b><span>${H(g.lineName)}</span>
        ${g.lineStatus === 'running' ? '' : `<em class="pt-off">${H(stName(g.lineStatus))}</em>`}
        <div class="pt-act">
          <button class="pt-open${open ? ' on' : ''}" data-open="${gi}"
            title="${open ? '今天这条线不开，作业内容页的生产概况里不显示它' : '今天这条线开，重新计入生产概况'}">${open ? '开线' : '不开线'}</button>
        </div>
        ${segs.length > 1 ? `<span class="pt-cnt">${segs.length} 段</span>` : ''}
      </td>` : '';

    return `
    <tr data-g="${gi}" data-s="${si}"${si > 0 ? ' class="pt-seg"' : ''}${open ? '' : ' data-off="1"'}>
      ${lineCell}
      <td>
        <select class="pt-sel" data-f="modelId"${dis}>${piModelOpts(s)}</select>
        ${stdTip}
      </td>
      <td><input class="pt-in" type="number" min="0" step="0.5" inputmode="decimal" data-f="shiftHours" value="${numIn(s.shiftHours)}" placeholder="0.5"${dis}></td>
      <td><input class="pt-in" type="number" min="0" step="1" inputmode="numeric" data-f="planQty" value="${numIn(s.planQty)}" placeholder="0"${dis}></td>
      <td><input class="pt-in" type="number" min="0" step="1" inputmode="numeric" data-f="hourQty" value="${numIn(s.hourQty)}" placeholder="0"${dis}></td>
      <td><input class="pt-in strong" type="number" min="0" step="1" inputmode="numeric" data-f="doneQty" value="${numIn(s.doneQty)}" placeholder="0"${dis}></td>
      <td><input class="pt-in" type="number" min="0" step="1" inputmode="numeric" data-f="downMin" value="${numIn(s.downMin)}" placeholder="0"${dis}></td>
      <td class="pt-rate">
        <b class="${cls}">${pct(shown)}</b>
        <span class="pt-bar ${cls}"><i style="width:${shown == null ? 0 : Math.max(0, Math.min(100, Math.round(shown * 100)))}%"></i></span>
      </td>
      <td class="pt-ops">
        <button class="pt-x" data-del="${gi}:${si}" title="${segs.length > 1 ? '这一段不录了' : '这条线这天不录了'}">✕</button>
        ${open ? `<button class="pt-addseg" data-addseg="${gi}:${si}"
          title="在这一段后面接着做另一个型号">+ 型号</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function renderProdInput() {
  if (!PI) return;
  const today = dayToday();
  const day = PI.day || today;
  const groups = PI.groups || [];

  $('piDayLabel').textContent = day === today ? '今天' : day.slice(5).replace('-', '/');
  $('piNext').disabled = day >= today;

  // 段数只数开线的：不开线的线只有一条占位行，算进去会虚高
  const segTotal = groups.reduce((n, g) => n + (g.isOpen === false ? 0 : g.segments.length), 0);
  const rec = groups.filter((g) => g.isOpen !== false && g.segments.some((s) => s.saved)).length;
  const closed = groups.filter((g) => g.isOpen === false).length;
  $('piSaved').textContent = rec ? `${rec} 条线已录` : '这天还没录';
  $('piSaved').className = 'pi-saved' + (rec ? ' on' : '');
  $('piSub').textContent = groups.length
    ? `${groups.length} 条产线 · ${segTotal} 段${closed ? ` · ${closed} 条不开线` : ''}`
    : '当天在生产的产线，一条线可以分几段做不同型号';

  if (!groups.length) {
    piSetBody('<tbody><tr><td colspan="9" class="pt-empty">'
      + '这天没有在运行的产线。要补录停线 / 维修中的线，点右上角「+ 添加产线」。</td></tr></tbody>');
    $('piTfoot').innerHTML = '';
    $('piCalc').innerHTML = '';
    return;
  }

  // 一条产线一个 tbody：鼠标落在任意一段上，整组一起高亮 ——
  // 一条线做十几段时（一个型号半小时），滚到中间光看行是认不出属于哪条线的
  piSetBody(groups.map((g, gi) => `<tbody class="pt-grp" data-g="${gi}">${piGroupHtml(g, gi)}</tbody>`).join(''));
  $('piTfoot').innerHTML = '<tr class="pt-sum">'
    + '<td>合计</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';
  piCalc();
}

/** 重画表体：表里可能有多个 tbody（一条产线一个），整批换掉 */
function piSetBody(html) {
  const t = $('piTable');
  [...t.tBodies].forEach((tb) => tb.remove());
  $('piTfoot').insertAdjacentHTML('beforebegin', html);
}

/** 表里所有段行（跨 tbody） */
function piRows() {
  return [...$('piTable').querySelectorAll('tbody tr[data-g]')];
}

/** 这一段当前填了什么（从 DOM 读，唯一真源是输入框） */
function piReadSeg(tr) {
  const get = (f) => Math.max(0, Number(tr.querySelector(`[data-f="${f}"]`).value) || 0);
  return {
    modelId: tr.querySelector('[data-f="modelId"]').value,
    shiftHours: get('shiftHours'), planQty: get('planQty'),
    hourQty: get('hourQty'), doneQty: get('doneQty'), downMin: get('downMin')
  };
}

/** 边填边算：每段效率 + 底部合计。公式必须和服务端一致 */
function piCalc() {
  const trs = piRows();
  let plan = 0, hour = 0, done = 0, down = 0, eff = 0, theory = 0, shift = 0, noTheory = 0;
  const openLines = new Set();

  for (const tr of trs) {
    const gi = Number(tr.dataset.g);
    const si = Number(tr.dataset.s);
    const g = PI.groups[gi];
    if (!g) continue;
    const open = g.isOpen !== false;
    const seg = g.segments[si];
    const v = piReadSeg(tr);
    const std = piStdOf(v.modelId, seg && seg.stdRate);
    const d = piDerive(v.shiftHours, v.downMin, v.doneQty, std);
    const blank = !seg || (!seg.saved && !v.planQty && !v.doneQty && !v.hourQty && !v.downMin);
    const shown = open && !blank ? d.rate : null;

    if (open) {
      openLines.add(gi);
      plan += v.planQty; hour += v.hourQty; done += v.doneQty;
      down += v.downMin; eff += d.eff; theory += d.theory; shift += v.shiftHours;
      // 有产量却算不出理论产量 —— 合计效率必须给「—」，
      // 否则分母缺一块，合计能虚高到 200%
      if (v.doneQty > 0 && d.theory === 0) noTheory += 1;
    }

    const cls = rateCls(shown);
    const cell = tr.querySelector('.pt-rate');
    cell.innerHTML = `<b class="${cls}">${pct(shown)}</b>`
      + `<span class="pt-bar ${cls}"><i style="width:${shown == null ? 0 : Math.max(0, Math.min(100, Math.round(shown * 100)))}%"></i></span>`;
    cell.title = !open ? '这条线今天不开线，不计入合计'
      : d.theory > 0
        ? `有效 ${d.eff} h × 标准 ${std} 件/时 = 理论 ${d.theory.toLocaleString('zh-CN')} 件`
        : (std ? '填了「计划开机」才会算效率' : '这个型号没设标准产能，效率算不出来');
  }

  const rate = theory > 0 && !noTheory ? done / theory : null;
  const cls = rateCls(rate);
  $('piTfoot').innerHTML = `<tr class="pt-sum">
    <td>合计 · ${openLines.size} 条线</td>
    <td class="pt-s-eff">有效 ${+eff.toFixed(1)} h</td>
    <td>${+shift.toFixed(1)} h</td>
    <td>${plan.toLocaleString('zh-CN')}</td>
    <td>${hour.toLocaleString('zh-CN')}</td>
    <td class="strong">${done.toLocaleString('zh-CN')}</td>
    <td>${down}</td>
    <td class="pt-rate"><b class="${cls}">${pct(rate)}</b></td>
    <td></td>
  </tr>`;

  // 有型号没设标准产能时，效率会静默变成「—」。这里点明原因，否则现场只会说"算不出来"
  const noStd = trs.some((tr) => {
    const g = PI.groups[Number(tr.dataset.g)];
    if (g && g.isOpen === false) return false;
    return piNoStd(tr);
  });
  $('piCalc').innerHTML = rate == null
    ? `<span class="pi-calc-tip">${noTheory
      ? `有 ${noTheory} 段填了产量但没填「计划开机」（或型号没设标准产能），合计效率算不出来`
      : noStd
        ? '有产线的型号还没设「标准产能」——去「机种设置 → 改编号/名称/产能」补一个，效率才能算'
        : '填了「计划开机」和「累计产能」才会算效率'}</span>`
    : `<span>理论产量 <b>${theory.toLocaleString('zh-CN')}</b> 件</span>
       <span>生产效率 <b class="${cls}">${pct(rate)}</b></span>
       <span class="pi-calc-tip">理论 ${theory.toLocaleString('zh-CN')} 件，实际差 ${(theory - done).toLocaleString('zh-CN')} 件</span>`;
}

function piNoStd(tr) {
  const mid = tr.querySelector('[data-f="modelId"]').value;
  if (!mid) return false;
  const g = PI.groups[Number(tr.dataset.g)];
  const seg = g && g.segments[Number(tr.dataset.s)];
  return !piStdOf(mid, seg && seg.stdRate);
}

/** 把表里的值读回 PI.groups（保存 / 翻页前都要，别让手上的改动白填） */
function piCollect() {
  for (const tr of piRows()) {
    const g = PI.groups[Number(tr.dataset.g)];
    const s = g && g.segments[Number(tr.dataset.s)];
    if (!s) continue;
    const v = piReadSeg(tr);
    Object.assign(s, v);
  }
}

$('piTable').addEventListener('input', piCalc);
$('piTable').addEventListener('change', (e) => {
  if (e.target.dataset.f !== 'modelId') return;
  const tr = e.target.closest('tr');
  const g = PI.groups[Number(tr.dataset.g)];
  const s = g && g.segments[Number(tr.dataset.s)];
  const m = (PI.models || []).find((x) => x.id === e.target.value);
  if (s) {
    s.modelCode = m ? m.code : '';
    s.modelName = m ? m.name : '';
    s.stdRate = m ? m.stdRate : 0;
  }
  // 换了型号，那一行下面的「标准 xxx 件/时」得跟着换
  const std = piStdOf(e.target.value, s && s.stdRate);
  const tip = tr.querySelector('.pt-std');
  tip.textContent = std ? `标准 ${std} 件/时` : '这个型号还没设标准产能';
  tip.className = 'pt-std' + (std ? '' : ' miss');
  piCalc();
});

$('piTable').addEventListener('click', async (e) => {
  // ---- 开线 / 不开线（整条线） ----
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) {
    piCollect();
    const g = PI.groups[Number(openBtn.dataset.open)];
    if (!g) return;
    // 从"开线"切到"不开线"：这条线今天的产量会整条从生产概况里拿掉，
    // 先说清楚再切，别让人手一抖把一上午的数弄没了（数字还在表里，能切回来）
    if (g.isOpen !== false) {
      const used = g.segments.filter((s) => s.modelId || s.doneQty || s.planQty);
      const done = used.reduce((n, s) => n + (s.doneQty || 0), 0);
      if (used.length) {
        const ok = await ask(`${g.lineCode} 今天不开线？`,
          `这条线今天录的 ${used.length} 段、累计 ${done} 件会从作业内容页的生产概况里去掉，`
          + '点「保存」后生效。数字还留在表里，切回开线能改；但保存过再切回来就要重填。',
          '设为不开线', false);
        if (!ok) return;
      }
    }
    g.isOpen = g.isOpen === false;   // 反转
    renderProdInput();
    toast(g.isOpen ? `${g.lineCode} 计入了生产概况` : `${g.lineCode} 今天不开线，生产概况里不显示`, 'ok');
    return;
  }

  // ---- 再加一个型号 ----
  const addBtn = e.target.closest('[data-addseg]');
  if (addBtn) {
    piCollect();
    const [gi, si] = String(addBtn.dataset.addseg).split(':').map(Number);
    const g = PI.groups[gi];
    if (!g) return;
    if (g.isOpen === false) return toast('这条线标了「不开线」，先切成开线再加型号', 'err');
    // 插在点的那一段后面，不是一律加到最后 —— 换型的先后是现场定的，
    // 补录上午漏掉的那一段也不该跑到末尾去。
    const at = Number.isFinite(si) ? Math.min(si + 1, g.segments.length) : g.segments.length;
    g.segments.splice(at, 0, piSegNew());
    renderProdInput();
    const tr = $('piTable').querySelector(`tr[data-g="${gi}"][data-s="${at}"]`);
    if (tr) {
      tr.scrollIntoView({ block: 'nearest' });
      const sel = tr.querySelector('[data-f="modelId"]');
      if (sel) sel.focus();
    }
    return;
  }

  // ---- 删一段 / 删整条线 ----
  const delBtn = e.target.closest('[data-del]');
  if (!delBtn) return;
  piCollect();
  const [gi, si] = delBtn.dataset.del.split(':').map(Number);
  const g = PI.groups[gi];
  const s = g && g.segments[si];
  if (!s) return;

  if (g.segments.length === 1) {
    // 只剩一段 → 删的就是这条线这一天的台账，得走接口真删
    const ok = await ask(`删掉 ${g.lineCode} 这一天？`,
      `${PI.day} 这条线录的产量、停机、工时全部删掉，生产概况里就不再计这条线。不可撤销。`, '删掉', true);
    if (!ok) return;
    try {
      await api('/api/prod/input?' + new URLSearchParams({ lineId: g.lineId, day: PI.day }), { method: 'DELETE' });
      toast('已删掉 ' + g.lineCode, 'ok');
      loadProd().catch(() => {});
    } catch (err) { return toast(err.message, 'err'); }
    PI.groups.splice(gi, 1);
    PI.lines.push({ id: g.lineId, code: g.lineCode, name: g.lineName, status: g.lineStatus });
    renderProdInput();
    return;
  }

  // 组里还有别的段：只是把这一段从表里去掉，点「保存」才真正删
  if (s.saved) {
    const ok = await ask('删掉这一段？',
      `${PI.day} ${g.lineCode} 的这一段（${s.modelCode || '未选型号'}）会从表里去掉，`
      + '点「保存」后生效；保存前关掉页面就白改了。', '删掉', true);
    if (!ok) return;
  }
  g.segments.splice(si, 1);
  renderProdInput();
});

$('piAdd').addEventListener('click', async () => {
  const pool = (PI && PI.lines) || [];
  if (!pool.length) return toast('所有线体都已经在表里了', 'err');
  const opts = pool.map((l) => `<option value="${H(l.id)}">${H(l.code)}　${H(l.name)}（${H(stName(l.status))}）</option>`).join('');
  const pick = await dialog({
    title: '添加一条产线',
    message: '当天没在跑、但要补录产量的线（停线、维修中、下午才开）用这里加。',
    html: `<select id="piAddPick" class="dlg-sel">${opts}</select>`,
    okText: '添加',
    read: (body) => body.querySelector('#piAddPick').value
  });
  if (!pick) return;

  piCollect();
  const l = pool.find((x) => x.id === pick);
  PI.groups.push({
    lineId: l.id, lineCode: l.code, lineName: l.name, lineStatus: l.status,
    isOpen: true, saved: false, segs: 0,
    segments: [{ ...piSegNew(), shiftHours: PI.defaultShift || 8 }]
  });
  PI.lines = pool.filter((x) => x.id !== l.id);
  renderProdInput();
});

$('piSave').addEventListener('click', async () => {
  if (!PI || !PI.groups.length) return toast('这天没有要保存的产线', 'err');
  piCollect();

  // 拍平：一「段」一行。不开线的线只发一行 isOpen:false ——
  // 服务端见到它就只留一条占位，不会把停线前那几段的产量留在库里。
  const rows = [];
  for (const g of PI.groups) {
    if (g.isOpen === false) {
      rows.push({
        lineId: g.lineId, seq: 1, isOpen: false, modelId: '',
        shiftHours: 0, planQty: 0, doneQty: 0, hourQty: 0, downMin: 0
      });
      continue;
    }
    g.segments.forEach((s, i) => rows.push({
      lineId: g.lineId, seq: i + 1, isOpen: true, modelId: s.modelId,
      shiftHours: s.shiftHours, planQty: s.planQty,
      doneQty: s.doneQty, hourQty: s.hourQty, downMin: s.downMin
    }));
  }

  const noStd = PI.groups.some((g) => g.isOpen !== false
    && g.segments.some((s) => s.modelId && !piStdOf(s.modelId, s.stdRate)));
  if (noStd) {
    const go = await ask('有型号还没设标准产能', '这些产线的效率会显示成「—」。'
      + '标准产能在「机种设置 → 改编号/名称/产能」里填，填完效率立刻就有。要现在返回去补吗？', '先保存', false);
    if (!go) return;
  }
  try {
    const r = await postJson('/api/prod/input', { day: PI.day, rows });
    toast(`已保存 ${r.saved} 条产线${r.segs > r.saved ? ` · ${r.segs} 段` : ''}的台账`, 'ok');
    await loadProdInput(true);
    loadProd().catch(() => {});   // 顺手把作业内容页那一栏也刷了，切回去就是新的
  } catch (e) { toast(e.message, 'err'); }
});

$('piPrev').addEventListener('click', () => {
  piCollect();
  S.piDay = shiftDay(PI ? PI.day : dayToday(), -1);
  loadProdInput(true).catch((e) => toast(e.message, 'err'));
});
$('piNext').addEventListener('click', () => {
  const next = shiftDay(PI ? PI.day : dayToday(), 1);
  if (next > dayToday()) return;
  piCollect();
  S.piDay = next;
  loadProdInput(true).catch((e) => toast(e.message, 'err'));
});

/** 信息栏：编码、可生产线体、以及"改 / 删"两个操作。 */
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
        <span class="mm-k">标准产能</span>
        ${m.stdRate
          ? `<b class="mono">${m.stdRate}</b><i class="mm-u">件/时</i>`
          : '<span class="badge warn" title="生产效率要拿它当分母，在「改编号/名称」里填">未设</span>'}
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
      <button class="btn sm" data-mact="ren" title="机种编号、产品名称、标准产能都在这儿改">改编号/名称/产能</button>
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
        {
          key: 'stdRate', label: '标准产能（件/小时）', value: m.stdRate || '',
          placeholder: '例如 1200',
          tip: '稳定跑起来每小时能做多少件。生产输入的「生产效率」用它当分母，'
            + '不填那几条线的效率就显示「—」。'
        },
      ],
      okText: '保存'
    });
    if (!r) return;
    try {
      await putJson('/api/models/' + encodeURIComponent(m.id), {
        code: r.code || m.code, name: r.name || m.name,
        stdRate: Math.max(0, Math.round(Number(r.stdRate) || 0)),
      });
      await loadModels(m.id);
      toast('已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (act.dataset.mact === 'del') {
    const ok = await dialog({
      title: `删除机种「${m.code}」？`,
      message: `它的 ${S.mdStations.length} 道工序和里面的文件会一起删掉，不可恢复。`
        + '文件本身还留在「文件查询」里，但要从头再配。',
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
/** 工序表副标题：道数 / 已配 / 工时合计 / 瓶颈。改一格工时只刷这一行，不碰表体 */
function renderStSub() {
  const el = $('stTableSub');
  if (!el) return;
  const total = S.mdStations.length;
  if (!total) { el.innerHTML = '—'; return; }
  const filled = S.mdStations.filter((x) => x.items.length > 0).length;
  // 工时填了才有得算：合计 = 各工位相加，瓶颈 = 最长那道。
  // 这两个数不用来算效率（效率看机种的标准产能），但排产的人一眼就知道线卡在哪。
  const secs = S.mdStations.map((x) => Number(x.cycleSec) || 0);
  const secSum = secs.reduce((a, b) => a + b, 0);
  const secMax = Math.max(...secs);
  el.innerHTML = `${total} 道工序 · 已配 <b>${filled}</b> 道`
    + (secSum > 0 ? ` · 工时合计 <b>${round1(secSum)}</b> 秒 · 瓶颈 <b>${round1(secMax)}</b> 秒` : '');
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
      <td><input class="cell-in cell-num" data-f="cycleSec" data-num="1" inputmode="decimal"
                 maxlength="7" value="${st.cycleSec ? H(st.cycleSec) : ''}"
                 placeholder="—" title="这一工位做一件要几秒；留空 = 未测"></td>
      <td>${n
        ? `<button class="cell-n on" data-jump="${H(st.id)}">${n} 项</button>`
        : `<button class="cell-n" data-jump="${H(st.id)}">未配</button>`}</td>
      <td>${bindCell(st.code)}</td>
      <td><button class="cell-x" data-del="${H(st.id)}" title="删除这道工序">✕</button></td>
    </tr>`;
  }).join('');
}

/* ================= 工序 ↔ 屏（客户端）绑定 =================
   为什么绑在"线体 × 工序"上：工序属于机种（换型时工位上的屏不该变），
   而一块屏物理上装在一条线的某个工位上。所以键是 (线体, 工序码)，不是 process_id。
   绑定不参与播放 —— 屏上仍按自己填的线号 / 工序号拉内容，这里只是台账 + 校验。 */

/** 服务端回来的绑定按工序码归组：工序表一行一个码，格子里要一次看全它绑了几条线 */
function indexBinds(list) {
  const map = {};
  for (const b of list) (map[b.processCode] = map[b.processCode] || []).push(b);
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => String(a.lineCode).localeCompare(String(b.lineCode)));
  }
  S.bindsByCode = map;
}

const BIND_STATE = {
  online: ['on', '在线'],
  moved: ['warn', '已改配'],
  offline: ['off', '离线'],
  missing: ['off', '记录丢了'],
  unbound: ['off', '未绑']
};
const bindStateText = (k) => (BIND_STATE[k] || [, k || '—'])[1];
const bindStateCls = (k) => (BIND_STATE[k] || BIND_STATE.offline)[0];
const shortIp = (ip) => String(ip || '').split('.').pop() || String(ip || '—');

/**
 * 工序表「屏」那一格。
 *
 * 一条线一个绑定，格子只放得下一个 —— 显示第一条，其余 +N 带过。
 * 只要这条工序有"改配了"或"离线"的，整格标红：不这样的话，
 * 出问题的那台排在第二条，界面上就什么异常都看不见。
 */
function bindCell(code) {
  const list = S.bindsByCode[code] || [];
  if (!list.length) return `<button class="cell-bind" data-bindop="${H(code)}">未绑</button>`;
  const first = list[0];
  const extra = list.length > 1 ? ` +${list.length - 1}` : '';
  const bad = list.some((b) => b.state === 'moved' || b.state === 'offline');
  const tip = list.map((b) =>
    `${b.lineCode} / ${b.processCode} → ${b.ip}　${bindStateText(b.state)}` +
    (b.state === 'moved' ? `（它现在报 ${b.seenLineCode}/${b.seenOpCode}）` : '')).join('\n');
  return `<button class="cell-bind has${bad ? ' bad' : ''}" data-bindop="${H(code)}" title="${H(tip)}"><i class="bd ${bindStateCls(first.state)}"></i>${H(first.lineCode)} · ${H(shortIp(first.ip))}${extra}</button>`;
}

/** 弹窗里那台屏多久没心跳 */
function bindAge(b) {
  if (!b.lastSeen) return '没有心跳记录';
  return ageShort(b.ageMs) + '前';
}

/** 候选排序：自报和这一格完全一致的排最前（现场正常情况就是这一台） */
function candRank(c, lineCode, opCode) {
  const sameLine = c.lineCode === lineCode;
  const sameOp = c.opCode === opCode;
  if (sameLine && sameOp) return 0;
  if (sameOp) return 1;
  if (sameLine) return 2;
  return 3;
}

async function openBindModal(code) {
  const st = S.mdStations.find((x) => x.code === code);
  if (!st) return;
  S.bindCode = code;
  $('bindTitle').textContent = `「${code}${st.name ? ' ' + st.name : ''}」的屏`;
  $('bindHint').textContent = '';
  $('bindBody').innerHTML = '<div class="bind-loading">正在读取客户端…</div>';
  $('bindModal').classList.add('show');
  await refreshBindClients();
}

async function refreshBindClients() {
  try {
    const d = await api('/api/clients');
    S.bindClients = d;
    const b = await api('/api/binds').catch(() => ({ binds: [] }));
    indexBinds(b.binds || []);
    renderBindBody();
    $('bindHint').textContent =
      `全厂 ${d.total} 台客户端 · 在线 ${d.online} 台 · 已分配 ${d.bound} 台` +
      (d.problem ? ` · ${d.problem} 台有问题` : '');
  } catch (e) {
    $('bindBody').innerHTML = `<div class="bind-loading">读不到客户端：${H(e.message)}</div>`;
  }
}

function closeBindModal() {
  $('bindModal').classList.remove('show');
  S.bindCode = '';
  S.bindClients = null;
}

function renderBindBody() {
  const code = S.bindCode;
  const body = $('bindBody');
  if (!code || !S.bindClients) return;

  // 这个机种能做的线体；已经绑了、但不在这份清单里的线体也要列出来，否则解不掉
  const base = (S.mdLines && S.mdLines.length)
    ? S.mdLines.map((l) => ({ id: l.id, code: l.code, name: l.name, status: l.status }))
    : S.lines.map((l) => ({ id: l.id, code: l.code, name: l.name, status: l.status }));
  const extra = (S.bindsByCode[code] || [])
    .filter((b) => !base.some((l) => l.id === b.lineId))
    .map((b) => ({ id: b.lineId, code: b.lineCode, name: b.lineName, status: '' }));
  const lines = [...base, ...extra];

  if (!lines.length) {
    body.innerHTML = '<div class="bind-loading">还没有线体。先在「线体设置」建一条。</div>';
    return;
  }
  body.innerHTML = lines.map((l) => bindLineHtml(l, code)).join('');
}

function bindLineHtml(l, code) {
  const bind = (S.bindsByCode[code] || []).find((b) => b.lineId === l.id);

  const nowHtml = !bind
    ? '<span class="bind-none">这道工序还没指定屏</span>'
    : `<i class="bd ${bindStateCls(bind.state)}"></i>
       <b class="mono">${H(bind.ip)}</b>
       <span class="bstate ${bindStateCls(bind.state)}">${H(bindStateText(bind.state))}</span>
       <span class="muted">${H(bindAge(bind))}</span>
       ${bind.state === 'moved'
         ? `<span class="bind-warn">它现在报 ${H(bind.seenLineCode || '—')}/${H(bind.seenOpCode || '—')}</span>`
         : ''}
       <button class="btn xs ghost" data-unbind="${H(bind.ip)}">解除</button>`;

  // 候选：把已经绑在这一格的那台排除掉（它就在上面那行），其余按匹配度排
  const cands = (S.bindClients.clients || [])
    .filter((c) => !(bind && c.ip === bind.ip))
    .map((c) => ({ ...c, rank: candRank(c, l.code, code) }))
    .sort((a, b) => (a.rank - b.rank) || (b.online - a.online) ||
      a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  const candHtml = cands.length
    ? cands.map((c) => `<button class="bind-cand${c.rank === 0 ? ' match' : ''}"
         data-assign="${H(c.ip)}" data-line="${H(l.id)}">
        <i class="bd ${c.online ? 'on' : 'off'}"></i>
        <b class="mono">${H(c.ip)}</b>
        <span class="mono muted">自报 ${H(c.lineCode || '—')} / ${H(c.opCode || '—')}</span>
        ${c.rank === 0 ? '<span class="tag-ok">就是这台</span>' : ''}
        <span class="muted">${H(ageShort(c.ageMs))}前</span>
      </button>`).join('')
    : '<span class="bind-none">没有可分配的客户端 —— 屏还没连上服务器</span>';

  return `<div class="bind-line">
    <div class="bind-lh"><b>${H(l.code)}</b> <span class="muted">${H(l.name || '')}</span>
      ${l.status === 'running' ? '<span class="badge ok">运行中</span>' : ''}</div>
    <div class="bind-now-row">${nowHtml}</div>
    <div class="bind-cands">${candHtml}</div>
  </div>`;
}

$('bindBody').addEventListener('click', async (e) => {
  const asg = e.target.closest('[data-assign]');
  if (asg) {
    const ip = asg.dataset.assign;
    const lineId = asg.dataset.line;
    if (asg.disabled) return;
    asg.disabled = true;
    try {
      const r = await postJson(`/api/clients/${encodeURIComponent(ip)}/bind`,
        { lineId, processCode: S.bindCode });
      if (r.warning) toast(r.warning, 'warn');
      else if (r.replacedClientId) toast(`「${S.bindCode}」改由 ${ip} 负责，原来那台换下了`, 'ok');
      else toast(`已把 ${ip} 分配给「${S.bindCode}」`, 'ok');
      await refreshBindClients();
      renderStTable();
    } catch (err) {
      asg.disabled = false;
      toast(err.message, 'err');
    }
    return;
  }

  const un = e.target.closest('[data-unbind]');
  if (un) {
    const ip = un.dataset.unbind;
    const ok = await ask('解除分配？',
      `${ip} 不再对应「${S.bindCode}」。屏上的内容和播放都不受影响，只是这里不再记录它。`);
    if (!ok) return;
    try {
      await postJson(`/api/clients/${encodeURIComponent(ip)}/unbind`, {});
      toast('已解除', 'ok');
      await refreshBindClients();
      renderStTable();
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('bindClose').addEventListener('click', closeBindModal);
$('bindX').addEventListener('click', closeBindModal);
$('bindModal').addEventListener('click', (e) => {
  // 点遮罩关掉。点面板里面不关 —— 里面还要连续点选
  if (e.target === $('bindModal')) closeBindModal();
});

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
  const bop = e.target.closest('[data-bindop]');
  if (bop) { await openBindModal(bop.dataset.bindop); return; }

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
      <i class="st-div"></i>
      <span class="st-pair"><span class="st-lbl">工时</span>
        <input class="knum" type="number" min="0" max="86400" step="0.1"
               style="width:64px" data-sid="${H(st.id)}" data-f="cycleSec"
               value="${st.cycleSec ? st.cycleSec : ''}" placeholder="—"
               title="这一工位做一件要几秒；留空 = 还没测。线和机种设置里那一格是同一个数"> 秒</span>
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
    else if (t.dataset.f === 'cycleSec') {
      // 留空就是「还没测」，存 0；上限一天，别让人误填成几十万
      payload.cycleSec = Math.min(86400, Math.max(0, round1(t.value)));
    }

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
  play: '播放方式', maxMb: '单文件上限', cycleSec: '工序工时',
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
      ${d.sheet === '工序参数' ? `<div class="imp-dim">这是线体设置导出的全量表里的「工序参数」页：除名称和做什么，还会把
        播放方式、播放内容、单文件上限、允许类型、图片最小尺寸、工序工时一起写回去。内容项（播放项数）不动。</div>` : ''}
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
      <div class="mediacard" title="${H(m.path || m.name)}">
        <div class="thumb">${m.kind === 'image'
          ? `<img src="${H(m.url)}" loading="lazy" alt="">`
          : (m.kind === 'video' ? '视频' : (m.kind === 'source' ? 'PDF 原件' : '文件'))}</div>
        <div class="meta">
          <div class="t" title="${H(m.name)}">${H(m.name)}</div>
          <div class="s">${fmtBytes(m.bytes)}${m.width ? ` · ${m.width}×${m.height}` : ''} · 被引用 <b>${m.used}</b> 次</div>
          <div class="s path" title="${H(m.path)}">${H(m.path || '（老文件，未归档）')}</div>
        </div>
      </div>
    `).join('') || '<div class="empty" style="grid-column:1/-1">媒体库是空的。点右上角「上传文件」，或在工序里直接拖进去。</div>';
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
        // 这一页是「全库查询」，不认机种：文件先进 media/_未分配/，
        // 等在哪道工序里绑定它，就自动搬进那个机种的工序目录。
        const d = await uploadFile(f);
        toast(`已上传 ${d.kind === 'pdf' ? f.name + '（拆成 ' + d.pageCount + ' 页）' : d.name}${d.duplicated ? '（已存在）' : ''}，绑定工序后自动归档`, 'ok');
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
      `有 ${dry.total} 个文件没有被任何工序引用，共 ${fmtBytes(dry.bytes)}：\n` +
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
/**
 * 两个视角共用这一页：
 *   按工序   这道工序有没有屏、在不在线 —— 现场"哪块屏没开机"用这个
 *   按客户端 哪些机器连上来了、被分配在哪个工位 —— "这台到底是谁"用这个
 * 切换只换数据源和表格，不重新挂事件。
 */
function setTermMode(mode) {
  S.termMode = mode === 'client' ? 'client' : 'op';
  const isClient = S.termMode === 'client';
  $('tmOp').classList.toggle('primary', !isClient);
  $('tmClient').classList.toggle('primary', isClient);
  $('termLineWrap').classList.toggle('hide', isClient);
  $('termOpWrap').classList.toggle('hide', isClient);
  $('termClientWrap').classList.toggle('hide', !isClient);
  $('termFoot').textContent = isClient
    ? 'IP 由服务端从连接来源读取。分配在哪个工位去「机种设置 → 工序设定」的「屏」那一列设；'
      + '屏上把线号 / 工序号改了，这里会显示「已改配」并报出它现在报的是什么。'
    : 'IP 由服务端从连接来源读取，不采信终端自报；终端每 5 秒上报一次参数。'
      + '未上线的工序也会列出来，方便区分"没装机"和"装了没开机"。';
  loadTerms().catch(() => {});
}

async function loadTerms() {
  if (S.termMode === 'client') return loadClients();

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

async function loadClients() {
  // 客户端是全厂口径，不按线体筛：现场最常问的是"到底连上来几台"
  try {
    S.clients = await api('/api/clients');
  } catch {
    S.clients = null;
  }
  renderClientTable();
  renderTopStats();
}

function renderClientTable() {
  const tb = $('clientTable').querySelector('tbody');
  const d = S.clients;
  if (!d) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">读不到客户端列表</td></tr>';
    $('termSub').textContent = '—';
    return;
  }
  if (!d.clients.length) {
    $('termSub').textContent = '还没有客户端连上来';
    tb.innerHTML = `<tr><td colspan="7" class="empty">
      还没有任何客户端连上来。屏第一次启动时在「终端设置」里填服务器地址，
      之后每 5 秒自动登记一次，这里就会出现。</td></tr>`;
    return;
  }

  $('termSub').textContent =
    `全厂 ${d.total} 台 · 在线 ${d.online} 台 · 已分配 ${d.bound} 台` +
    (d.problem ? ` · ${d.problem} 台有问题` : '') + ' · 每 2 秒自动刷新';

  tb.innerHTML = d.clients.map((c) => {
    const b = c.bind;
    const alloc = b
      ? `${H(b.lineCode)} / <b>${H(b.processCode)}</b>`
      : '<span class="muted">未分配</span>';

    let state;
    if (!c.online) {
      state = `<span class="badge danger">离线 ${H(ageShort(c.ageMs))}</span>`;
    } else if (!b) {
      state = '<span class="badge muted">在线 · 未分配</span>';
    } else if (b.state === 'moved') {
      state = `<span class="badge warn">已改配 · 现在报 ${H(c.lineCode || '—')}/${H(c.opCode || '—')}</span>`;
    } else {
      state = '<span class="badge ok">在线 · 与分配一致</span>';
    }

    return `<tr>
      <td class="mono">${H(c.ip)}</td>
      <td>${c.name ? H(c.name) : '<span class="muted">—</span>'}</td>
      <td class="mono">${H(c.lineCode || '—')} / ${H(c.opCode || '—')}</td>
      <td class="num">${H(ageShort(c.ageMs))}前</td>
      <td>${alloc}</td>
      <td>${state}</td>
      <td>${b ? `<button class="btn xs ghost" data-cunbind="${H(c.ip)}">解除</button>` : ''}</td>
    </tr>`;
  }).join('');
}

$('tmOp').addEventListener('click', () => setTermMode('op'));
$('tmClient').addEventListener('click', () => setTermMode('client'));

$('clientTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cunbind]');
  if (!btn) return;
  const ip = btn.dataset.cunbind;
  const ok = await ask('解除分配？', `${ip} 不再对应任何工序。屏上的内容和播放都不受影响，只是这里不再记录它。`);
  if (!ok) return;
  try {
    await postJson('/api/clients/' + encodeURIComponent(ip) + '/unbind', {});
    toast('已解除', 'ok');
    await loadClients();
  } catch (err) { toast(err.message, 'err'); }
});

// 终端监控页 2 秒刷新；不在这一页就不占带宽
setInterval(() => {
  if (S.tab !== 'terms' || document.hidden) return;
  if (S.termMode === 'client') {
    api('/api/clients')
      .then((d) => { S.clients = d; renderClientTable(); })
      .catch(() => {});
    return;
  }
  if (!S.termLineId) return;
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
    await loadProd().catch(() => {});
    const st = await api('/api/status').catch(() => null);
    if (st && st.version) { S.version = st.version; renderSideFoot(); }
  } catch (err) {
    toast('连接服务端失败：' + err.message, 'err');
  }
})();

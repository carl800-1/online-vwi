// 管理端逻辑：内容矩阵 + 清单编辑 + 换型
// 无框架、无构建，浏览器直接跑。所有状态都在内存，一次刷新从服务端重建。

const H = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const $ = (id) => document.getElementById(id);

const S = {
  lines: [],         // [{id, code, name, enabled, processes, coverage, currentModelCode, ...}]
  lineId: '',        // 正在看哪条线体
  activeLineId: '',  // 今天在跑哪条线体（enabled=1）
  version: '',

  // 中栏聚焦的机种。空 = 全部机种（矩阵显示全部，右栏只看线体状态）。
  // 为什么要有它：一条线上十个型号、五道工序，全部摊开时人找不到"我现在做的那一个"。
  modelPick: '',
  terms: null,       // 右栏：/api/terminals 的结果
  termTimer: null,
  profileMatch: null, // 当前「线体 × 机种」匹配到的那份配置（含校验结果）
  badItems: new Map(), // 抽屉里：mediaId -> 不符合配置要求的原因

  profiles: [],       // 配置库全部档案
  pf: null,           // 正在编辑的那份（内存副本，点保存才提交）
  pfDirty: false,

  models: [],
  processes: [],
  currentId: '',
  currentCode: '',
  phase: 'idle',
  pendingId: '',
  pendingCode: '',
  deadline: 0,
  online: [],
  ready: [],
  rev: 0,

  tab: 'matrix',
  editing: null,     // { modelId, processId, title, sub }
  items: [],         // [{ mediaId, kind, name, bytes, url, dwellSec }]
  dirty: false,
  objPick: [],       // 媒体库多选
  pollSince: 0
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

// ---------- 对话框 ----------
/**
 * 自己画的输入/确认框。
 *
 * 起因很实际：Electron 里 window.prompt() 是**直接抛异常**的
 * （"prompt() is and will not be supported"），点「+ 新型号」毫无反应就是这么来的；
 * confirm() 虽然还能用，但弹的是英文 OK/Cancel 的原生框，中文产线工具上很跳。
 * 所以一律走这里，输入框和确认框用同一套。
 *
 * html 用来塞自定义内容（比如「启用线体」的单选列表）；
 * 配 read(body) 可以自己决定返回什么，不写就返回 true。
 *
 * @returns {Promise<null|true|Object|any>} 取消返回 null；无字段返回 true；有字段返回 { key: 值 }
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
    // 纯告知类弹窗（校验结果、应用结果）没有"取消"这回事，留着只会让人以为点了会撤销什么
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
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    };

    ok.onclick = submit;
    $('dlgCancel').onclick = () => finish(null);
    $('dlgX').onclick = () => finish(null);
    $('dialog').onclick = (e) => { if (e.target === $('dialog')) finish(null); };
    document.addEventListener('keydown', onKey);

    const first = inputs[0];
    if (first) { first.focus(); first.select(); } else ok.focus();
  });
}

/** confirm 的替身，语义一致：确定 true，取消 null */
async function ask(title, message, okText = '确定', danger = false) {
  const r = await dialog({ title, message, okText, danger });
  return r === true ? true : null;
}

/**
 * 型号的显示名。
 * 种子数据把 name 写成「X200 型」，直接拼 code 就成了「X200 X200 型」，
 * 下拉框和抽屉标题里都是这副德性 —— 现场看着像系统出错了。
 * 所以：name 里已经含 code 就只显示 name，否则拼起来。
 */
function modelLabel(m) {
  const code = (m.code || '').trim();
  const name = (m.name || '').trim();
  if (!name) return code;
  if (!code) return name;
  return name.toLowerCase().includes(code.toLowerCase()) ? name : code + ' ' + name;
}

function mmss(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------- 载入 ----------
function lineQuery() {
  return S.lineId ? '?lineId=' + encodeURIComponent(S.lineId) : '';
}

async function loadAll() {
  const ls = await api('/api/lines');
  S.lines = ls.lines || [];
  S.activeLineId = (S.lines.find((l) => l.enabled) || {}).id || '';

  // 选中的线体可能被删了/换了：优先留在原来那条，否则跟着"启用中"那条走
  if (!S.lineId || !S.lines.some((l) => l.id === S.lineId)) {
    S.lineId = S.activeLineId || (S.lines[0] && S.lines[0].id) || '';
  }
  renderLineBar();

  if (!S.lineId) {
    S.models = []; S.processes = [];
    S.currentId = ''; S.currentCode = ''; S.online = [];
    S.profileMatch = null; S.terms = null;
    renderMatrix(); renderModelOptions(); renderSwitchOptions(); renderFooter();
    renderTerms();
    return;
  }

  const qs = lineQuery();
  const [m, p, st] = await Promise.all([
    api('/api/models' + qs), api('/api/processes' + qs), api('/api/status' + qs)
  ]);
  S.models = m.models;
  S.coverage = m.coverage;
  S.processes = p.processes;
  S.version = st.version || S.version;
  applyState(st, true);

  // 聚焦的机种可能被删了/停用了：退回"全部"
  if (S.modelPick && !S.models.some((x) => x.code === S.modelPick && x.enabled)) S.modelPick = '';

  renderMatrix();
  renderModelOptions();
  renderSwitchOptions();
  await Promise.all([loadProfileMatch(), loadTerminals()]);
}

function applyState(st, quiet) {
  const changed = st.rev !== S.rev;
  S.rev = st.rev;
  S.currentId = st.currentModelId || '';
  S.currentCode = st.modelCode || '';
  S.phase = st.phase || 'idle';
  S.pendingId = st.pendingModelId || '';
  S.pendingCode = st.pendingModelCode || '';
  S.deadline = st.deadline || 0;
  S.online = st.online || [];
  S.ready = st.ready || [];
  if (st.version) S.version = st.version;

  renderFooter();
  renderPhaseBar();
  if (changed && !quiet) {
    // 型号变了：矩阵里的"当前"高亮要跟着动
    renderMatrix();
  }
}

/* 底栏左下角：在线台数 / 当前型号 / 版本号 —— 现场最常问的三个数 */
function renderFooter() {
  const active = S.lines.find((l) => l.id === S.lineId);
  $('curTxt').textContent = S.currentCode
    ? (active ? active.name + ' · ' + S.currentCode : S.currentCode)
    : '未指定';
  $('onlineTxt').textContent = S.online.length;
  $('dot').classList.toggle('on', S.online.length > 0);
  $('verTxt').textContent = S.version || '—';

  // 底栏左侧那句提示：说清楚"现在这一下会作用到哪儿"，
  // 否则底部只有一个换型下拉，人不知道它换的是哪条线的哪个机种。
  const line = S.lines.find((l) => l.id === S.lineId);
  const m = S.modelPick || S.currentCode;
  $('footHint').innerHTML = line
    ? `线体 <b>${H(line.name)}</b>${line.enabled ? '' : '（未启用）'}　·　机种 <b>${H(m || '全部')}</b>`
    : '在左侧选线体，在中栏选机种';
}

/**
 * 左栏线体列表。
 *
 * 排序规则：**启用中的那条恒排第一**，其余按 sort。
 * 为什么不是纯 sort：每天上线第一件事就是确认"今天跑哪条"，
 * 让它永远在最上面，不用在十条线里找那个绿点。
 * 这里只在显示层排序，不动数据库的 sort —— 数据库里的 sort 是"车间给的顺序"，
 * 启用状态是"今天的状态"，两者混在一起写回库里，明天换线就得手工再排一遍。
 */
function renderLineBar() {
  const box = $('lineChips');
  if (!S.lines.length) {
    box.innerHTML = '<div class="sub" style="padding:4px 10px">还没有线体，点上面的 + 新建</div>';
    $('lineWarn').classList.add('hide');
    return;
  }

  const sorted = [...S.lines].sort((a, b) =>
    (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) || (a.sort - b.sort) || a.code.localeCompare(b.code));

  box.innerHTML = sorted.map((l) => {
    const cls = ['linechip', l.id === S.lineId ? 'on' : '', l.enabled ? 'enabled' : 'off']
      .filter(Boolean).join(' ');
    return `<button class="${cls}" data-lid="${H(l.id)}"
        title="${H(l.name)}（${H(l.code)}）· ${l.processes} 道工序 · 已配 ${l.coverage.done}/${l.coverage.total}${
          l.enabled ? '　今天在跑这条线' : '　未启用，终端不会读这条线'}">
      <span class="live"></span>
      <span class="ln-name">${H(l.name)}</span>
      ${l.enabled ? '<em>启用</em>' : `<span class="cov">${l.coverage.done}/${l.coverage.total}</span>`}
    </button>`;
  }).join('');

  // 看的不是今天在跑的那条线 —— 一进页面就说清楚，别等人点完换型才发现屏上没反应
  const cur = S.lines.find((l) => l.id === S.lineId);
  const warn = $('lineWarn');
  if (cur && !cur.enabled) {
    const active = S.lines.find((l) => l.enabled);
    warn.className = 'linewarn';
    warn.innerHTML =
      `<span>正在看「<b>${H(cur.name)}</b>」，但今天启用的是「<b>${active ? H(active.name) : '没有'}</b>」——` +
      `终端目前不会读这条线的内容。</span>` +
      `<div class="spacer"></div>` +
      `<button class="btn sm" data-enable="${H(cur.id)}">把「${H(cur.name)}」设为启用</button>`;
  } else {
    warn.classList.add('hide');
  }
}

$('lineWarn').addEventListener('click', (e) => {
  const b = e.target.closest('[data-enable]');
  if (b) enableLine(b.dataset.enable);
});

/** 启用某条线体（同一时刻只有一条），成功后刷新整页数据 */
async function enableLine(lineId) {
  const target = S.lines.find((l) => l.id === lineId);
  if (!target) return;
  if (target.enabled) { toast(target.name + ' 已经是启用状态'); return; }
  try {
    await api('/api/lines/' + encodeURIComponent(lineId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    S.lineId = lineId;
    await loadAll();
    toast('已启用 ' + target.name + '，终端会自动切换到这条线', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

$('lineChips').addEventListener('click', (e) => {
  const b = e.target.closest('.linechip');
  if (!b) return;
  if (b.dataset.lid === S.lineId) return;
  S.lineId = b.dataset.lid;
  loadAll().catch((err) => toast(err.message, 'err'));
});

$('addLineBtn').addEventListener('click', async () => {
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
  const code = r.code;
  if (!code) return toast('线体编码不能为空', 'err');
  try {
    const made = await api('/api/lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: r.name || code })
    });
    S.lineId = made.id;           // 建完直接跳过去，省得再点一次
    await loadAll();
    toast('已新建线体 ' + made.name + '（还没启用）', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

/* 启用线体：同一时刻只能有一条在跑，所以是单选而不是多选。
   多选会让不带 line 的老终端不知道该听谁 —— 现场 5 台屏还没重装。 */
$('enableLineBtn').addEventListener('click', async () => {
  if (!S.lines.length) return toast('还没有线体，先新建一条', 'err');

  const html = '<div class="linepick">' + S.lines.map((l) => `
    <label class="linepick-row ${l.enabled ? 'cur' : ''}">
      <input type="radio" name="pickline" value="${H(l.id)}" ${l.enabled ? 'checked' : ''}>
      <span class="lp-name">${H(l.name)}<small>${H(l.code)}</small></span>
      <span class="lp-meta">${l.processes} 道工序 · ${l.coverage.done}/${l.coverage.total} 套已配置${
        l.currentModelCode ? ' · 当前 ' + H(l.currentModelCode) : ''}</span>
    </label>`).join('') + '</div>';

  const picked = await dialog({
    title: '启用线体',
    message: '选中的这条线今天在跑，终端会读它的内容。同一时刻只有一条线体启用，换线不影响另一条线已配好的内容。',
    html,
    read: (body) => (body.querySelector('input[name=pickline]:checked') || {}).value || '',
    okText: '启用这条线'
  });
  if (picked === null) return;
  if (!picked) return toast('请先选一条线体', 'err');
  await enableLine(picked);
});

function renderPhaseBar() {
  const bar = $('phasebar');
  if (S.phase !== 'prepare') {
    bar.classList.remove('show');
    return;
  }
  bar.classList.add('show');
  const left = S.deadline ? S.deadline - Date.now() : 0;
  const readySet = new Set(S.ready);
  $('phaseText').innerHTML =
    `正在切换到 <b>${H(S.pendingCode)}</b> · 已就绪 <b>${S.ready.length}/${S.online.length}</b>` +
    `　超时强切 <b>${mmss(left)}</b>`;

  const ops = S.processes.filter((p) => S.online.includes(p.code) || readySet.has(p.code));
  $('phaseChips').innerHTML = ops.map((p) => {
    const ok = readySet.has(p.code);
    return `<span class="chip ${ok ? 'ok' : 'bad'}">${H(p.code)} ${H(p.name)} · ${ok ? '已就绪' : '下载中'}</span>`;
  }).join('') || '<span class="chip">当前没有终端在线，切换会立即生效</span>';
}

// ---------- 右栏：终端实时参数 ----------
/**
 * 这里的数据和长轮询是两套，别混：
 *   长轮询 /api/state 说明「该播哪个型号、谁已就绪」—— 决定业务，25 秒一次；
 *   /api/terminals   说明「每台屏现在长什么样、下到第几项」—— 只给人看，2 秒一次。
 * 分开的理由很实际：进度是高频数据，塞进长轮询会把全厂终端的"耳朵"叫醒一遍，
 * 弱网现场等于自己给自己加负载。
 */
async function loadProfileMatch() {
  if (!S.lineId) { S.profileMatch = null; return; }
  const mc = S.modelPick || S.currentCode || '';
  try {
    S.profileMatch = await api(`/api/profiles/match?lineId=${encodeURIComponent(S.lineId)}`
      + `&modelCode=${encodeURIComponent(mc)}`);
  } catch {
    S.profileMatch = null;
  }
  renderMatrix();
}

async function loadTerminals() {
  if (!S.lineId) { S.terms = null; renderTerms(); return; }
  try {
    S.terms = await api('/api/terminals?lineId=' + encodeURIComponent(S.lineId));
  } catch {
    S.terms = null;
  }
  renderTerms();
}

function ageShort(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + ' 秒';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' 分钟';
  return Math.round(min / 60) + ' 小时';
}

function renderTerms() {
  const box = $('termCards');
  const t = S.terms;
  if (!t) {
    $('paramSub').textContent = '—';
    box.innerHTML = '<div class="sub" style="padding:6px">还没有线体，先在左侧建一条。</div>';
    $('paramFoot').textContent = '';
    return;
  }

  $('paramSub').textContent = `${t.lineName} · 在线 ${t.onlineCount}/${t.total}`;

  box.innerHTML = t.terminals.map((r) => {
    const cls = ['term', r.online ? 'on' : '', r.ready ? 'ready' : '', r.seen ? '' : 'never']
      .filter(Boolean).join(' ');

    // 「未上线」和「离线 3 分钟」是两件事：前者多半是压根没装机，后者是关机了。
    // 现场问"3 号工位怎么没数据"，答案全在这个区分里。
    const state = !r.seen
      ? '<span class="d"></span>未上线'
      : r.online
        ? `<span class="d"></span>${ageShort(r.ageMs)}前`
        : `<span class="d"></span>已离线 ${ageShort(r.ageMs)}`;

    const req = reqOf(r.op);
    const chk = chkOf(r.op);
    const reqLine = req
      ? `<div class="term-req">配置 <span class="tag">${H(reqSummary(req))}</span>${
          chk ? `<span class="tag ${chk.ok ? 'ok' : 'bad'}">${chk.ok ? '✓ 达标' : '✕ ' + chk.issues.length + ' 项不符'}</span>` : ''
        }</div>`
      : '';

    if (!r.seen) {
      return `<div class="${cls}">
        <div class="term-top">
          <span class="term-op">${H(r.op)}</span>
          <span class="term-name">${H(r.name)}</span>
          <span class="term-state">${state}</span>
        </div>
        <div class="term-kv" style="color:var(--ink3)">从未有终端连接过 · 检查这台机器是否已装机</div>
        ${reqLine}
      </div>`;
    }

    const pct = r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : (r.ready ? 100 : 0);
    const doneCls = pct >= 100 ? 'done' : '';
    const resText = r.res ? r.res.replace('x', '×') : '—';
    const freeText = r.free ? fmtBytes(r.free) : '—';
    const progText = r.total > 0
      ? `${r.modelCode ? H(r.modelCode) + ' · ' : ''}${r.done}/${r.total} 项`
      : (r.ready ? '内容已就绪' : (r.modelCode ? H(r.modelCode) + ' · 等待下载' : '空闲'));

    return `<div class="${cls}">
      <div class="term-top">
        <span class="term-op">${H(r.op)}</span>
        <span class="term-name">${H(r.name)}</span>
        <span class="term-state">${state}${r.ready ? ' <b>已就绪</b>' : ''}</span>
      </div>
      <div class="term-kv">
        <span class="mono">${H(r.ip || '—')}</span>
        <span><b>${H(resText)}</b></span>
        <span>v<b>${H(r.ver || '—')}</b></span>
        <span>剩余 <b>${freeText}</b></span>
      </div>
      <div class="term-bar ${doneCls}"><i style="width:${pct}%"></i></div>
      <div class="term-prog"><span>${progText}</span><b>${pct}%</b></div>
      ${reqLine}
    </div>`;
  }).join('') || '<div class="sub" style="padding:6px">这条线体还没有工序。</div>';

  const when = t.ts ? new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  $('paramFoot').innerHTML =
    `${t.phase === 'prepare' ? `<b style="color:var(--warn)">正在准备 ${H(t.pendingModelCode || '')}</b>　` : ''}` +
    `刷新于 ${when} · 每 2 秒自动刷新`;
}

$('paramRefresh').addEventListener('click', () => loadTerminals().catch(() => {}));

// 2 秒轮询：只在看"线体内容"并且窗口可见时跑，切到媒体库/后台标签页不占带宽
setInterval(() => {
  if (S.tab !== 'matrix' || document.hidden || !S.lineId) return;
  loadTerminals().catch(() => {});
}, 2000);

// ---------- 矩阵 ----------

const KIND_CN = { image: '图', video: '视', pdf: 'PDF' };

/** 当前「线体 × 机种」匹配到的配置里，这道工序的要求。没有匹配就是 null */
function reqOf(code) {
  return (S.profileMatch && S.profileMatch.byCode && S.profileMatch.byCode[code]) || null;
}
function chkOf(code) {
  const steps = (S.profileMatch && S.profileMatch.check && S.profileMatch.check.steps) || [];
  return steps.find((x) => x.code === code) || null;
}
/** 要求摘要：图≥2 视≥1 —— 表头只有一行位置，必须能一眼读完 */
function reqSummary(step) {
  if (!step || !step.reqs || !step.reqs.length) return '不限类型';
  return step.reqs.map((r) => {
    const n = Number(r.minCount) || 0;
    return KIND_CN[r.kind] + (n > 0 ? '≥' + n : '');
  }).join(' ');
}

function renderMatrix() {
  const thead = $('matrix').querySelector('thead');
  const tbody = $('matrix').querySelector('tbody');

  thead.innerHTML = '<tr>' +
    '<th style="width:186px">机种</th>' +
    S.processes.map((p) => {
      const req = reqOf(p.code);
      const chk = chkOf(p.code);
      // 表头脚注：有配置就写要求 + 达标状态；没配置就什么都不加（"没配置"不等于"不合格"）
      const foot = req
        ? `<span class="th-req ${chk ? (chk.ok ? 'ok' : 'bad') : ''}">`
          + `${H(reqSummary(req))}${chk ? (chk.ok ? ' ✓' : ' ✕') : ''}</span>`
        : '';
      return `<th><span class="pname" data-pid="${p.id}" title="点击改名">${H(p.code)}<small>${H(p.name)}</small> ✎</span>${foot}</th>`;
    }).join('') +
    '<th style="width:112px">完成度</th></tr>';

  // 聚焦的机种排到最前：一条线上型号多时，人找的是"我现在做的那个"
  const rows = [...S.models].sort((a, b) => {
    const fa = a.code === S.modelPick ? 0 : 1;
    const fb = b.code === S.modelPick ? 0 : 1;
    return fa - fb;
  });

  let done = 0, total = 0;
  tbody.innerHTML = rows.map((m) => {
    done += m.done; total += m.total;
    const cells = S.processes.map((p) => {
      const n = m.cells[p.id] || 0;
      const req = reqOf(p.code);
      const chk = chkOf(p.code);
      // 格子里也带一个"够不够"的信号：要求 2 项、实际 1 项时不该等到点进去才知道
      let warn = '';
      if (req && chk && chk.exists && !chk.ok && m.code === (S.modelPick || S.currentCode)) {
        const need = req.reqs.reduce((acc, r) => acc + (Number(r.minCount) || 0), 0);
        // 项数不够就说缺几项；项数够但分辨率/体积不达标时，说"规格不符"而不是"缺 0 项"
        warn = `<span class="k" style="color:var(--danger)">${
          n < need ? '缺 ' + (need - n) + ' 项' : '规格不符'}</span>`;
      }
      return `<td class="cell">
        <button class="cellbtn ${n ? 'has' : ''}"
                data-mid="${m.id}" data-pid="${p.id}">
          <span class="n">${n ? n + ' 项' : '未配置'}</span>
          ${warn || `<span class="k">${n ? '点击编辑' : '点击添加内容'}</span>`}
        </button>
      </td>`;
    }).join('');

    const pct = m.total ? Math.round(m.done / m.total * 100) : 0;
    return `<tr class="${m.id === S.currentId ? 'row-cur' : ''}${m.code === S.modelPick ? ' row-focus' : ''}">
      <td class="model">
        <span class="code">${H(m.code)}</span>
        ${m.name && !m.name.toLowerCase().includes((m.code || '').toLowerCase())
          ? '<span class="nm">' + H(m.name) + '</span>' : ''}
        ${m.id === S.currentId ? '<span class="now-tag">当前</span>' : ''}
        ${m.code === S.modelPick ? '<span class="focus-tag">聚焦</span>' : ''}
        ${m.enabled ? '' : '<span class="off">停用</span>'}
      </td>
      ${cells}
      <td class="score">
        <div class="scorebar">
          <span class="mini"><i class="${pct === 100 ? 'full' : ''}" style="width:${pct}%"></i></span>
          <em>${m.done}/${m.total}</em>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">还没有型号，点右上角"+ 新型号"。</td></tr>';

  $('covTxt').textContent = `${done} / ${total} 套已配置`;
  $('covBar').style.width = (total ? done / total * 100 : 0) + '%';

  // 这句提示跟着线体走：看的是哪条线、这条线今天到底读不读得到，必须一眼看出来
  const line = S.lines.find((l) => l.id === S.lineId);
  const pm = S.profileMatch && S.profileMatch.profile;
  $('matrixHint').innerHTML = !line
    ? '还没有线体。先在左侧「+」新建，再把型号的内容填进去。'
    : `正在查看「<b>${H(line.name)}</b>」的内容矩阵（${S.processes.length} 道工序）。` +
      (line.enabled ? '' : ' <b style="color:var(--warn)">这条线今天没有启用</b>，终端不会读它的内容。') +
      (pm
        ? ` 表头上的小字是配置库「${H(pm.name)}」的要求，✓ 表示这套内容达标。`
        : ' 未匹配到配置要求；可在「配置库」为这个机种建一份，矩阵会显示要求与达标情况。');
}

function renderSwitchOptions() {
  const sel = $('switchSel');
  const line = S.lines.find((l) => l.id === S.lineId);
  $('switchLabel').textContent = line ? `换型到 · ${line.name}` : '换型到';

  const enabled = S.models.filter((m) => m.enabled);
  sel.innerHTML = enabled.length
    ? enabled.map((m) =>
        `<option value="${H(m.code)}">${H(modelLabel(m))}${m.id === S.currentId ? ' · 当前' : ''}</option>`
      ).join('')
    : '<option value="">没有可用型号</option>';
  sel.disabled = !enabled.length;
  if (S.pendingCode) sel.value = S.pendingCode;
  else if (S.currentCode) sel.value = S.currentCode;

  // 顶部机种下拉默认跟着"该播的型号"走：打开页面时，人最想看的就是现在在做的那个
  if (!S.modelPick && S.currentCode) {
    S.modelPick = S.currentCode;
    renderModelOptions();
    loadProfileMatch().catch(() => {});
    loadTerminals().catch(() => {});
  }
}

/**
 * 中栏顶部的机种选择器。
 * 「全部机种」是默认项：换型前先横向比一遍各型号配置齐不齐，是工程部最常见的动作。
 */
function renderModelOptions() {
  const sel = $('modelSel');
  const enabled = S.models.filter((m) => m.enabled);
  sel.innerHTML = '<option value="">全部机种</option>' + enabled.map((m) =>
    `<option value="${H(m.code)}">${H(modelLabel(m))}</option>`).join('');
  sel.value = S.modelPick || '';
}

$('modelSel').addEventListener('change', () => {
  S.modelPick = $('modelSel').value;
  // 底部换型下拉跟着走：选中哪个机种，换的就是哪个，避免"上面看 A、下面换 B"
  if (S.modelPick) $('switchSel').value = S.modelPick;
  renderMatrix();
  renderFooter();
  loadProfileMatch().catch((e) => toast(e.message, 'err'));
  loadTerminals().catch(() => {});
});

// ---------- 左侧模块切换 ----------
document.querySelectorAll('.side-item[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.view;
    S.tab = v;
    document.querySelectorAll('.side-item[data-view]').forEach((x) => x.classList.toggle('on', x === b));
    $('view-matrix').classList.toggle('hide', v !== 'matrix');
    $('view-media').classList.toggle('hide', v !== 'media');
    $('view-profiles').classList.toggle('hide', v !== 'profiles');
    if (v === 'matrix') {
      renderLineBar();
      loadTerminals().catch(() => {});
    } else {
      $('lineWarn').classList.add('hide');
    }
    if (v === 'media') loadMedia();
    if (v === 'profiles') loadProfiles();
  });
});

// ---------- 矩阵交互 ----------
$('matrix').addEventListener('click', (e) => {
  const cell = e.target.closest('.cellbtn');
  if (cell) return openDrawer(cell.dataset.mid, cell.dataset.pid);

  const pn = e.target.closest('.pname');
  if (pn) return renameProcess(pn.dataset.pid);
});

async function renameProcess(pid) {
  const p = S.processes.find((x) => x.id === pid);
  if (!p) return;
  const r = await dialog({
    title: '改工序名称',
    message: `工序 ${p.code} 的名称会显示在终端顶栏上，工人靠它确认自己在哪道工序。`,
    fields: [{ key: 'name', label: '名称', value: p.name, placeholder: '例如：上料' }],
    okText: '保存'
  });
  if (!r) return;
  const v = r.name;
  if (!v || v === p.name) return;
  try {
    await api('/api/processes/' + pid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v })
    });
    p.name = v;
    renderMatrix();
    toast('工序名已更新', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

$('addModelBtn').addEventListener('click', async () => {
  const r = await dialog({
    title: '新增型号',
    message: '型号编码是终端的换型依据，建好之后就能在矩阵里给它配内容。',
    fields: [
      { key: 'code', label: '型号编码', placeholder: 'X300', tip: '建议字母+数字，与工艺文件一致' },
      { key: 'name', label: '显示名称', placeholder: '留空则用「X300 型」' }
    ],
    okText: '创建'
  });
  if (!r) return;

  const code = r.code;
  if (!code) return toast('型号编码不能为空', 'err');
  const name = r.name || code + ' 型';

  try {
    await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name })
    });
    await loadAll();
    toast('已新增型号 ' + code, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('refreshBtn').addEventListener('click', async () => {
  try { await loadAll(); toast('已刷新'); } catch (e) { toast(e.message, 'err'); }
});

// ---------- 换型（作用于当前查看的线体） ----------
$('switchBtn').addEventListener('click', async () => {
  const code = $('switchSel').value;
  if (!code) return;
  if (!S.lineId) return toast('先选一条线体', 'err');
  if (code === S.currentCode && S.phase !== 'prepare') {
    toast('当前已经是 ' + code);
    return;
  }
  try {
    const r = await api('/api/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelCode: code, lineId: S.lineId })
    });
    applyState(r.state, true);
    renderMatrix();
    renderSwitchOptions();
    toast(r.activated ? `已切换到 ${code}` : `已下发：各终端开始准备 ${code}`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('cancelSwitchBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/switch/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineId: S.lineId })
    });
    applyState(r.state, true);
    renderMatrix();
    renderSwitchOptions();
    toast('已放弃本次切换，画面保持原型号');
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- 长轮询 ----------
// rev 是全局的，别的线体动一下这里也会醒一次，代价只是多读一次状态，可接受。
async function pollLoop() {
  try {
    const qs = S.lineId ? '&lineId=' + encodeURIComponent(S.lineId) : '';
    const st = await api('/api/state?since=' + S.pollSince + qs);
    S.pollSince = st.rev;
    applyState(st, false);
    if (S.phase === 'prepare') renderSwitchOptions();
  } catch (err) {
    // 服务重启或网络抖动：退避后再试，不在界面上刷红字
    await new Promise((r) => setTimeout(r, 2500));
  }
  setTimeout(pollLoop, 150);
}

// 倒计时每秒刷新（长轮询 25 秒才回一次，不能靠它刷新秒数）
setInterval(() => { if (S.phase === 'prepare') renderPhaseBar(); }, 1000);

// ---------- 抽屉：清单编辑 ----------
async function openDrawer(modelId, processId) {
  const m = S.models.find((x) => x.id === modelId);
  const p = S.processes.find((x) => x.id === processId);
  if (!m || !p) return;

  S.editing = { modelId, processId };
  $('drawerTitle').textContent = `${m.code}　/　${p.code} ${p.name}`;
  $('drawerSub').textContent = `${modelLabel(m)}　这道工序要循环播放的内容`;
  S.items = [];
  S.dirty = false;
  $('items').innerHTML = '<div class="empty">载入中…</div>';
  $('drop').classList.remove('hide');
  $('drawer').classList.add('show');
  $('overlay').classList.add('show');

  try {
    const d = await api(`/api/playlist?modelId=${encodeURIComponent(modelId)}&processId=${encodeURIComponent(processId)}`);
    S.items = d.items.map((it) => ({
      mediaId: it.mediaId, kind: it.kind, name: it.name,
      bytes: it.bytes, url: it.url, dwellSec: it.dwellSec,
      fit: it.fit || 'contain', zoom: it.zoom || 100,
      width: it.width, height: it.height
    }));
    syncReqBox();
    renderItems();
  } catch (err) {
    $('items').innerHTML = `<div class="empty">载入失败：${H(err.message)}</div>`;
  }
}

async function closeDrawer(force) {
  if (S.dirty && !force) {
    const ok = await ask('清单还没保存', '这个工序的改动还没保存，关掉就丢了。确定关闭？', '丢弃改动', true);
    if (!ok) return;
  }
  $('drawer').classList.remove('show');
  $('overlay').classList.remove('show');
  $('libPicker').classList.add('hide');
  S.editing = null;
  S.items = [];
  S.dirty = false;
  updateDirty();
}

$('drawerClose').addEventListener('click', () => closeDrawer());
$('drawerCancel').addEventListener('click', () => closeDrawer());
$('overlay').addEventListener('click', () => closeDrawer());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.editing) closeDrawer();
});

function updateDirty() {
  $('dirtyTag').classList.toggle('show', S.dirty);
  $('saveBtn').disabled = !S.dirty;
}

// ---------- 抽屉里的配置要求 ----------
/**
 * 把「配置库对这道工序的要求」和「当前清单的实际内容」摆在一起。
 *
 * 为什么一定要放在上传框上面：工程部是在这里往上传东西的，
 * 如果要求藏在别的页面，人会按自己的习惯传一堆图，最后校验不通过再返工。
 * 校验结果来自服务端（/api/profiles/match 里的 check），前端不复算 ——
 * 判断"算不算达标"只能有一个地方说了算，否则界面和后台会给出两种结论。
 */
function syncReqBox() {
  const box = $('reqBox');
  S.badItems = new Map();
  if (!S.editing) { box.className = 'reqbox hide'; box.innerHTML = ''; return; }

  const p = S.processes.find((x) => x.id === S.editing.processId);
  const req = p ? reqOf(p.code) : null;
  if (!req) {
    // 没有匹配到配置：不显示要求框。没配置 ≠ 不合格，不能凭空给人压力
    box.className = 'reqbox hide';
    box.innerHTML = '';
    return;
  }

  const chk = p ? chkOf(p.code) : null;
  for (const b of (chk && chk.badItems) || []) S.badItems.set(b.mediaId, b.reason);

  const profile = S.profileMatch && S.profileMatch.profile;
  box.className = 'reqbox';
  box.innerHTML =
    `<b>配置要求</b>　${H(reqSummary(req))}` +
    (req.maxMb ? `　单文件 ≤ ${req.maxMb} MB` : '') +
    (profile ? `　<span style="color:var(--ink3)">来自「${H(profile.name)}」</span>` : '') +
    `<div style="margin-top:5px">${
      !chk ? '' : chk.ok
        ? '<span class="rq-ok">当前清单已达标</span>'
        : '<span class="rq-bad">当前清单未达标</span>'
    }</div>` +
    (chk && chk.issues.length
      ? '<ul>' + chk.issues.map((i) => `<li>${H(i)}</li>`).join('') + '</ul>'
      : '');
}

// ---------- 容量预算 ----------
/**
 * 为什么按"体积"管而不是按"时长"管：
 *   换型时 5 台终端要同时把这一套内容整个下完才开始播（本地没备齐就不许翻画面），
 *   所以决定换型快慢的是**字节数**，不是视频多长。同样 3 分钟的视频，
 *   1Mbps 和 8Mbps 差 8 倍体积，按时长限制等于什么都没管住。
 *
 * 单套 120MB 这个线是这么倒推出来的：
 *   5 台 × 120MB = 600MB，千兆内网实测 25MB/s 共享 → 24 秒；
 *   车间 WiFi 20Mbps（2.5MB/s）→ 4 分钟，仍在 5 分钟窗口内。
 *   超过 120MB 不是不能存，是弱网现场换型可能被 5 分钟强翻。
 */
const BUDGET_BYTES = 120 * 1024 * 1024;
const LINK_FAST = 25 * 1024 * 1024;    // 千兆内网，5 台共享后的实测吞吐
const LINK_SLOW = 2.5 * 1024 * 1024;   // 车间 WiFi 20Mbps，最差但能用的那档

function secsText(bytes, link) {
  const s = Math.ceil((bytes * 5) / link);
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}

function renderBudget() {
  const box = $('budget');
  if (!S.items.length) { box.innerHTML = ''; return; }

  const bytes = S.items.reduce((s, i) => s + i.bytes, 0);
  const pct = Math.round((bytes / BUDGET_BYTES) * 100);
  const cls = bytes > BUDGET_BYTES * 2 ? 'bad' : (bytes > BUDGET_BYTES ? 'warn' : '');
  const tagText = cls === 'bad' ? '体积过大' : (cls === 'warn' ? '超出建议值' : '容量合适');

  box.innerHTML =
    `<span class="nums">合计 <b>${fmtBytes(bytes)}</b>（建议 ≤${fmtBytes(BUDGET_BYTES)}，当前 ${pct}%）</span>
     <span class="nums">预计换型：内网 ${secsText(bytes, LINK_FAST)} / WiFi ${secsText(bytes, LINK_SLOW)}</span>
     <span class="tag ${cls}">${tagText}</span>`;
}

function renderItems() {
  updateDirty();
  renderBudget();
  if (!S.items.length) {
    $('items').innerHTML = '<div class="empty">这套内容还是空的。<br>把作业指导书图片、PDF 或视频拖进上面的框里。</div>';
    $('playHint').textContent = '';
    return;
  }
  const imgs = S.items.filter((i) => i.kind === 'image').length;
  const vids = S.items.filter((i) => i.kind === 'video').length;
  $('playHint').textContent = `共 ${S.items.length} 项（${imgs} 图 / ${vids} 视频），循环播放`;

  $('items').innerHTML = S.items.map((it, i) => {
    const isImg = it.kind === 'image';
    const fit = it.fit === 'cover' ? 'cover' : 'contain';
    const zoom = it.zoom || 100;
    return `
    <div class="item">
      <span class="idx">${i + 1}</span>
      <span class="pic">${isImg
        ? `<img src="${H(it.url)}" alt="">`
        : '<span class="vtxt">视频</span>'}</span>
      <div class="info">
        <div class="n">${H(it.name)}${S.badItems.has(it.mediaId)
          ? ' <span style="color:var(--danger);font-size:11.5px">不符合配置</span>' : ''}</div>
        <div class="m">${isImg ? '图片' : '视频'} · ${fmtBytes(it.bytes)}${
          isImg && it.width ? ` · ${it.width}×${it.height}` : ''}</div>
        ${S.badItems.has(it.mediaId)
          ? `<div class="m" style="color:var(--danger)">⚠ ${H(S.badItems.get(it.mediaId))}</div>` : ''}

        <div class="ctrls">
          ${isImg
            ? `<label class="dwell" title="这张图停留多少秒">停留
                 <input type="number" min="1" max="120" value="${it.dwellSec}" data-dwell="${i}"> 秒</label>
               <select class="minisel" data-fit="${i}" title="铺满会裁掉超出屏幕的部分">
                 <option value="contain"${fit === 'contain' ? ' selected' : ''}>适应 · 不裁</option>
                 <option value="cover"${fit === 'cover' ? ' selected' : ''}>铺满 · 裁边</option>
               </select>
               <label class="dwell" title="放大看小字；超过 100% 会裁掉四周">
                 缩放 <input type="range" min="50" max="200" step="5" value="${zoom}" data-zoom="${i}"
                             style="width:92px;padding:0">
                 <b class="zoomval">${zoom}%</b>
               </label>`
            : `<span class="dwell" style="color:var(--ink3)">播完自动下一项（时长不限）</span>
               <select class="minisel" data-fit="${i}" title="铺满会裁掉超出屏幕的部分">
                 <option value="contain"${fit === 'contain' ? ' selected' : ''}>适应 · 不裁</option>
                 <option value="cover"${fit === 'cover' ? ' selected' : ''}>铺满 · 裁边</option>
               </select>`}
        </div>
      </div>
      <div class="acts">
        <button class="iconbtn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button class="iconbtn" data-down="${i}" ${i === S.items.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button class="iconbtn" data-del="${i}" title="移除">✕</button>
      </div>
    </div>`;
  }).join('');
}

$('items').addEventListener('click', (e) => {
  const t = e.target.closest('[data-up],[data-down],[data-del]');
  if (!t) return;
  if (t.dataset.up !== undefined) {
    const i = +t.dataset.up;
    [S.items[i - 1], S.items[i]] = [S.items[i], S.items[i - 1]];
  } else if (t.dataset.down !== undefined) {
    const i = +t.dataset.down;
    [S.items[i + 1], S.items[i]] = [S.items[i], S.items[i + 1]];
  } else if (t.dataset.del !== undefined) {
    S.items.splice(+t.dataset.del, 1);
  }
  S.dirty = true;
  renderItems();
});

// 缩放滑块是连续拖的：只改数字和状态，不整行重绘 —— 重绘会把手指底下的滑块换掉
$('items').addEventListener('input', (e) => {
  const el = e.target.closest('[data-zoom]');
  if (!el) return;
  const i = +el.dataset.zoom;
  const v = Math.min(200, Math.max(50, parseInt(el.value, 10) || 100));
  S.items[i].zoom = v;
  const label = el.parentElement.querySelector('.zoomval');
  if (label) label.textContent = v + '%';
  S.dirty = true;
  updateDirty();
});

$('items').addEventListener('change', (e) => {
  const fitEl = e.target.closest('[data-fit]');
  if (fitEl) {
    S.items[+fitEl.dataset.fit].fit = fitEl.value === 'cover' ? 'cover' : 'contain';
    S.dirty = true;
    updateDirty();
    return;
  }
  const el = e.target.closest('[data-dwell]');
  if (!el) return;
  const i = +el.dataset.dwell;
  let v = parseInt(el.value, 10);
  if (!Number.isFinite(v)) v = 10;
  v = Math.min(120, Math.max(1, v));
  S.items[i].dwellSec = v;
  S.dirty = true;
  updateDirty();
});

// ---------- 上传 ----------
/**
 * 上传走 XHR 而不是 fetch：只有 XHR 能拿到 upload.onprogress。
 * 现场传的多是十几 MB 的视频和几十页的 PDF，没有进度条人就以为卡死了，
 * 反复点一次 = 重复上传一份，白占半天盘。
 *
 * 注意进度条走完 ≠ 完成：PDF 要在服务端逐页渲染，那段时间显示"处理中"。
 */
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

/** 一个文件一行进度。服务端处理（PDF 拆页）时进度条停在 100% 并写"处理中" */
function uplRow(name) {
  const el = document.createElement('div');
  el.className = 'uplrow';
  el.innerHTML = '<span class="nm"></span><span class="pct">0%</span><span class="pg"><i></i></span>';
  el.querySelector('.nm').textContent = name;
  $('uplList').appendChild(el);
  const bar = el.querySelector('.pg i');
  const pct = el.querySelector('.pct');
  return {
    set(v, text) {
      const p = Math.max(0, Math.min(1, v || 0));
      bar.style.width = (p * 100) + '%';
      pct.textContent = text || Math.round(p * 100) + '%';
    },
    ok(text) { el.classList.add('ok'); bar.style.width = '100%'; pct.textContent = text || '完成'; },
    err(text) { el.classList.add('err'); bar.style.width = '100%'; pct.textContent = text || '失败'; },
    drop() { el.remove(); }
  };
}

/** 往清单尾部加一项。PDF 拆出来的页也走这里，保证 fit/zoom 默认值一致。 */
function pushItem(m, extra) {
  if (S.items.some((x) => x.mediaId === m.id)) return false;
  S.items.push({
    mediaId: m.id,
    kind: m.kind,
    name: m.name,
    bytes: m.bytes,
    url: m.url,
    dwellSec: m.kind === 'image' ? 10 : 0,
    fit: 'contain',
    zoom: 100,
    ...extra
  });
  return true;
}

async function handleFiles(files) {
  if (!S.editing) return;
  const list = [...files];
  if (!list.length) return;
  $('uplList').innerHTML = '';

  for (let i = 0; i < list.length; i++) {
    const row = uplRow(list[i].name);
    try {
      const d = await uploadFile(list[i], (v) => {
        row.set(v, v >= 1 ? '处理中' : Math.round(v * 100) + '%');
      });

      // PDF：服务端已经把每一页渲染成 PNG，这里一次把整份按顺序加进清单
      if (d.kind === 'pdf') {
        let added = 0;
        for (const p of d.pages || []) if (pushItem(p)) added++;
        if (!added) {
          row.ok(`${d.pageCount} 页已在清单`);
          toast(`这一整份 PDF 的 ${d.pageCount} 页都已在清单里`);
        } else {
          S.dirty = true;
          renderItems();
          row.ok(`${d.pageCount} 页`);
          toast(`PDF 已拆成 ${d.pageCount} 页，加入 ${added} 页`, 'ok');
        }
        continue;
      }

      if (d.kind === 'file') { row.err('类型不支持'); toast(`不是图片、视频或 PDF，已跳过：${list[i].name}`, 'err'); continue; }
      if (!pushItem(d)) { row.ok('已在清单'); toast(`已在清单里：${d.name}`); continue; }

      S.dirty = true;
      renderItems();
      row.ok(d.duplicated ? '复用' : '完成');
      if (d.duplicated) toast('库里已有同一文件，直接复用', 'ok');
    } catch (err) {
      row.err('失败');
      toast(err.message, 'err');
    }
  }
  syncReqBox();
  renderItems();
}

$('pickBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

// ---------- 从媒体库选取 ----------
$('pickFromLib').addEventListener('click', async () => {
  if (!S.editing) return;
  $('libPicker').classList.remove('hide');
  $('objList').innerHTML = '<div class="empty">载入中…</div>';
  try {
    const d = await api('/api/media');
    S.libAll = d.media;
    S.objPick = [];
    renderObjList();
  } catch (err) { $('objList').innerHTML = `<div class="empty">${H(err.message)}</div>`; }
});

function renderObjList() {
  const kw = ($('objSearch').value || '').trim().toLowerCase();
  const have = new Set(S.items.map((i) => i.mediaId));
  const list = (S.libAll || []).filter((m) => !kw || m.name.toLowerCase().includes(kw));
  $('objList').innerHTML = list.map((m) => {
    const used = have.has(m.id);
    return `<label style="display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #f2f5fa;${used ? 'opacity:.45' : ''}">
      <input type="checkbox" data-oid="${m.id}" ${used ? 'disabled' : ''} ${S.objPick.includes(m.id) ? 'checked' : ''}>
      <span style="width:38px;height:30px;border-radius:4px;background:#f2f5fa center/cover no-repeat;flex:none;font-size:10px;color:#8b96a8;display:flex;align-items:center;justify-content:center;${m.kind === 'image' ? `background-image:url('${m.url}')` : ''}">${m.kind === 'image' ? '' : '视频'}</span>
      <span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${H(m.name)}${used ? ' · 已在本清单' : ''}</span>
      <span style="font-size:11px;color:#8b96a8">${fmtBytes(m.bytes)}</span>
    </label>`;
  }).join('') || '<div class="empty">媒体库是空的，先去上传。</div>';
}

$('objSearch').addEventListener('input', renderObjList);
$('objList').addEventListener('change', (e) => {
  const el = e.target.closest('[data-oid]');
  if (!el) return;
  const id = el.dataset.oid;
  if (el.checked) { if (!S.objPick.includes(id)) S.objPick.push(id); }
  else S.objPick = S.objPick.filter((x) => x !== id);
});
$('objCancel').addEventListener('click', () => $('libPicker').classList.add('hide'));
$('objAdd').addEventListener('click', () => {
  if (!S.objPick.length) return toast('先勾选要加入的文件');
  let added = 0;
  for (const id of S.objPick) {
    const m = (S.libAll || []).find((x) => x.id === id);
    if (m && pushItem(m)) added++;
  }
  S.dirty = true;
  S.objPick = [];
  $('libPicker').classList.add('hide');
  renderItems();
  toast(`已加入 ${added} 项，别忘了保存`, 'ok');
});

// ---------- 保存 ----------
$('saveBtn').addEventListener('click', async () => {
  if (!S.editing) return;
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const r = await api('/api/playlist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: S.editing.modelId,
        processId: S.editing.processId,
        items: S.items.map((it) => ({
          mediaId: it.mediaId,
          dwellSec: it.dwellSec,
          fit: it.fit || 'contain',
          zoom: it.zoom || 100
        }))
      })
    });
    S.dirty = false;
    updateDirty();
    await refreshCoverage();
    // 内容变了，配置校验结果也变了：重算一次，抽屉里的要求框和矩阵表头的 ✓/✕ 才同步
    await loadProfileMatch().catch(() => {});
    syncReqBox();
    renderItems();
    toast(`已保存 ${r.count} 项`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.textContent = '保存清单';
    btn.disabled = !S.dirty;
  }
});

async function refreshCoverage() {
  const m = await api('/api/models');
  S.models = m.models;
  S.coverage = m.coverage;
  renderMatrix();
  renderSwitchOptions();
}

// ---------- 媒体库页 ----------
async function loadMedia() {
  const kw = ($('mediaSearch').value || '').trim();
  const kind = $('mediaKind').value;
  const qs = new URLSearchParams();
  if (kw) qs.set('q', kw);
  if (kind) qs.set('kind', kind);
  try {
    const d = await api('/api/media?' + qs.toString());
    $('mediaTxt').textContent = `${d.stats.count} 个文件 · ${fmtBytes(d.stats.bytes)}`;
    $('mediagrid').innerHTML = d.media.map((m) => `
      <div class="mediacard">
        <div class="thumb">${m.kind === 'image'
          ? `<img src="${H(m.url)}" loading="lazy" alt="">`
          : '视频'}</div>
        <div class="meta">
          <div class="t" title="${H(m.name)}">${H(m.name)}</div>
          <div class="s">${fmtBytes(m.bytes)}${m.width ? ` · ${m.width}×${m.height}` : ''} · 被引用 <b>${m.used}</b> 次</div>
        </div>
      </div>
    `).join('') || '<div class="empty" style="grid-column:1/-1">媒体库是空的。点右上角"上传文件"，或在矩阵里编辑清单时直接拖进去。</div>';
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
  inp.accept = 'image/*,video/*';
  inp.onchange = async () => {
    for (const f of inp.files) {
      try { const d = await uploadFile(f); toast(`已上传 ${d.name}${d.duplicated ? '（已存在）' : ''}`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }
    loadMedia();
  };
  inp.click();
});

$('gcBtn').addEventListener('click', async () => {
  try {
    const dry = await api('/api/media/gc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    });
    if (!dry.total) return toast('没有未引用的文件，不用清理', 'ok');
    const names = dry.list.slice(0, 8).map((x) => x.name).join('、');
    const ok = await ask(
      '清理未引用文件',
      `有 ${dry.total} 个文件没有被任何清单引用，共 ${fmtBytes(dry.bytes)}：\n` +
      `${names}${dry.total > 8 ? ' …' : ''}\n\n删除后不可恢复，确定删除？`,
      '删除',
      true
    );
    if (!ok) return;
    const r = await api('/api/media/gc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: false })
    });
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

// ---------- 配置库 ----------
/**
 * 配置库回答「这个产品该怎么做」，三层结构：
 *   配置档案（绑哪个机种、在哪几条线做）
 *     └ 工序要求（要做几道、每道叫什么）
 *         └ 类型要求（每类文件至少几份、图片最小分辨率、单文件上限）
 *
 * 与「线体内容」的关系必须分清楚，否则会被当成两份数据：
 *   配置库 = 应该有什么（模板 / 检查表，可以有多份，按产品区分）
 *   线体内容 = 实际有什么（item 表，按 线体工序 × 机种 存）
 * 配置库从不复制内容，也不参与下发到终端。它只做两件事：
 *   「应用到线体」按档案对齐线的工序清单；「校验」拿档案去量实际内容缺什么。
 * 所以改档案绝不会影响正在播的内容 —— 模板被改坏不该让产线黑屏。
 */

/** 编辑区是否已载入某份档案 */
function pfReady() {
  return !!S.pf;
}

function markPfDirty() {
  S.pfDirty = true;
  $('pfSaveBtn').disabled = false;
  $('pfSub').textContent = '有改动未保存';
}

async function loadProfiles(selectId) {
  let r;
  try {
    r = await api('/api/profiles');
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  S.profiles = r.profiles || [];
  const keep = selectId || (S.pf && S.pf.id);
  const hit = S.profiles.find((x) => x.id === keep) || S.profiles[0] || null;
  // 深拷贝：编辑区改的是副本，点"保存"才提交。否则改一半关掉页面，纸上和库里都不一样了
  S.pf = hit ? JSON.parse(JSON.stringify(hit)) : null;
  S.pfDirty = false;
  renderPf();
}

function renderPf() {
  const pick = $('pfPick');
  pick.innerHTML = S.profiles.length
    ? S.profiles.map((x) => `<option value="${H(x.id)}">${H(x.name)}（${H(x.code)}）</option>`).join('')
    : '<option value="">（还没有配置档案）</option>';

  const has = pfReady();
  if (has) pick.value = S.pf.id;

  ['pfCode', 'pfName', 'pfModel', 'pfNote'].forEach((id) => { $(id).disabled = !has; });
  $('pfSaveBtn').disabled = !has || !S.pfDirty;
  $('pfDelBtn').disabled = !has;
  $('pfApplyBtn').disabled = !has;
  $('pfCheckBtn').disabled = !has;

  // 关联机种下拉
  const mdl = $('pfModel');
  mdl.innerHTML = '<option value="">（不关联，通用档案）</option>' + S.models.map((m) =>
    `<option value="${H(m.id)}">${H(modelLabel(m))}</option>`).join('');

  if (!has) {
    $('pfSub').textContent = '还没有配置档案，点「+ 新建配置」起一份';
    $('pfCode').value = '';
    $('pfName').value = '';
    $('pfNote').value = '';
    $('pfLines').innerHTML = '<span class="dim" style="font-size:12px">—</span>';
    $('pfSteps').innerHTML = '<div class="sub" style="padding:8px 0">还没有工序要求</div>';
    return;
  }

  $('pfSub').textContent = S.pf.steps.length
    ? `${S.pf.steps.length} 道工序　${S.pf.lineCodes.length ? '仅用于 ' + S.pf.lineCodes.join('、') : '适用于所有线体'}`
    : '还没有工序要求';
  $('pfCode').value = S.pf.code;
  $('pfName').value = S.pf.name;
  $('pfModel').value = S.pf.modelId || '';
  $('pfNote').value = S.pf.note || '';

  // 适用线体：勾了就是"只在这几条线上用"，全不勾 = 所有线体
  $('pfLines').innerHTML = S.lines.map((l) => {
    const on = S.pf.lineCodes.includes(l.code);
    return `<label class="pf-line ${on ? 'sel' : ''}">
      <input type="checkbox" value="${H(l.code)}" ${on ? 'checked' : ''}>${H(l.name)}</label>`;
  }).join('') || '<span class="dim" style="font-size:12px">还没有线体</span>';

  renderPfSteps();
}

/** 一格类型要求：勾选 = 允许，数字 = 至少几份；图片多一组最小分辨率 */
function kindCell(step, kind, label, withRes) {
  const req = (step.reqs || []).find((r) => r.kind === kind);
  const on = !!req;
  const n = on ? (req.minCount || 0) : 0;
  const w = on ? (req.minWidth || 0) : 0;
  const h = on ? (req.minHeight || 0) : 0;
  return `<div class="pf-kind">
    <div class="krow">
      <label><input type="checkbox" data-k="${kind}" ${on ? 'checked' : ''}>${label}</label>
      <input class="knum" type="number" min="0" max="99" data-kn="${kind}" value="${n}"
             ${on ? '' : 'disabled'} title="至少几份">
    </div>
    ${withRes
      ? `<div class="kres">≥<input type="number" data-kw="${kind}" value="${w || ''}" placeholder="宽" ${on ? '' : 'disabled'}>`
        + `×<input type="number" data-kh="${kind}" value="${h || ''}" placeholder="高" ${on ? '' : 'disabled'}></div>`
      : '<div class="kres"></div>'}
  </div>`;
}

function renderPfSteps() {
  if (!pfReady()) return;
  const head = `<div class="pf-step head">
      <span>顺序</span><span>工序码</span><span>工序名</span>
      <span>图片 · 份数</span><span>视频 · 份数</span><span>PDF · 份数</span>
      <span>单文件≤MB</span><span>备注</span><span></span>
    </div>`;
  const rows = S.pf.steps.map((st, i) => `<div class="pf-step" data-i="${i}">
      <input type="number" data-f="seq" value="${Number(st.seq) || (i + 1) * 10}" min="0" max="999" title="顺序，决定 OP 编号排位">
      <input type="text" data-f="code" value="${H(st.code)}" placeholder="OP10">
      <input type="text" data-f="name" value="${H(st.name)}" placeholder="上料">
      ${kindCell(st, 'image', '图', true)}
      ${kindCell(st, 'video', '视', false)}
      ${kindCell(st, 'pdf', 'PDF', false)}
      <input type="number" data-f="maxMb" value="${Number(st.maxMb) || 0}" min="0" max="9999" title="0 = 不限">
      <input type="text" data-f="note" value="${H(st.note || '')}" placeholder="给现场的要求说明">
      <button class="pf-delstep" title="删掉这道工序的要求">✕</button>
    </div>`).join('');

  $('pfSteps').innerHTML = head + (rows || '<div class="sub" style="padding:8px 0">还没有工序要求，点下面「+ 添加工序」</div>');
}

/** 把编辑区的临时状态收成接口要的形状 */
function pfBody() {
  const lineCodes = [...$('pfLines').querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
  return {
    code: $('pfCode').value.trim(),
    name: $('pfName').value.trim(),
    modelId: $('pfModel').value,
    lineCodes: lineCodes.join(','),
    note: $('pfNote').value.trim(),
    steps: S.pf.steps.map((st, i) => ({
      seq: Number(st.seq) || (i + 1) * 10,
      code: String(st.code || '').trim().toUpperCase(),
      name: String(st.name || '').trim(),
      maxMb: Number(st.maxMb) || 0,
      note: st.note || '',
      reqs: (st.reqs || []).map((r) => ({
        kind: r.kind,
        minCount: Number(r.minCount) || 0,
        minWidth: Number(r.minWidth) || 0,
        minHeight: Number(r.minHeight) || 0
      }))
    }))
  };
}

function onPfStep(e) {
  const row = e.target.closest('.pf-step');
  if (!row || row.dataset.i === undefined || !pfReady()) return;
  const st = S.pf.steps[Number(row.dataset.i)];
  if (!st) return;
  const t = e.target;

  if (t.dataset.f) {
    const f = t.dataset.f;
    st[f] = (f === 'seq' || f === 'maxMb') ? Math.max(0, Number(t.value) || 0) : t.value;
    markPfDirty();
    return;
  }

  const kind = t.dataset.k || t.dataset.kn || t.dataset.kw || t.dataset.kh;
  if (!kind) return;
  st.reqs = st.reqs || [];

  if (t.dataset.k) {
    if (t.checked) {
      if (!st.reqs.some((r) => r.kind === kind)) {
        st.reqs.push({
          kind, minCount: 1,
          minWidth: kind === 'image' ? 1280 : 0,
          minHeight: kind === 'image' ? 720 : 0
        });
      }
    } else {
      st.reqs = st.reqs.filter((r) => r.kind !== kind);
    }
    markPfDirty();
    renderPfSteps();   // 勾/去勾要联动数字框能不能填，只能重画这一块
    return;
  }

  const req = st.reqs.find((r) => r.kind === kind);
  if (!req) return;
  const v = Math.max(0, Number(t.value) || 0);
  if (t.dataset.kn) req.minCount = v;
  if (t.dataset.kw) req.minWidth = v;
  if (t.dataset.kh) req.minHeight = v;
  markPfDirty();
}

$('pfSteps').addEventListener('input', onPfStep);
$('pfSteps').addEventListener('change', onPfStep);

$('pfSteps').addEventListener('click', (e) => {
  if (!e.target.closest('.pf-delstep') || !pfReady()) return;
  const row = e.target.closest('.pf-step');
  S.pf.steps.splice(Number(row.dataset.i), 1);
  markPfDirty();
  renderPfSteps();
});

$('pfAddStep').addEventListener('click', () => {
  if (!pfReady()) return;
  const n = S.pf.steps.length;
  S.pf.steps.push({
    seq: (n + 1) * 10,
    code: 'OP' + String((n + 1) * 10),
    name: '',
    maxMb: 20,
    note: '',
    // 新工序默认只允许图片、至少 1 张：这是现场最常见的起点，视频/PDF 按需勾
    reqs: [{ kind: 'image', minCount: 1, minWidth: 1280, minHeight: 720 }]
  });
  markPfDirty();
  renderPfSteps();
});

$('pfPick').addEventListener('change', async () => {
  if (S.pfDirty) {
    const ok = await ask('有未保存的改动', '切换配置档案会丢掉当前未保存的修改。继续？', '丢弃并切换', true);
    if (!ok) { $('pfPick').value = pfReady() ? S.pf.id : ''; return; }
  }
  await loadProfiles($('pfPick').value);
});

['pfCode', 'pfName', 'pfNote'].forEach((id) => {
  $(id).addEventListener('input', () => {
    if (!pfReady()) return;
    S.pf[id === 'pfCode' ? 'code' : (id === 'pfName' ? 'name' : 'note')] = $(id).value;
    markPfDirty();
  });
});

$('pfModel').addEventListener('change', () => {
  if (!pfReady()) return;
  S.pf.modelId = $('pfModel').value;
  markPfDirty();
});

$('pfLines').addEventListener('change', (e) => {
  if (!pfReady() || e.target.type !== 'checkbox') return;
  const codes = [...$('pfLines').querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
  S.pf.lineCodes = codes;
  for (const lab of $('pfLines').querySelectorAll('.pf-line')) {
    lab.classList.toggle('sel', lab.querySelector('input').checked);
  }
  markPfDirty();
});

$('pfNewBtn').addEventListener('click', async () => {
  const r = await dialog({
    title: '新建配置',
    message: '一份配置 = 一个产品的工艺：几道工序、每道要交什么。建好可以「应用到线体」，把线体的工序数对齐过来。',
    fields: [
      { key: 'code', label: '配置编码', placeholder: 'P-X300', tip: '建议带上机种号：编码或名称里有机种号时，矩阵会自动匹配上它' },
      { key: 'name', label: '配置名称', placeholder: 'X300 工艺配置' }
    ],
    okText: '创建'
  });
  if (!r) return;
  if (!r.code) return toast('配置编码不能为空', 'err');

  // 默认照当前线体的工序起一份，省得从零填
  const steps = S.processes.map((p, i) => ({
    seq: p.sort || (i + 1) * 10,
    code: p.code,
    name: p.name,
    maxMb: 20,
    note: '',
    reqs: [{ kind: 'image', minCount: 1, minWidth: 1280, minHeight: 720 }]
  }));

  try {
    const made = await api('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: r.code, name: r.name || r.code, steps })
    });
    await loadProfiles(made.id);
    toast('已新建配置 ' + made.name, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('pfSaveBtn').addEventListener('click', async () => {
  if (!pfReady()) return;
  const body = pfBody();
  if (!body.code) return toast('配置编码不能为空', 'err');
  if (!body.name) return toast('配置名称不能为空', 'err');
  if (body.steps.some((x) => !x.code)) return toast('有工序没填工序码', 'err');
  const seen = new Set();
  for (const st of body.steps) {
    if (seen.has(st.code)) return toast('工序码重复：' + st.code, 'err');
    seen.add(st.code);
  }

  const btn = $('pfSaveBtn');
  btn.disabled = true;
  try {
    await api('/api/profiles/' + encodeURIComponent(S.pf.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    toast('已保存配置', 'ok');
    await loadProfiles(S.pf.id);
    // 保存后矩阵表头的 ✓/✕ 要跟着变；抽屉如果开着也重算一次
    await loadProfileMatch().catch(() => {});
    if (S.editing) { syncReqBox(); renderItems(); }
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
  }
});

$('pfDelBtn').addEventListener('click', async () => {
  if (!pfReady()) return;
  const ok = await ask(`删除配置「${S.pf.name}」？`,
    '只删这份配置档案（模板）。线体上的工序和已经填好的播放内容都不会动。', '删除', true);
  if (!ok) return;
  try {
    await api('/api/profiles/' + encodeURIComponent(S.pf.id), { method: 'DELETE' });
    toast('已删除', 'ok');
    S.pf = null;
    await loadProfiles();
    await loadProfileMatch().catch(() => {});
  } catch (e) { toast(e.message, 'err'); }
});

/* 应用前把话说明白：会补哪些工序、改哪些名字、会不会删东西。
   这一步是配置库唯一会动线体数据的地方，不能让人点完才知道发生了什么。 */
$('pfApplyBtn').addEventListener('click', async () => {
  if (!pfReady()) return;
  if (!S.pf.steps.length) return toast('这份配置还没有工序要求', 'err');

  const html = '<div class="linepick">' + S.lines.map((l) => `
    <label class="linepick-row">
      <input type="radio" name="pfapplyline" value="${H(l.id)}" ${l.id === S.lineId ? 'checked' : ''}>
      <span class="lp-name">${H(l.name)}<small>${H(l.code)}</small></span>
      <span class="lp-meta">现有 ${l.processes} 道工序 · 已配 ${l.coverage.done}/${l.coverage.total}</span>
    </label>`).join('') + '</div>'
    + `<label class="pf-line" style="margin-top:12px;display:inline-flex">
         <input type="checkbox" id="pfPrune"> 顺便删掉"配置外且没有内容"的工序</label>
       <div class="tip" style="color:var(--ink3);font-size:12px;margin-top:6px">
         不勾就只补/改，绝不删。勾了也只删空工序，有播放内容的永远保留。</div>`;

  const r = await dialog({
    title: '把配置应用到线体',
    message: `按「${S.pf.name}」的 ${S.pf.steps.length} 道工序对齐所选线体：缺的补上，同工序码的改名字和顺序。`,
    html,
    read: (body) => {
      const pick = body.querySelector('input[name=pfapplyline]:checked');
      return { lineId: pick ? pick.value : '', prune: !!body.querySelector('#pfPrune:checked') };
    },
    okText: '应用'
  });
  if (!r) return;
  if (!r.lineId) return toast('请先选一条线体', 'err');

  try {
    const out = await api('/api/profiles/' + encodeURIComponent(S.pf.id) + '/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r)
    });

    const li = (arr, fn) => arr.map((x) => `<li>${fn(x)}</li>`).join('');
    let h = `<div class="chk-sum"><span class="big">${out.processes}</span><span>道工序（${H(out.lineName)}）</span></div>`;
    if (out.created.length) h += `<div class="chk-row"><span class="code good">新增</span><div><ul style="color:var(--ok)">`
      + li(out.created, (x) => `${H(x.code)} ${H(x.name)}`) + '</ul></div></div>';
    if (out.updated.length) h += `<div class="chk-row"><span class="code">改名</span><div><ul style="color:var(--ink2)">`
      + li(out.updated, (x) => `${H(x.code)}　${H(x.from)} → ${H(x.to)}`) + '</ul></div></div>';
    if (out.removed.length) h += `<div class="chk-row"><span class="code">删除</span><div><ul>`
      + li(out.removed, (x) => `${H(x.code)} ${H(x.name)}`) + '</ul></div></div>';
    if (out.kept.length) h += `<div class="chk-row"><span class="code" style="color:var(--ink3)">保留</span><div><ul style="color:var(--ink3)">`
      + li(out.kept, (x) => `${H(x.code)} ${H(x.name)}（${H(x.reason)}）`) + '</ul></div></div>';
    if (!out.created.length && !out.updated.length && !out.removed.length) {
      h += '<p style="color:var(--ok)">线体上的工序已经和配置一致，不需要改动。</p>';
    }

    await dialog({ title: '应用完成', html: h, okText: '知道了', hideCancel: true });
    await loadAll();
  } catch (e) {
    toast(e.message, 'err');
  }
});

$('pfCheckBtn').addEventListener('click', async () => {
  if (!pfReady()) return;

  const html =
    `<div class="dlg-row"><label>查哪条线体</label><select id="chkLine">`
    + S.lines.map((l) => `<option value="${H(l.code)}" ${l.id === S.lineId ? 'selected' : ''}>${H(l.name)}</option>`).join('')
    + `</select></div>`
    + `<div class="dlg-row"><label>查哪个机种</label><select id="chkModel">`
    + S.models.map((m) => `<option value="${H(m.code)}" ${m.code === (S.modelPick || S.currentCode) ? 'selected' : ''}>${H(modelLabel(m))}</option>`).join('')
    + `</select></div>`
    + `<div class="tip" style="color:var(--ink3);font-size:12px">只检查，不改任何内容。</div>`;

  const r = await dialog({
    title: '校验现状',
    message: '拿这份配置去量实际内容：哪道工序缺什么、有几项不符合规格。',
    html,
    read: (body) => ({
      lineCode: body.querySelector('#chkLine').value,
      modelCode: body.querySelector('#chkModel').value
    }),
    okText: '开始校验'
  });
  if (!r) return;
  if (!r.modelCode) return toast('还没有机种可选', 'err');

  try {
    const c = await api(`/api/profiles/${encodeURIComponent(S.pf.id)}/check`
      + `?lineCode=${encodeURIComponent(r.lineCode)}&modelCode=${encodeURIComponent(r.modelCode)}`);
    const rows = c.steps.map((st) => `<div class="chk-row">
        <span class="code">${H(st.code)}</span>
        <div>${H(st.name)}　<span style="color:var(--ink3);font-size:12px">${
          st.exists ? `${st.count} 项（图 ${st.actual.image} / 视 ${st.actual.video} / PDF ${st.actual.pdf}）` : '线体上还没有这道工序'
        }</span>
        ${st.ok ? '<div class="good">✓ 达标</div>'
          : `<ul>${st.issues.map((i) => `<li>${H(i)}</li>`).join('')}</ul>`}
        </div>
      </div>`).join('');

    await dialog({
      title: `校验结果 · ${c.modelCode}`,
      html: `<div class="chk-sum">
          <span class="big ${c.ok ? 'ok' : 'bad'}">${c.summary.passed}/${c.summary.total}</span>
          <span>道工序达标</span>
          <span style="color:var(--ink3);font-size:12px">配置「${H(S.pf.name)}」· 线体 ${H(r.lineCode)}</span>
        </div>` + rows,
      okText: '知道了',
      hideCancel: true
    });
  } catch (e) { toast(e.message, 'err'); }
});

// ---------- 桌面程序：系统面板 ----------
// 同一份界面服务两种场景：浏览器管理页（历史用法，还能远程排障）、
// 桌面程序（现场双击 exe 用）。window.vwiDesktop 只在桌面程序里存在，
// 所以下面整块在浏览器里等于空操作，不需要维护两份界面。
const desk = window.vwiDesktop;
let sysInfo = null;

if (desk) {
  document.body.classList.add('is-desktop');

  const modal = $('sysModal');

  const openSys = () => {
    modal.classList.add('on');
    desk.info().then((info) => {
      sysInfo = info;
      $('sysVer').textContent = 'v' + info.version;
      $('sysPort').textContent = info.port;
      $('sysData').textContent = info.dataDir;
      $('sysData').title = info.dataDir;
      $('sysLog').textContent = info.logFile;
      $('sysLog').title = info.logFile;
      $('sysAuto').checked = !!info.autoStart;
      $('sysAutoTxt').textContent = info.autoStart ? '已开启' : '已关闭';

      // 开发模式（直接跑 electron .）下不能写开机自启：那会把 electron.exe 注册进去。
      // 界面直接把开关锁掉，别让人以为能设。
      if (info.dev) {
        $('sysAuto').disabled = true;
        $('sysAutoTxt').textContent = '仅打包后可用（当前为开发模式）';
      }

      // 终端装机要填的地址。这里把 127.0.0.1 单独拎出来提醒别填错 ——
      // 那是服务端自己看到的地址，填到别的机器上必然连不上。
      // 服务端已经把虚拟网卡（Hyper-V / VMware / WSL）排到后面了，界面再把网卡名
      // 标出来，现场照着「以太网 3」这种名字核对，比对着纯 IP 猜靠谱。
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
    });
  };

  const closeSys = () => modal.classList.remove('on');

  $('sysBtn').addEventListener('click', () => (modal.classList.contains('on') ? closeSys() : openSys()));
  $('sysClose').addEventListener('click', closeSys);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSys(); });

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

  $('sysHide').addEventListener('click', () => { closeSys(); desk.hide(); });

  $('sysQuit').addEventListener('click', async () => {
    const n = S.online.length;
    closeSys();
    if (n > 0) {
      const ok = await ask(
        '终端还在线',
        '还有 ' + n + ' 台终端在线（' + S.online.join('、') + '）。\n\n' +
        '退出会中断它们的播放，等于整线停产。确定要退出吗？',
        '仍然退出',
        true
      );
      if (!ok) return;
    }
    desk.quit();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('on')) closeSys();
  });

  desk.info().then((info) => {
    sysInfo = info;
    $('verTxt').textContent = info.version;
    document.title = 'ESOP 服务端 v' + info.version;
  });

  // 主进程每 5 秒推一次状态给托盘用。界面这边刻意不接：
  // pollLoop() 的长轮询本来就在实时刷新在线数，再叠一路只会互相覆盖状态。
}

// ---------- 启动 ----------
(async function boot() {
  try {
    await loadAll();
    pollLoop();
  } catch (err) {
    toast('连接服务端失败：' + err.message, 'err');
  }
})();

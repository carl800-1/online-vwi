// 管理端逻辑：内容矩阵 + 清单编辑 + 换型
// 无框架、无构建，浏览器直接跑。所有状态都在内存，一次刷新从服务端重建。

const H = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const $ = (id) => document.getElementById(id);

const S = {
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
 * @returns {Promise<null|true|Object>} 取消返回 null；无字段返回 true；有字段返回 { key: 值 }
 */
function dialog({ title, message = '', fields = [], okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML =
      (message ? `<div class="dlg-msg" style="margin-bottom:14px">${H(message)}</div>` : '') +
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
async function loadAll() {
  const [m, p, st] = await Promise.all([
    api('/api/models'), api('/api/processes'), api('/api/status')
  ]);
  S.models = m.models;
  S.coverage = m.coverage;
  S.processes = p.processes;
  applyState(st, true);
  renderMatrix();
  renderSwitchOptions();
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

  $('curTxt').textContent = S.currentCode || '未指定';
  $('onlineTxt').textContent = S.online.length;
  $('dot').classList.toggle('on', S.online.length > 0);

  renderPhaseBar();
  if (changed && !quiet) {
    // 型号变了：矩阵里的"当前"高亮要跟着动
    renderMatrix();
  }
}

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

// ---------- 矩阵 ----------
function renderMatrix() {
  const thead = $('matrix').querySelector('thead');
  const tbody = $('matrix').querySelector('tbody');

  thead.innerHTML = '<tr>' +
    '<th style="width:186px">型号</th>' +
    S.processes.map((p) =>
      `<th><span class="pname" data-pid="${p.id}" title="点击改名">${H(p.code)}<small>${H(p.name)}</small> ✎</span></th>`
    ).join('') +
    '<th style="width:112px">完成度</th></tr>';

  let done = 0, total = 0;
  tbody.innerHTML = S.models.map((m) => {
    done += m.done; total += m.total;
    const cells = S.processes.map((p) => {
      const n = m.cells[p.id] || 0;
      return `<td class="cell">
        <button class="cellbtn ${n ? 'has' : ''}"
                data-mid="${m.id}" data-pid="${p.id}">
          <span class="n">${n ? n + ' 项' : '未配置'}</span>
          <span class="k">${n ? '点击编辑' : '点击添加内容'}</span>
        </button>
      </td>`;
    }).join('');

    const pct = m.total ? Math.round(m.done / m.total * 100) : 0;
    return `<tr class="${m.id === S.currentId ? 'row-cur' : ''}">
      <td class="model">
        <span class="code">${H(m.code)}</span>
        ${m.name && !m.name.toLowerCase().includes((m.code || '').toLowerCase())
          ? '<span class="nm">' + H(m.name) + '</span>' : ''}
        ${m.id === S.currentId ? '<span class="now-tag">当前</span>' : ''}
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
}

function renderSwitchOptions() {
  const sel = $('switchSel');
  const enabled = S.models.filter((m) => m.enabled);
  sel.innerHTML = enabled.map((m) =>
    `<option value="${H(m.code)}">${H(modelLabel(m))}${m.id === S.currentId ? ' · 当前' : ''}</option>`
  ).join('');
  if (S.pendingCode) sel.value = S.pendingCode;
  else if (S.currentCode) sel.value = S.currentCode;
}

// ---------- 左侧模块切换 ----------
document.querySelectorAll('.side-item[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.view;
    S.tab = v;
    document.querySelectorAll('.side-item[data-view]').forEach((x) => x.classList.toggle('on', x === b));
    $('view-matrix').classList.toggle('hide', v !== 'matrix');
    $('view-media').classList.toggle('hide', v !== 'media');
    if (v === 'media') loadMedia();
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

// ---------- 换型 ----------
$('switchBtn').addEventListener('click', async () => {
  const code = $('switchSel').value;
  if (!code) return;
  if (code === S.currentCode && S.phase !== 'prepare') {
    toast('当前已经是 ' + code);
    return;
  }
  try {
    const r = await api('/api/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelCode: code })
    });
    applyState(r.state, true);
    renderMatrix();
    renderSwitchOptions();
    toast(r.activated ? `已切换到 ${code}` : `已下发：各终端开始准备 ${code}`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('cancelSwitchBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/switch/cancel', { method: 'POST' });
    applyState(r.state, true);
    renderMatrix();
    renderSwitchOptions();
    toast('已放弃本次切换，画面保持原型号');
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- 长轮询 ----------
async function pollLoop() {
  try {
    const st = await api('/api/state?since=' + S.pollSince);
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
        <div class="n">${H(it.name)}</div>
        <div class="m">${isImg ? '图片' : '视频'} · ${fmtBytes(it.bytes)}${
          isImg && it.width ? ` · ${it.width}×${it.height}` : ''}</div>

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
async function uploadFile(file) {
  const r = await fetch('/api/media/upload?filename=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch { d = { error: text }; }
  if (!r.ok) throw new Error(d.error || ('上传失败 HTTP ' + r.status));
  return d;
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
  const drop = $('drop');
  const old = drop.innerHTML;

  for (let i = 0; i < list.length; i++) {
    drop.innerHTML = `<div><b>正在上传 ${i + 1}/${list.length}</b>　${H(list[i].name)}</div>
      <div class="hint">PDF 要按页渲染，大视频会比较慢 —— 都别关页面</div>`;
    try {
      const d = await uploadFile(list[i]);

      // PDF：服务端已经把每一页渲染成 PNG，这里一次把整份按顺序加进清单
      if (d.kind === 'pdf') {
        let added = 0;
        for (const p of d.pages || []) if (pushItem(p)) added++;
        if (!added) {
          toast(`这一整份 PDF 的 ${d.pageCount} 页都已在清单里`);
        } else {
          S.dirty = true;
          renderItems();
          toast(`PDF 已拆成 ${d.pageCount} 页，加入 ${added} 页`, 'ok');
        }
        continue;
      }

      if (d.kind === 'file') { toast(`不是图片、视频或 PDF，已跳过：${list[i].name}`, 'err'); continue; }
      if (!pushItem(d)) { toast(`已在清单里：${d.name}`); continue; }

      S.dirty = true;
      renderItems();
      if (d.duplicated) toast('库里已有同一文件，直接复用', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  drop.innerHTML = old;
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
    document.title = '在线VWI服务端 v' + info.version;
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

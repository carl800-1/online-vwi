// 线体状态与内容分发。
//
// 站头主机只做一件事：把内容推到线上的屏。所以这里只剩三样东西 ——
//   ① 在线表：谁连着、报的哪道工序、在播什么（内存，不落库，重启丢了下一次心跳补回来）
//   ② 线体状态：这条线正在生产哪个机种（line_state，落库）
//   ③ 长轮询：内容或机种一变就把挂起的请求叫醒，屏据此立刻来拉新清单
//
// 两个计数器，别混：
//   seq  业务语义，换机种时 +1 —— 终端用它判断"该翻页了"
//   rev  通信语义，全局单调，任何要通知终端的变化都 +1，长轮询用 since=rev 判断有没有新信息
//   contentRev  内容版本，只表达"内容变了"，终端据此决定要不要重新下载
//
// 5.0.1 删掉了换型两段式（prepare / 举手 / 集齐才翻 / 5 分钟强切）：
// 现在点「推送」= setCurrentModel，落库即生效，屏下一轮（≤25 秒、通常 0.1 秒）就换内容。
// 屏网速慢就先播着旧的，下完自己翻 —— 不再有人等齐、也不再有人卡在"准备中"。
import { q, tx, getSetting, setSetting } from './db.js';

const WAIT_TIMEOUT_MS = 25_000;      // 长轮询挂起上限
const ONLINE_TTL_MS = 60_000;        // 多久没请求算离线
// 离线之后还留多久的档案：管理端要显示「12 分钟前在线」，
// 立刻抹掉就只剩一个空格子，运维看不出"这台机器从来没装过"还是"刚关机"。
const KEEP_MS = 30 * 60_000;

// 在线表：key "lineId|op" -> 终端档案
//   { at, ip, res, ver, free, done, total, modelCode, status }
const online = new Map();
const waiters = new Set();  // { resolve, timer }

let rev = 0;
let contentRev = 0;

const keyOf = (lineId, op) => `${lineId}|${op}`;

// ---------- 初始化 ----------
export function initSwitch() {
  rev = Number(getSetting('rev', '0')) || 0;
  contentRev = Number(getSetting('content_rev', '0')) || 0;

  // 定期清掉过期档案：60 秒算离线，30 分钟彻底删除，避免"早关机的屏"永久占着内存
  setInterval(() => {
    const drop = Date.now() - KEEP_MS;
    for (const [k, t] of online) if (!t || !t.at || t.at < drop) online.delete(k);
  }, 15_000).unref();
}

function onlineOps(lineId) {
  const cut = Date.now() - ONLINE_TTL_MS;
  const prefix = lineId + '|';
  const out = [];
  for (const [k, t] of online) {
    if (t && t.at > cut && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

/** 某条线体下的全部终端档案（含刚离线的） */
export function terminalsOf(lineId) {
  const now = Date.now();
  const prefix = lineId + '|';
  const out = [];
  for (const [k, t] of online) {
    if (!k.startsWith(prefix) || !t) continue;
    const ageMs = Math.max(0, now - (t.at || 0));
    out.push({
      op: k.slice(prefix.length),
      online: ageMs <= ONLINE_TTL_MS,
      ageMs,
      ip: t.ip || '',
      res: t.res || '',
      ver: t.ver || '',
      free: Number(t.free) || 0,
      done: Number(t.done) || 0,
      total: Number(t.total) || 0,
      modelCode: t.modelCode || '',
      status: t.status || ''
    });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

// ---------- 线体状态 ----------
function lineRow(lineId) {
  const row = q.get('SELECT * FROM line_state WHERE line_id = ?', lineId);
  if (row) return row;
  q.run('INSERT OR IGNORE INTO line_state(line_id) VALUES(?)', lineId);
  return q.get('SELECT * FROM line_state WHERE line_id = ?', lineId);
}

function patchLineState(lineId, patch) {
  lineRow(lineId);
  const set = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  q.run(`UPDATE line_state SET ${set} WHERE line_id = ?`, ...Object.values(patch), lineId);
}

// ---------- 在线状态 ----------
/**
 * 记一次心跳。meta 只覆盖传进来的字段，没传的保留上次的值
 * （终端不会每次心跳都把分辨率、磁盘重报一遍，省带宽也少出错）。
 */
export function touch(lineId, op, meta = null) {
  if (!lineId || !op) return;
  const key = keyOf(lineId, op);
  const cur = online.get(key) || { at: 0, ip: '', res: '', ver: '', free: 0, done: 0, total: 0, modelCode: '', status: '' };
  const next = { ...cur, at: Date.now() };
  if (meta) {
    if (meta.ip) next.ip = String(meta.ip).replace(/^::ffff:/, '');
    if (meta.res) next.res = String(meta.res).slice(0, 24);
    if (meta.ver) next.ver = String(meta.ver).slice(0, 24);
    if (meta.free !== undefined) next.free = Number(meta.free) || 0;
    if (meta.done !== undefined) next.done = Number(meta.done) || 0;
    if (meta.total !== undefined) next.total = Number(meta.total) || 0;
    if (meta.modelCode !== undefined) next.modelCode = String(meta.modelCode || '');
    if (meta.status) next.status = String(meta.status).slice(0, 24);
  }
  online.set(key, next);
}

/**
 * 下载进度单独上报。
 * 故意不 bump()：进度是每 2 秒变一次的高频数据，推给长轮询会把所有终端的
 * 耳朵叫醒一遍，等于给弱网加负载。
 */
export function setProgress(lineId, op, done, total, modelCode) {
  const key = keyOf(lineId, op);
  const cur = online.get(key);
  if (!cur) return false;
  cur.done = Number(done) || 0;
  cur.total = Number(total) || 0;
  cur.at = Date.now();
  if (modelCode !== undefined) cur.modelCode = String(modelCode || '');
  return true;
}

// ---------- 状态查询 ----------
export function getState(lineId) {
  const row = lineRow(lineId);
  return {
    lineId,
    rev,
    contentRev,
    seq: Number(row.seq) || 0,
    currentModelId: row.current_model_id || '',
    online: onlineOps(lineId)
  };
}

/**
 * 指定"这条线正在生产哪个机种" —— 5.0.0 的「推送」走的就是这里。
 *
 * 落库即生效：seq +1 让在线终端下一轮就知道该翻页，rev +1 立刻叫醒挂起的轮询。
 * 不等任何屏下载、不设 deadline —— 网慢的那台自己下完自己翻，中途继续播旧的。
 */
export function setCurrentModel(lineId, modelId) {
  const row = lineRow(lineId);
  if (row.current_model_id === (modelId || '')) return { ok: true, same: true };

  tx(() => {
    patchLineState(lineId, {
      current_model_id: modelId || '',
      // 老库可能还留着两段式时代的排产/准备字段，顺手清干净，免得界面或老终端误读
      pending_model_id: '',
      pending_deadline: 0,
      next_model_id: '',
      seq: (Number(row.seq) || 0) + 1
    });
    setSetting('rev', String(++rev));
  });

  console.log(`[switch] ${lineId} current set to ${modelId || '(none)'}`);
  bump();
  return { ok: true };
}

// ---------- 长轮询 ----------
function bump() {
  for (const w of waiters) w.resolve();
  waiters.clear();
}

/**
 * 等到 rev 变化或超时。调用方拿到 Promise 后再发响应。
 * 注意：客户端断开（res close）也要能及时释放，否则挂起的连接会越积越多。
 */
export function waitForChange(sinceRev, res) {
  if (rev > sinceRev) return Promise.resolve('changed');
  return new Promise((resolve) => {
    const w = { resolve: () => { cleanup(); resolve('changed'); } };
    const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, WAIT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      waiters.delete(w);
    }
    w.resolve = () => { cleanup(); resolve('changed'); };
    waiters.add(w);
    res.once('close', () => { cleanup(); resolve('closed'); });
  });
}

/**
 * 清单内容被改动。
 * 只推 rev、不动 seq —— "该翻页了"这件事仍然只由 seq 表达，
 * 这里只是让终端去核对一下"我这个机种的清单是不是变了"。
 */
export function notifyContentChanged() {
  tx(() => {
    setSetting('content_rev', String(++contentRev));
    setSetting('rev', String(++rev));
  });
  bump();
}

/** 线体被停用：把它的在线记录清掉，避免下次启用时界面还显示上一批屏 */
export function resetLine(lineId) {
  const prefix = lineId + '|';
  for (const k of [...online.keys()]) if (k.startsWith(prefix)) online.delete(k);
  bump();
}

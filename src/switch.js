// 切换状态机：两段式 prepare → ready → activate（每条线体各自一套）
// 依据 docs/03-技术方案.md 第 4 节
//
// 为什么是两段式，而不是"一句广播大家各自翻"：
//   5 台屏网速不同，各自下完各自翻，中间几十秒里前道已是新型号、后道还是旧型号，直接混批。
//   所以必须先让所有人下完并校验通过（举手），服务端集齐后才喊翻。
//
// 为什么按线体隔离（v1.7.0）：
//   一线在跑 X200 时二线可能在跑 X300，两条线的"当前型号 / 准备中 / 谁已举手"互不相干。
//   所以状态存在 line_state 表里，内存里的在线表和举手表也按「线体+工序」记账。
//
// 两个计数器，别混：
//   seq  业务语义，只在 activate 时 +1，**每条线各一份**。终端用它判断"该翻页了"。
//   rev  通信语义，全局单调，任何需要通知终端的变化都 +1（进 prepare、activate、内容改动）。
//        长轮询用 since=rev 判断有没有新信息，否则 prepare 期间 seq 没变，
//        终端要么疯狂轮询、要么永远不知道要开始下载。
import { q, tx, getSetting, setSetting } from './db.js';

const WAIT_TIMEOUT_MS = 25_000;      // 长轮询挂起上限
const ONLINE_TTL_MS = 60_000;        // 多久没请求算离线
// 离线之后还留多久的档案：管理端右栏要显示「12 分钟前在线」，
// 立刻抹掉就只剩一个空格子，运维看不出"这台机器从来没装过"还是"刚关机"。
const KEEP_MS = 30 * 60_000;
// 切换总超时：需求定的是 5 分钟。现场调试或用例验证时可以用环境变量改小，
// 否则每验证一次"掉队告警"都得干等五分钟。
// 1.9.0 起优先认 ESOP_SWITCH_TIMEOUT_MS，旧的 VWI_ 名字继续生效（老脚本不用改）。
const SWITCH_TIMEOUT_ENV = Number(process.env.ESOP_SWITCH_TIMEOUT_MS || process.env.VWI_SWITCH_TIMEOUT_MS);
export const SWITCH_TIMEOUT_MS = SWITCH_TIMEOUT_ENV > 0 ? SWITCH_TIMEOUT_ENV : 5 * 60_000;

// 在线表：key "lineId|op" -> 终端档案
//   { at, ip, res, ver, free, done, total, modelCode, status }
// v1.8.0 起不再是裸时间戳：管理端右栏要显示每台屏的 IP / 分辨率 / 磁盘 / 下载进度，
// 这些都由终端随心跳上报，服务端只负责记最新一份（不落库 —— 重启丢掉也无所谓，
// 终端下一轮心跳就补回来了，落库反而要处理过期清理）。
const online = new Map();
const ready = new Map();    // "lineId|op" -> { modelId, at }
const waiters = new Set();  // { resolve, timer }
const timers = new Map();   // lineId -> deadlineTimer

let rev = 0;
let contentRev = 0;         // 内容版本：任何清单/媒体改动都 +1，终端据此核对"我这套内容有没有变"

const keyOf = (lineId, op) => `${lineId}|${op}`;

// ---------- 初始化 ----------
export function initSwitch() {
  rev = Number(getSetting('rev', '0')) || 0;
  contentRev = Number(getSetting('content_rev', '0')) || 0;

  // 服务重启时可能有一次切换还在进行中：把每条线体的超时定时器接回去
  for (const row of q.all('SELECT line_id, pending_deadline FROM line_state WHERE pending_deadline > 0')) {
    armDeadline(row.line_id, row.pending_deadline);
  }

  // 定期清掉过期档案：60 秒算离线，30 分钟彻底删除，避免"早关机的屏"永久占着内存
  setInterval(() => {
    const drop = Date.now() - KEEP_MS;
    for (const [k, t] of online) if (!t || !t.at || t.at < drop) online.delete(k);
  }, 15_000).unref();
}

/**
 * 把线上的在线记录按线体拆开。
 * 同一条线体里一台屏只会占一个 op，不然"已就绪 3/5"永远凑不齐。
 */
function onlineOps(lineId) {
  const cut = Date.now() - ONLINE_TTL_MS;
  const prefix = lineId + '|';
  const out = [];
  for (const [k, t] of online) {
    if (t && t.at > cut && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

/**
 * 某条线体下的全部终端档案（含刚离线的）。
 * 管理端右栏用它画参数卡片：在线的那几台要显示实时进度，
 * 离线的那几台也要留着 —— 现场最常见的疑问就是"3 号工位怎么没数据"，
 * 答案通常是那台机器根本没开或根本没装，界面必须能区分。
 */
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
      status: t.status || '',
      ready: ready.get(k)?.modelId === (lineRow(lineId).pending_model_id || '') && !!ready.get(k)
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
 * 耳朵叫醒一遍，等于给弱网加负载。管理端右栏自己按 2 秒轮询 /api/terminals 取。
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
  const ops = onlineOps(lineId);
  return {
    lineId,
    rev,
    contentRev,
    seq: Number(row.seq) || 0,
    phase: row.pending_model_id ? 'prepare' : 'idle',
    currentModelId: row.current_model_id || '',
    pendingModelId: row.pending_model_id || '',
    deadline: Number(row.pending_deadline) || 0,
    online: ops,
    ready: [...ready.entries()]
      .filter(([k]) => k.startsWith(lineId + '|') && ops.includes(k.slice(lineId.length + 1)))
      .map(([k, v]) => ({ op: k.slice(lineId.length + 1), modelId: v.modelId, at: v.at }))
  };
}

// ---------- 发起切换 ----------
export function switchTo(line, model, now = Date.now()) {
  const lineId = line.id;
  const row = lineRow(lineId);
  if (row.pending_model_id && row.pending_model_id === model.id) {
    return { ok: false, reason: 'already-pending', message: '已经在准备这个型号了' };
  }

  tx(() => {
    patchLineState(lineId, {
      pending_model_id: model.id,
      pending_deadline: now + SWITCH_TIMEOUT_MS
    });
    setSetting('rev', String(++rev));
  });

  // 换目标时要清空举手：上一轮的 ready 对新目标无效
  clearReady(lineId);
  armDeadline(lineId, now + SWITCH_TIMEOUT_MS);
  bump();

  // 这条线上没有任何终端在线 → 直接生效，否则界面会一直卡在"准备中"
  if (onlineOps(lineId).length === 0) {
    activate(lineId, 'no-online');
    return { ok: true, phase: 'idle', activated: true, reason: 'no-online' };
  }
  return { ok: true, phase: 'prepare', activated: false };
}

// ---------- 终端举手 ----------
export function markReady(lineId, op, modelId) {
  const row = lineRow(lineId);
  if (!row.pending_model_id) {
    // 已经 activate 过了（终端迟到的举手），不算错，只是没用了
    return { ok: true, accepted: false, reason: 'no-pending' };
  }
  if (row.pending_model_id !== modelId) {
    return { ok: false, accepted: false, reason: 'stale', message: '目标型号已变更，请按最新指令重新准备' };
  }
  ready.set(keyOf(lineId, op), { modelId, at: Date.now() });
  touch(lineId, op);
  const activated = maybeActivate(lineId);
  return { ok: true, accepted: true, activated };
}

// ---------- 激活判断 ----------
function maybeActivate(lineId) {
  const row = lineRow(lineId);
  if (!row.pending_model_id) return false;

  const ops = onlineOps(lineId);
  const allReady = ops.length === 0 ||
    ops.every((op) => ready.get(keyOf(lineId, op))?.modelId === row.pending_model_id);
  const expired = row.pending_deadline > 0 && Date.now() >= row.pending_deadline;

  if (allReady) { activate(lineId, 'all-ready'); return true; }
  if (expired) { activate(lineId, 'timeout'); return true; }
  return false;
}

function activate(lineId, reason) {
  const row = lineRow(lineId);
  const pending = row.pending_model_id;
  if (!pending) return;

  tx(() => {
    patchLineState(lineId, {
      current_model_id: pending,
      pending_model_id: '',
      pending_deadline: 0,
      seq: (Number(row.seq) || 0) + 1
    });
    setSetting('rev', String(++rev));
  });

  const stragglers = onlineOps(lineId).filter((op) => ready.get(keyOf(lineId, op))?.modelId !== pending);
  clearReady(lineId);
  clearDeadline(lineId);

  console.log(
    `[switch] ${lineId} activate reason=${reason} model=${pending} ` +
    `stragglers=${stragglers.length ? stragglers.join(',') : '无'}`
  );
  bump();
}

function clearReady(lineId) {
  const prefix = lineId + '|';
  for (const k of [...ready.keys()]) if (k.startsWith(prefix)) ready.delete(k);
}

function armDeadline(lineId, at) {
  clearDeadline(lineId);
  const ms = Math.max(0, at - Date.now());
  const t = setTimeout(() => {
    timers.delete(lineId);
    maybeActivate(lineId);
  }, ms);
  t.unref?.();
  timers.set(lineId, t);
}

function clearDeadline(lineId) {
  const t = timers.get(lineId);
  if (t) { clearTimeout(t); timers.delete(lineId); }
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

// 管理端手动"放弃本次切换"
export function cancelSwitch(lineId) {
  const row = lineRow(lineId);
  if (!row.pending_model_id) return { ok: false, reason: 'not-pending' };
  tx(() => {
    patchLineState(lineId, { pending_model_id: '', pending_deadline: 0 });
    setSetting('rev', String(++rev));
  });
  clearReady(lineId);
  clearDeadline(lineId);
  bump();
  console.log(`[switch] ${lineId} cancelled by admin`);
  return { ok: true };
}

/**
 * 清单内容被改动。
 * 只推 rev、不动 seq —— "该翻页了"这件事仍然只由 seq 表达，
 * 这里只是让终端去核对一下"我这个型号的清单是不是变了"。
 * 为什么需要：工程部发现指导书写错了，改完应当立刻在屏上生效，
 * 而不是等下一次换型才发现屏上还是老图。
 */
export function notifyContentChanged() {
  tx(() => {
    setSetting('content_rev', String(++contentRev));
    setSetting('rev', String(++rev));
  });
  bump();
}

/** 线体被停用/切换：把它的在线与举手记录清掉，避免下次启用时残留"已就绪"。 */
export function resetLine(lineId) {
  const prefix = lineId + '|';
  for (const k of [...online.keys()]) if (k.startsWith(prefix)) online.delete(k);
  clearReady(lineId);
  clearDeadline(lineId);
  bump();
}

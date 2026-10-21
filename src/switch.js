// 切换状态机：两段式 prepare → ready → activate
// 依据 docs/03-技术方案.md 第 4 节
//
// 为什么是两段式，而不是"一句广播大家各自翻"：
//   5 台屏网速不同，各自下完各自翻，中间几十秒里前道已是新型号、后道还是旧型号，直接混批。
//   所以必须先让所有人下完并校验通过（举手），服务端集齐后才喊翻。
//
// 两个计数器，别混：
//   seq  业务语义，只在 activate 时 +1。终端用它判断"该翻页了"。
//   rev  通信语义，任何需要通知终端的变化都 +1（进 prepare、activate）。
//        长轮询用 since=rev 判断有没有新信息，否则 prepare 期间 seq 没变，
//        终端要么疯狂轮询、要么永远不知道要开始下载。
import { tx, getSetting, setSetting, delSetting } from './db.js';

const WAIT_TIMEOUT_MS = 25_000;      // 长轮询挂起上限
const ONLINE_TTL_MS = 60_000;        // 多久没请求算离线
export const SWITCH_TIMEOUT_MS = 5 * 60_000;  // 切换总超时（需求 5 分钟）

const online = new Map();   // op -> lastSeen 毫秒
const ready = new Map();    // op -> { modelId, at }
const waiters = new Set();  // { resolve, timer }

let rev = 0;
let deadlineTimer = null;

// ---------- 初始化 ----------
export function initSwitch() {
  rev = Number(getSetting('rev', '0')) || 0;
  // 服务重启时可能有一次切换还在进行中：把超时定时器接回去
  const deadline = Number(getSetting('pending_deadline', '0')) || 0;
  if (deadline) armDeadline(deadline);

  // 定期清掉过期在线记录，避免"早关机的屏"一直被算作分母
  setInterval(() => {
    const cut = Date.now() - ONLINE_TTL_MS;
    for (const [op, t] of online) if (t < cut) online.delete(op);
  }, 15_000).unref();
}

// ---------- 在线状态 ----------
export function touch(op) {
  if (!op) return;
  online.set(op, Date.now());
}

function onlineOps() {
  const cut = Date.now() - ONLINE_TTL_MS;
  return [...online.entries()].filter(([, t]) => t > cut).map(([op]) => op);
}

// ---------- 状态查询 ----------
export function getState() {
  return {
    rev,
    seq: Number(getSetting('seq', '0')) || 0,
    phase: getSetting('pending_model_id') ? 'prepare' : 'idle',
    currentModelId: getSetting('current_model_id', ''),
    pendingModelId: getSetting('pending_model_id', ''),
    deadline: Number(getSetting('pending_deadline', '0')) || 0,
    online: onlineOps(),
    ready: [...ready.entries()].filter(([op]) => onlineOps().includes(op)).map(([op, v]) => ({
      op, modelId: v.modelId, at: v.at
    }))
  };
}

// ---------- 发起切换 ----------
export function switchTo(model, now = Date.now()) {
  const pending = getSetting('pending_model_id');
  if (pending && pending === model.id) {
    return { ok: false, reason: 'already-pending', message: '已经在准备这个型号了' };
  }

  tx(() => {
    setSetting('pending_model_id', model.id);
    setSetting('pending_deadline', String(now + SWITCH_TIMEOUT_MS));
    setSetting('rev', String(++rev));
  });

  // 换目标时要清空举手：上一轮的 ready 对新目标无效
  ready.clear();
  armDeadline(now + SWITCH_TIMEOUT_MS);
  bump();

  // 没有任何终端在线 → 直接生效，否则界面会一直卡在"准备中"
  if (onlineOps().length === 0) {
    activate('no-online');
    return { ok: true, phase: 'idle', activated: true, reason: 'no-online' };
  }
  return { ok: true, phase: 'prepare', activated: false };
}

// ---------- 终端举手 ----------
export function markReady(op, modelId) {
  const pending = getSetting('pending_model_id');
  if (!pending) {
    // 已经 activate 过了（终端迟到的举手），不算错，只是没用了
    return { ok: true, accepted: false, reason: 'no-pending' };
  }
  if (pending !== modelId) {
    return { ok: false, accepted: false, reason: 'stale', message: '目标型号已变更，请按最新指令重新准备' };
  }
  ready.set(op, { modelId, at: Date.now() });
  touch(op);
  const activated = maybeActivate();
  return { ok: true, accepted: true, activated };
}

// ---------- 激活判断 ----------
function maybeActivate() {
  const pending = getSetting('pending_model_id');
  if (!pending) return false;

  const ops = onlineOps();
  const allReady = ops.length === 0 || ops.every((op) => ready.get(op)?.modelId === pending);
  const deadline = Number(getSetting('pending_deadline', '0')) || 0;
  const expired = deadline > 0 && Date.now() >= deadline;

  if (allReady) { activate('all-ready'); return true; }
  if (expired) { activate('timeout'); return true; }
  return false;
}

function activate(reason) {
  const pending = getSetting('pending_model_id');
  if (!pending) return;

  tx(() => {
    setSetting('current_model_id', pending);
    setSetting('seq', String((Number(getSetting('seq', '0')) || 0) + 1));
    setSetting('rev', String(++rev));
    delSetting('pending_model_id', 'pending_deadline');
  });

  const stragglers = onlineOps().filter((op) => ready.get(op)?.modelId !== pending);
  ready.clear();
  clearDeadline();

  console.log(
    `[switch] activate reason=${reason} model=${pending} ` +
    `stragglers=${stragglers.length ? stragglers.join(',') : '无'}`
  );
  bump();
}

function armDeadline(at) {
  clearDeadline();
  const ms = Math.max(0, at - Date.now());
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    maybeActivate();
  }, ms);
  deadlineTimer.unref?.();
}

function clearDeadline() {
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
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
export function cancelSwitch() {
  if (!getSetting('pending_model_id')) return { ok: false, reason: 'not-pending' };
  tx(() => {
    delSetting('pending_model_id', 'pending_deadline');
    setSetting('rev', String(++rev));
  });
  ready.clear();
  clearDeadline();
  bump();
  console.log('[switch] cancelled by admin');
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
  tx(() => setSetting('rev', String(++rev)));
  bump();
}

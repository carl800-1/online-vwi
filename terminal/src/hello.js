// 自报身份：POST /api/clients/hello
//
// 为什么单独做一个动作，而不是靠每 5 秒的心跳：心跳是"我在"，
// 但它没有返回值 —— 屏上报完不知道服务端收没收到、分到哪、有没有和别的屏撞车。
// 装机的人站在屏前面，只能跑回管理端按 IP 反查，这一步现在补上。
//
// 服务端回四种状态（4.5.0 定义）：
//   pending    已收到，管理端还没确认
//   confirmed  已确认，与屏上填的一致
//   assigned   管理端指派的是别的位置 —— 屏会按管理端的值改写本地配置
//   conflict   这道工序已被另一台屏占着 —— 不自动抢，现场去管理端定
const net = require('./net');

const TEXT = {
  pending: '服务端已收到，等管理端确认',
  confirmed: '管理端已确认，与本机设置一致',
  assigned: '管理端已指派到别的位置，本机将按管理端执行',
  conflict: '这道工序已被另一台屏占用，请到管理端处理'
};

/**
 * @param {string} server  服务器地址
 * @param {object} identity { line, op, ver, res, name }
 * @returns {Promise<{ok:boolean, state?:string, message?:string, assign?:object,
 *                    conflictWith?:string, error?:string}>}
 */
async function hello(server, identity = {}) {
  const body = { op: identity.op || '' };
  if (identity.line) body.line = identity.line;
  if (identity.ver) body.ver = identity.ver;
  if (identity.res) body.res = identity.res;
  if (identity.name) body.name = identity.name;

  if (!body.op) return { ok: false, error: '本机还没配工序号' };

  try {
    const r = await net.postJson(server, '/api/clients/hello', body, { timeoutMs: 8000 });
    const state = String(r.state || 'pending');
    return {
      ok: true,
      state,
      message: r.message || TEXT[state] || '',
      lineCode: r.lineCode || '',
      processCode: r.processCode || body.op,
      assign: r.assign || null,
      src: r.src || '',
      conflictWith: r.conflictWith || ''
    };
  } catch (e) {
    // 服务端 1.7.x 及更早没有这个接口：404 不该让装机卡住，降级说一句"旧服务端"
    if (e.status === 404) {
      return { ok: false, oldServer: true, error: '服务端版本较旧，不支持自报（不影响播放）' };
    }
    // 服务端的错误体是 { error: '线体 L1 不存在…' }，比 "HTTP 400" 有用得多
    const msg = (e.body && (e.body.error || e.body.message)) || e.message || '自报失败';
    return { ok: false, error: msg };
  }
}

module.exports = { hello, TEXT };

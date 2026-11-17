// 屏台账：谁连上来了、报的哪条线哪道工序。
//
// 5.0.1 起这里只读不写 —— 屏的身份就是它自己报的「线号 + 工序号」，
// 在屏的托盘菜单里填，服务端只负责记最新一次心跳。
// 没有指派、没有握手：单机单线场景，填错直接到屏前改比在管理端改还快。
// 唯一要报的异常是「两台屏报同一道工序」，那是界面层按行标红的活。
import { q, clients as allClients, removeClient, upsertClient } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';

// 多久没心跳算离线。和 switch.js 的 ONLINE_TTL_MS 保持一致：
// 两处口径不同的话，会出现"上面说在线、下面说离线"的怪事。
const ONLINE_MS = Number(process.env.ESOP_CLIENT_TTL_MS) > 0
  ? Number(process.env.ESOP_CLIENT_TTL_MS)
  : 60_000;

const OP_RE = /^[A-Za-z0-9._-]{1,16}$/;

export function register(router) {
  /**
   * POST /api/clients/hello
   *
   * 老终端（1.8.x）保存设置后会调一次，用它确认"服务端收到我是谁了"。
   * 5.0.1 已经没有指派，这里就做一件最朴素的事：登记一下、回一句收到。
   * 保留这个接口是为了让 1.8.3 的屏升级服务端后不报错 —— 屏上会显示「服务端已收到」。
   */
  router.post('/api/clients/hello', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const ip = String(body.ip || ctx.ip || '').replace(/^::ffff:/, '');
    if (!ip) throw badRequest('无法确定客户端 IP');

    const wantLine = String(body.line || '').trim().toUpperCase();
    const line = wantLine
      ? q.get('SELECT * FROM line WHERE code = ?', wantLine)
      : q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1');
    if (wantLine && !line) throw badRequest(`线体 ${wantLine} 不存在，请检查屏上填的线号`);
    if (!line) throw badRequest('服务端还没有启用任何线体');

    const op = String(body.op || '').trim().toUpperCase();
    if (!op) throw badRequest('缺少工序号 op');
    if (!OP_RE.test(op)) throw badRequest(`工序码 ${op} 不合法（字母、数字、点、下划线、横线，16 字以内）`);

    upsertClient({ ip, name: body.name, lineCode: line.code, opCode: op, ver: body.ver, res: body.res });

    sendJson(res, 200, {
      ok: true,
      ip,
      lineCode: line.code,
      lineName: line.name,
      processCode: op,
      state: 'confirmed',
      assign: null,
      message: '服务端已收到，本机按自己填的线号和工序号播放'
    });
  });

  /** 全部屏：管理端「终端监控」那张表 */
  router.get('/api/clients', (req, res) => {
    const rows = allClients()
      .map((c) => {
        const ageMs = Math.max(0, Date.now() - (Number(c.last_seen) || 0));
        return {
          id: c.id,
          ip: c.ip,
          name: c.name || '',
          lineCode: c.line_code,
          opCode: c.op_code,
          ver: c.ver,
          res: c.res,
          lastSeen: Number(c.last_seen) || 0,
          ageMs,
          online: ageMs <= ONLINE_MS
        };
      })
      // 在线的排前面，其次按 IP 的数字顺序（现场习惯看 IP 排号）
      .sort((a, b) => (b.online - a.online) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));

    sendJson(res, 200, {
      clients: rows,
      total: rows.length,
      online: rows.filter((r) => r.online).length,
      ts: Date.now()
    });
  });

  /**
   * DELETE /api/clients/:id
   * 只清台账，不是封禁 —— 屏还开着的话，5 秒后心跳会把它插回来。
   */
  router.del('/api/clients/:id', (req, res) => {
    const ip = decodeURIComponent(req.params.id);
    const removed = removeClient(ip);
    if (!removed) throw Object.assign(new Error('这台屏不在台账里：' + ip), { status: 404 });
    sendJson(res, 200, { ok: true, removed });
  });
}

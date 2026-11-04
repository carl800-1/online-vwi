// 客户端（屏）与工序绑定：GET /api/clients、POST /api/clients/:id/bind 等
//
// 解决的是"哪台屏该放哪道工序"这件事：4.0.0 之后服务端只知道"L1 的 OP10 有人在"
// （在线表的键是 lineId|op），机器本身是匿名的，所以分配只能跑到那台屏前面去设。
// 三条线 × 二三十道工序，逐台点必然点错。
//
// 这里把「设备」和「工位」分开记：
//   client      谁连上来了（ip / 计算机名 / 自报的线号工序号 / 最后心跳）
//   client_bind 某条线的某道工序 ↔ 某台屏
//
// **绑定不参与播放**：屏上仍旧按自己填的线号 / 工序号拉清单。绑定的两个用处是
//   ① 知道这道工序该是哪台屏（现场对齐一次，之后看得见）
//   ② 它把号改了就立刻看得出来（moved），给一个「重新分配」的按钮
import {
  q, clients as allClients, clientOf, bindOfProcess, bindOfClient, binds as allBinds,
  bindClient, unbindClient, unbindProcess, processesOf, lineByCode
} from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState } from '../switch.js';

// 多久没心跳算离线。和 switch.js 的 ONLINE_TTL_MS 保持一致：
// 两处口径不同的话，会出现"上面说在线、下面说离线"的怪事。
// 环境变量只为自动化测试——否则验一次"离线"要干等一分钟。
const ONLINE_MS = Number(process.env.ESOP_CLIENT_TTL_MS) > 0
  ? Number(process.env.ESOP_CLIENT_TTL_MS)
  : 60_000;

const OP_RE = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * 一台屏当前算什么状态。
 *
 *   unbound  没绑到任何工序（新插上的屏都是这个状态）
 *   online   自己报的线号工序号和绑定一致，且 60 秒内有心跳
 *   moved    **它还活着，但已经把号改成别的了** —— 这是本次要解决的核心场景：
 *            有人在屏上把 OP10 改成了 OP20，管理端不该只看到"离线"，
 *            要知道"它现在报的是 L1/OP20"，才好判断是改错了还是有意调岗
 *   offline  60 秒没有心跳（断电、网断、程序没起）
 *   missing  绑定还在，但设备记录没了（正常走不到，兼容手动清库）
 */
function stateOf(client, bind, line) {
  if (!bind) return 'unbound';
  if (!client) return 'missing';
  if (Date.now() - Number(client.last_seen || 0) > ONLINE_MS) return 'offline';
  if (client.line_code !== line.code || client.op_code !== bind.process_code) return 'moved';
  return 'online';
}

/** 一条绑定 + 它指向的客户端，拼成界面要的形状（只用 code，id 不外露） */
function shapeBind(bind, clientById, lineById) {
  const line = lineById.get(bind.line_id);
  if (!line) return null;                       // 线体被删了，绑定作废
  const c = bind.client_id ? clientById.get(bind.client_id) : null;
  return {
    lineId: bind.line_id,
    lineCode: line.code,
    lineName: line.name,
    processCode: bind.process_code,
    boundAt: bind.bound_at,
    clientId: bind.client_id,
    ip: c ? c.ip : bind.client_id,
    name: c ? c.name : '',
    // 客户端现在自报的（可能已经被改了）
    seenLineCode: c ? c.line_code : '',
    seenOpCode: c ? c.op_code : '',
    lastSeen: c ? Number(c.last_seen) || 0 : 0,
    ageMs: c ? Math.max(0, Date.now() - (Number(c.last_seen) || 0)) : 0,
    state: stateOf(c, bind, line)
  };
}

function lineMap() {
  return new Map(q.all('SELECT id, code, name, enabled, sort FROM line').map((l) => [l.id, l]));
}

function clientMap() {
  return new Map(allClients().map((c) => [c.id, c]));
}

/** 线体参数：管理端传 lineId 或 lineCode 都认 */
function pickLine(body) {
  const id = String(body.lineId || '').trim();
  const code = String(body.lineCode || '').trim();
  let line = null;
  if (id) line = q.get('SELECT * FROM line WHERE id = ?', id);
  else if (code) line = lineByCode(code);
  if (!line) throw badRequest(id || code ? `线体不存在：${id || code}` : '缺少 lineId');
  return line;
}

/** 这道工序在当前机种里存在吗？只做提示，不拦 —— 换型后可能就有了 */
function processWarning(line, processCode) {
  const cur = getState(line.id).currentModelId;
  if (!cur) return '';
  const model = q.get('SELECT code FROM model WHERE id = ?', cur);
  if (!model) return '';
  const has = processesOf(cur).some((p) => p.code === processCode);
  return has ? '' : `「${model.code}」现在没有工序 ${processCode}，换型后才有的话可以照常绑`;
}

export function register(router) {
  /**
   * 全部客户端（屏）。
   *
   * 返回的每一台都带上"绑到哪、状态如何"，管理端一页就能对齐全厂。
   * 从没绑过的屏也在里面（bind = null）—— 这正是"新插上的屏"该出现的位置。
   */
  router.get('/api/clients', (req, res) => {
    const cm = clientMap();
    const lm = lineMap();
    const byClient = new Map();
    for (const b of allBinds()) {
      const shaped = shapeBind(b, cm, lm);
      if (shaped) byClient.set(shaped.clientId, shaped);
    }

    const rows = [...cm.values()]
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
          online: ageMs <= ONLINE_MS,
          bind: byClient.get(c.id) || null
        };
      })
      // 在线的排前面，其次按 IP 的数字顺序（现场习惯看 IP 排号）
      .sort((a, b) => (b.online - a.online) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));

    sendJson(res, 200, {
      clients: rows,
      total: rows.length,
      online: rows.filter((r) => r.online).length,
      bound: rows.filter((r) => r.bind).length,
      // 掉线 + 改配的台数：管理端顶栏要报这个数，否则"有屏不对"没人发现
      problem: rows.filter((r) => r.bind && (r.bind.state === 'moved' || r.bind.state === 'offline')).length,
      ts: Date.now()
    });
  });

  /** 单台客户端（含绑定），给"重新分配"弹窗用 */
  router.get('/api/clients/:id', (req, res) => {
    const c = clientOf(req.params.id);
    if (!c) throw Object.assign(new Error('客户端不存在：' + req.params.id), { status: 404 });
    const bind = bindOfClient(c.id);
    const shaped = bind ? shapeBind(bind, clientMap(), lineMap()) : null;
    sendJson(res, 200, {
      id: c.id, ip: c.ip, name: c.name || '',
      lineCode: c.line_code, opCode: c.op_code, ver: c.ver, res: c.res,
      lastSeen: Number(c.last_seen) || 0,
      ageMs: Math.max(0, Date.now() - (Number(c.last_seen) || 0)),
      online: Date.now() - (Number(c.last_seen) || 0) <= ONLINE_MS,
      bind: shaped
    });
  });

  /**
   * 绑定：把某台屏指给「某条线的某道工序」。
   *
   * 一台屏只能占一个工位、一道工序只能一台屏 —— 两条纪律在 db.bindClient 里落实
   * （同一事务先删后插），这里只做参数校验和"会替换掉谁"的提示。
   */
  router.post('/api/clients/:id/bind', async (req, res) => {
    const body = await readJsonBody(req);
    const c = clientOf(req.params.id);
    if (!c) throw badRequest('客户端不存在：' + req.params.id);

    const line = pickLine(body);
    const op = String(body.processCode || '').trim().toUpperCase();
    if (!op) throw badRequest('缺少 processCode');
    if (!OP_RE.test(op)) throw badRequest(`工序码 ${op} 不合法`);

    // 绑之前先记住"会被顶掉的是谁"，回给界面做提示（现场要看得出替换了哪台）
    const prevOnProcess = bindOfProcess(line.id, op);
    const prevOfClient = bindOfClient(c.id);

    bindClient(c.id, line.id, op);

    const bind = bindOfProcess(line.id, op);
    const shaped = shapeBind(bind, clientMap(), lineMap());
    sendJson(res, 200, {
      ok: true,
      bind: shaped,
      warning: processWarning(line, op),
      // 替换提示：这三条空着就是"干净绑定"
      replacedClientId: prevOnProcess && prevOnProcess.client_id !== c.id ? prevOnProcess.client_id : '',
      movedFrom: prevOfClient && !(prevOfClient.line_id === line.id && prevOfClient.process_code === op)
        ? { lineCode: (lineMap().get(prevOfClient.line_id) || {}).code || '', processCode: prevOfClient.process_code }
        : null
    });
  });

  /** 解绑某一台屏（它变回"没分配到工位"） */
  router.post('/api/clients/:id/unbind', (req, res) => {
    const c = clientOf(req.params.id);
    if (!c) throw badRequest('客户端不存在：' + req.params.id);
    const n = unbindClient(c.id);
    sendJson(res, 200, { ok: true, removed: n });
  });

  /** 解绑某道工序（屏还在，但这道工序不再指定它） */
  router.post('/api/binds/release', async (req, res) => {
    const body = await readJsonBody(req);
    const line = pickLine(body);
    const op = String(body.processCode || '').trim().toUpperCase();
    if (!op) throw badRequest('缺少 processCode');
    const n = unbindProcess(line.id, op);
    sendJson(res, 200, { ok: true, removed: n });
  });

  /**
   * 绑定清单。
   *   ?lineId=  → 这条线全部（工序页面/线体页面直接用）
   *   不带      → 全厂（工序表要显示"这道工序在几条线上绑了屏"）
   */
  router.get('/api/binds', (req, res, ctx) => {
    const cm = clientMap();
    const lm = lineMap();
    const lineId = String(ctx.query.lineId || '').trim();
    const rows = (lineId ? allBinds(lineId) : allBinds())
      .map((b) => shapeBind(b, cm, lm))
      .filter(Boolean);
    sendJson(res, 200, { binds: rows, total: rows.length, ts: Date.now() });
  });
}

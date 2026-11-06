// 极简路由：路径参数匹配 + 终端身份校验 + 错误兜底
import { q, bindOfClient } from './db.js';

/**
 * 鉴权说明（一期）：
 *   管理端接口一律不鉴权 —— 用户已明确「先不考虑权限管理」。
 *   终端也不鉴权，只带一个 ?line=L1&op=OP30。这两个不是权限，而是「我在哪条线、哪道工序」这个身份本身。
 *   代价是内网任何人能拉到内容：可接受，但服务器绝不能暴露到办公网或外网。
 * 二期加回权限时，只需在 handle() 里 route.opts.op 分支前插入一次会话校验，
 * 业务 handler 不需要任何改动。
 */

/**
 * 解析终端身份：线体 + 工序。
 *
 * 不带 line 时回落到「当前启用的线体」——这是给老终端留的后路：
 * 升级服务端后，现场 5 台屏的 config.json 里没有 line 字段，它们必须继续能跑。
 * 一旦现场启用第二条线，老终端才需要补上 line，服务端会在日志里说得清清楚楚。
 *
 * @returns {null|{status:number,message:string}} 出错时返回原因，成功时把 line/process 挂到 ctx 上
 */
export function resolveTerminal(req, ctx) {
  const lineParam = String(ctx.query.line || req.headers['x-vwi-line'] || '').trim();

  let line;
  if (lineParam) {
    line = q.get('SELECT * FROM line WHERE code = ? OR id = ?', lineParam, lineParam);
    if (!line) return { status: 404, message: `线体 ${lineParam} 不存在，请检查终端配置` };
  } else {
    line = q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1');
    if (!line) return { status: 404, message: '服务端还没有启用任何线体，请先在管理端「启用线体」' };
  }
  ctx.line = line;

  const op = String(ctx.query.op || req.headers['x-vwi-op'] || '').trim();
  if (!op) return { status: 400, message: '缺少 op 参数（例如 ?op=OP1）' };
  // v4.0.0 起工序归机种，线体不再拥有工序清单 —— 这里只校验格式，
  // "这条线当前的机种有没有这道工序"由 display 接口回答（返回 noStation + message）。
  // 不在这里 404：op 打错一小时才会发现，而 404 在终端上表现为"连不上服务器"，
  // 现场会去查网络，方向全错。
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(op)) {
    return { status: 400, message: `工序码 ${op} 不合法，只能是字母、数字、点、下划线、横线` };
  }
  ctx.process = { code: op, name: '' };
  return null;
}

/**
 * 4.5.0：**管理端指派优先于终端自报**。
 *
 * 4.4.0 里绑定只是台账，屏上填什么就播什么。于是"屏上填错了"只能在屏前面改，
 * 管理端在工序页点了半天指派，画面一点没变 —— 那套只能算"看得见"，不算"管得住"。
 * 现在改成：谁被指派到 (线, 工序)，就播 (线, 工序) 的内容。
 *
 * 三个刻意的边界：
 *   ① **没指派就按自报**。新屏装完到管理端确认之间有个空窗期，纯绑定会让它黑屏；
 *      老现场那批没绑过的屏也不能因为升级服务端就停播。
 *   ② **只在"决定播什么"的接口上调用**（/api/state、/display/playlist）。
 *      心跳 /api/telemetry 绝不调 —— 那里要留终端自报的**原值**，
 *      否则它把号改了你还是读到自己写回去的值，"已改配"永远检测不出来。
 *   ③ 线体被删了（绑定悬空）就回落到自报，不做任何"猜"。
 *
 * 覆盖时把原值留在 ctx.selfLine / ctx.selfProcess，接口要把它一起回给终端 ——
 * 屏上要能显示"你填的是 L2/OP05，但管理端让你放 L1/OP30"。
 */
export function applyAssignment(req, ctx) {
  const ip = String(ctx.ip || '').replace(/^::ffff:/, '');
  if (!ip) return null;
  const bind = bindOfClient(ip);
  if (!bind) return null;
  const line = q.get('SELECT * FROM line WHERE id = ?', bind.line_id);
  if (!line) return null;

  ctx.selfLine = ctx.line || null;
  ctx.selfProcess = ctx.process || null;
  ctx.assigned = true;

  // 指派与自报一致时也没必要替换对象，但 assign 信息仍要给终端（它据此知道"已被确认"）
  if (ctx.line && ctx.line.id === line.id && ctx.process && ctx.process.code === bind.process_code) {
    return bind;
  }
  ctx.line = line;
  ctx.process = { code: bind.process_code, name: '' };
  return bind;
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'
    );
    routes.push({ method: method.toUpperCase(), re, keys, handler, opts, pattern });
  }

  const router = {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    del: (p, h, o) => add('DELETE', p, h, o),

    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      return { route: null, params: {}, pathMatched };
    },

    async handle(req, res, ctx) {
      const url = new URL(req.url, 'http://localhost');
      const { route, params, pathMatched } = router.match(req.method, url.pathname);
      if (!route) {
        if (pathMatched) {
          sendError(res, 405, '接口不支持该请求方法');
          return true;
        }
        return false; // 交给静态资源处理
      }

      ctx.params = params;
      // 顺手挂一份到 req 上：早期的 handler 都是写 req.params.id，
      // 只设 ctx.params 会导致 "/api/processes/:id" 这类接口拿去 undefined（500）。
      req.params = params;
      ctx.query = Object.fromEntries(url.searchParams.entries());
      // 客户端 IP 一律由服务端从连接里取，不信终端自报 ——
      // 现场排查"到底哪台机器在连我"时，只有这个值是真的。
      ctx.ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

      // 终端身份：线体 + 工序。任一配错都 400/404，早报错比后面播不出来好查。
      if (route.opts.op) {
        const err = resolveTerminal(req, ctx);
        if (err) {
          sendError(res, err.status, err.message);
          return true;
        }
      }

      try {
        await route.handler(req, res, ctx);
      } catch (e) {
        const code = e.status || 500;
        // 4xx 是"调用方传错了"，属于预期内的拒绝，只记一行；
        // 5xx 才是自己的 bug，打完整堆栈。
        if (code >= 500) console.error(`[${req.method} ${url.pathname}]`, e);
        else console.warn(`[${req.method} ${url.pathname}] ${code} ${e.message}`);
        if (!res.headersSent) sendError(res, code, e.message || '服务器内部错误');
        else res.end();
      }
      return true;
    }
  };

  return router;
}

export function sendJson(res, code, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(buf);
}

export function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

export async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw badRequest('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

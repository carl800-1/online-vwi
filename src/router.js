// 极简路由：路径参数匹配 + 终端身份校验 + 错误兜底
import { q } from './db.js';

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
  if (!op) return { status: 400, message: '缺少 op 参数（例如 ?op=OP30）' };

  const proc = q.get('SELECT * FROM process WHERE line_id = ? AND code = ?', line.id, op);
  if (!proc) return { status: 404, message: `工序 ${op} 不在「${line.name}」上，请检查终端配置` };
  ctx.process = proc;
  return null;
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

// 极简路由：路径参数匹配 + 终端 op 校验 + 错误兜底
import { q } from './db.js';

/**
 * 鉴权说明（一期）：
 *   管理端接口一律不鉴权 —— 用户已明确「先不考虑权限管理」。
 *   终端也不鉴权，只带一个 ?op=OP30。op 不是权限，而是「我是哪道工序」这个身份本身。
 *   代价是内网任何人能拉到内容：可接受，但服务器绝不能暴露到办公网或外网。
 * 二期加回权限时，只需在 handle() 里 route.opts.op 分支前插入一次会话校验，
 * 业务 handler 不需要任何改动。
 */

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
      ctx.query = Object.fromEntries(url.searchParams.entries());

      // 终端身份：只认 op。没带就 400，带了但库里没有也 400——
      // 这两种都是装机时配错了，早报错比后面播不出来好查。
      if (route.opts.op) {
        const code = String(ctx.query.op || req.headers['x-vwi-op'] || '').trim();
        if (!code) {
          sendError(res, 400, '缺少 op 参数（例如 ?op=OP30）');
          return true;
        }
        const proc = q.get('SELECT * FROM process WHERE code = ?', code);
        if (!proc) {
          sendError(res, 404, `工序 ${code} 不存在，请检查终端配置`);
          return true;
        }
        ctx.process = proc;
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

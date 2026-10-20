// 极简路由：路径参数匹配 + 终端令牌校验 + 错误兜底
import { q } from './db.js';

/**
 * 鉴权说明（本期）：
 *   管理端接口一律不鉴权 —— 用户已明确「先不考虑权限管理」。
 *   唯一保留的是终端令牌，它不是权限，而是让终端能证明「我是哪台工位」。
 * 二期加回权限时，只需在 handle() 里 auth 分支前插入一次会话校验，
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

      if (route.opts.station) {
        ctx.station = stationAuth(req, url);
        if (!ctx.station) {
          sendError(res, 401, '终端未授权：工位编码或令牌不正确');
          return true;
        }
      }

      try {
        await route.handler(req, res, ctx);
      } catch (e) {
        console.error(`[${req.method} ${url.pathname}]`, e);
        if (!res.headersSent) sendError(res, e.status || 500, e.message || '服务器内部错误');
        else res.end();
      }
      return true;
    }
  };

  return router;
}

// 终端鉴权：?code=XX&token=YY，令牌由管理端生成后写进终端配置
function stationAuth(req, url) {
  const code = url.searchParams.get('code') || req.headers['x-vwi-station'];
  const token = url.searchParams.get('token') || req.headers['x-vwi-station-token'];
  if (!code || !token) return null;
  return q.get(
    `SELECT s.* FROM station s JOIN station_token t ON t.station_id = s.id
      WHERE s.code = ? AND t.token = ?`,
    code, token
  ) || null;
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
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

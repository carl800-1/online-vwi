// 主进程网络层：所有 HTTP 都从这里走。
// 为什么不让渲染进程直接 fetch：exe 加载的是本地页面（file://），
// 去访问 http://服务器 属于跨源，且断网时页面本身都不能起。
// 放主进程还有两个好处：Node 侧能边下边算 sha256、能直接写文件。
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');

function pick(url) {
  return url.protocol === 'https:' ? https : http;
}

function agentFor(url, keepAlive) {
  const Ctor = url.protocol === 'https:' ? https.Agent : http.Agent;
  return new Ctor({ keepAlive, maxSockets: 4, timeout: 60_000 });
}

const agents = new Map();
function getAgent(url, keepAlive = true) {
  const key = url.protocol + (keepAlive ? ':ka' : ':one');
  if (!agents.has(key)) agents.set(key, agentFor(url, keepAlive));
  return agents.get(key);
}

/**
 * GET 一段 JSON。
 * 长轮询要挂 25 秒，所以默认给 40 秒；超时/断线统一抛 ERR_NET，由上层决定重试节奏。
 */
function getJson(server, apiPath, { timeoutMs = 40_000, signal } = {}) {
  const url = new URL(apiPath, server.endsWith('/') ? server : server + '/');
  return new Promise((resolve, reject) => {
    const req = pick(url).get(
      url,
      {
        agent: getAgent(url),
        headers: { accept: 'application/json', connection: 'keep-alive' },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode} ${apiPath}`);
            err.status = res.statusCode;
            err.body = body;
            return reject(err);
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('响应不是 JSON：' + body.slice(0, 120)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(wrap(e)));
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
  });
}

function postJson(server, apiPath, body, { timeoutMs = 15_000 } = {}) {
  const url = new URL(apiPath, server.endsWith('/') ? server : server + '/');
  const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
  return new Promise((resolve, reject) => {
    const req = pick(url).request(
      url,
      {
        method: 'POST',
        agent: getAgent(url, false),
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          connection: 'close'
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 409 也可能带体，拿不到就算了 */ }
          if (res.statusCode >= 400) {
            const err = new Error(json?.message || `HTTP ${res.statusCode} ${apiPath}`);
            err.status = res.statusCode;
            err.body = json;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(wrap(e)));
    req.end(data);
  });
}

function wrap(e) {
  if (e.code) return e;
  const err = new Error(e.message || '网络错误');
  err.code = 'ERR_NET';
  return err;
}

/**
 * 下载一个媒体文件到本地。
 *   - 边写边算 sha256，不额外读一遍盘
 *   - 先写 <dest>.part，校验通过才改名成 dest —— 断电不会留下"看着存在其实半个"的文件
 *   - socket 空闲 90 秒算超时（慢网 22MB 视频约需 4 分钟，不能用总时长限制）
 * 返回 { sha256, bytes }；校验不符抛 ERR_SHA。
 */
function download(server, urlPath, destPath, { expectedSha, onProgress, signal } = {}) {
  const url = new URL(urlPath, server.endsWith('/') ? server : server + '/');
  const tmp = destPath + '.part';

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let received = 0;
    let total = 0;
    let lastEmit = 0;
    let settled = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { fs.unlinkSync(tmp); } catch { /* 删不掉留着，启动时会清 .part */ }
        reject(err);
      } else resolve(val);
    };

    const out = fs.createWriteStream(tmp);
    const req = pick(url).get(
      url,
      { agent: getAgent(url), timeout: 90_000, headers: { connection: 'keep-alive' } },
      (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          return done(Object.assign(new Error(`HTTP ${res.statusCode} 下载失败`), { status: res.statusCode }));
        }
        total = Number(res.headers['content-length'] || 0);

        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (onProgress && now - lastEmit > 120) {
            lastEmit = now;
            onProgress(received, total);
          }
        });
        res.on('error', (e) => { out.destroy(); done(wrap(e)); });
        res.pipe(out);
      }
    );

    req.on('timeout', () => req.destroy(Object.assign(new Error('下载超时'), { code: 'ERR_NET' })));
    req.on('error', (e) => { out.destroy(); done(wrap(e)); });
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }

    out.on('error', (e) => { req.destroy(); done(wrap(e)); });
    out.on('finish', () => {
      const sha = hash.digest('hex');
      if (expectedSha && sha !== expectedSha) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return done(Object.assign(new Error('校验不符'), { code: 'ERR_SHA', sha, expectedSha }));
      }
      try {
        fs.renameSync(tmp, destPath);      // 校验通过才落地，正式文件名只代表"完整内容"
      } catch (e) {
        return done(wrap(e));
      }
      if (onProgress) onProgress(received, total || received);
      done(null, { sha256: sha, bytes: received });
    });
  });
}

module.exports = { getJson, postJson, download };

// 在线VWI发布项目 · 服务端入口
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, seed, q } from './src/db.js';
import { initSecret, findMedia, serveMedia, verifyUrl, signUrl, mediaStats } from './src/media.js';
import { createRouter, sendJson } from './src/router.js';
import { buildSnapshot, preflight } from './src/model.js';
import { now, uid, int } from './src/util.js';

import { register as registerContent } from './src/api/content.js';
import { register as registerMediaApi } from './src/api/mediaApi.js';
import { register as registerRelease } from './src/api/release.js';
import { register as registerDisplay } from './src/api/display.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = '1.0.0';

// ---------- 初始化 ----------
fs.mkdirSync(DATA, { recursive: true });
openDb(DATA);
initSecret(DATA);
const seeded = seed();

const router = createRouter();
registerContent(router);
registerMediaApi(router);
registerRelease(router);
registerDisplay(router);

router.get('/api/health', (req, res) => {
  const ms = mediaStats();
  const online = q.get('SELECT COUNT(*) n FROM station WHERE last_seen > ?', now() - 90 * 1000).n;
  const stations = q.get('SELECT COUNT(*) n FROM station').n;
  sendJson(res, 200, {
    ok: true, version: VERSION, uptime: Math.round(process.uptime()),
    stations, online, media: ms,
    disk: diskFree()
  });
});

router.get('/api/system/info', (req, res) => {
  const lines = q.all('SELECT * FROM line').map((l) => ({
    id: l.id, code: l.code, name: l.name,
    activeSeq: l.active_release_id ? (q.get('SELECT seq FROM release WHERE id = ?', l.active_release_id) || {}).seq || 0 : 0
  }));
  sendJson(res, 200, { version: VERSION, lines, seeded: !!seeded.created });
});

// 首次启动自动发一版，让演示工位能立刻拉到内容
if (seeded.created) {
  for (const line of q.all('SELECT * FROM line')) {
    const problems = preflight(line.id);
    if (problems.length) {
      console.log(`[bootstrap] 产线 ${line.code} 预检未通过，跳过自动发布：`, problems);
      continue;
    }
    const snap = buildSnapshot(line.id);
    const id = uid('rl');
    snap.releaseId = id;
    snap.seq = 1;
    q.run(`INSERT INTO release(id,line_id,seq,title,note,manifest,digest,media_count,byte_size,created_at,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, line.id, 1, `${line.name} · 初始版本`, '首次启动自动生成',
      JSON.stringify(snap), snap.digest, Object.keys(snap.media).length, 0, now(), '');
    q.run('UPDATE line SET active_release_id = ? WHERE id = ?', id, line.id);
    console.log(`[bootstrap] 产线 ${line.code} 已自动发布 v1`);
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return res.writeHead(400).end('bad request');
  }
  const pathname = decodeURIComponent(url.pathname);

  // 媒体：签名校验 + Range
  if (pathname.startsWith('/m/')) {
    const id = pathname.slice(3);
    const m = findMedia(id);
    if (!m) return res.writeHead(404).end('媒体不存在');
    if (!verifyUrl(id, url.searchParams.get('e'), url.searchParams.get('s'))) {
      return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('链接已过期或签名不正确');
    }
    return serveMedia(req, res, m);
  }

  // API
  const handled = await router.handle(req, res, {});
  if (handled || res.headersSent) return;

  // 静态资源
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.writeHead(405).end('method not allowed');
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end('forbidden');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<meta charset="utf-8"><h3>404</h3><p>页面不存在。<a href="/">回到管理端</a></p>');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

const PORT = int(process.env.VWI_PORT || process.argv.find((a) => a.startsWith('--port='))?.split('=')[1], 8091);

server.listen(PORT, () => {
  console.log('');
  console.log('  在线VWI发布项目 v' + VERSION);
  console.log('  ────────────────────────────────');
  console.log('  管理端   http://127.0.0.1:' + PORT + '/');
  console.log('  终端画面 http://127.0.0.1:' + PORT + '/display?code=工位编码&token=令牌');
  console.log('  数据目录 ' + DATA);
  if (seeded.created) {
    console.log('');
    console.log('  已生成演示数据：总装一线 L01，工位 L01-OP10 / OP30 / OP50');
    console.log('  到「终端管理」生成令牌即可打开画面。');
  }
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
});

function diskFree() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(DATA);
      return { freeGB: +(Number(st.bavail) * Number(st.bsize) / 1e9).toFixed(1) };
    }
  } catch { /* 忽略 */ }
  return null;
}

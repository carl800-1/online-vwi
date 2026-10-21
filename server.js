// 在线 VWI 发布系统 · 服务端入口
// 层级：型号 → 工序 → 播放清单，到此为止（没有工位）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, seed, q } from './src/db.js';
import { findMedia, serveMedia, mediaStats } from './src/media.js';
import { createRouter } from './src/router.js';
import { initSwitch } from './src/switch.js';
import { int } from './src/util.js';

import { register as registerCatalog } from './src/api/catalog.js';
import { register as registerPlaylist } from './src/api/playlist.js';
import { register as registerMediaApi } from './src/api/mediaApi.js';
import { register as registerState } from './src/api/state.js';
import { register as registerDisplay } from './src/api/display.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.VWI_DATA || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
// 版本号只认 package.json 一处，避免服务端横幅和包版本各说各话
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ---------- 初始化 ----------
fs.mkdirSync(DATA, { recursive: true });
openDb(DATA);
const seeded = seed();
initSwitch();

const router = createRouter();
registerCatalog(router);
registerPlaylist(router);
registerMediaApi(router);
registerState(router);
registerDisplay(router);

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

  // 媒体文件：支持 Range，视频拖动与断点续传都靠它
  if (pathname.startsWith('/m/')) {
    const m = findMedia(pathname.slice(3));
    if (!m) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('媒体不存在');
    return serveMedia(req, res, m);
  }

  const handled = await router.handle(req, res, {});
  if (handled || res.headersSent) return;

  // 静态资源
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.writeHead(405).end('method not allowed');
  }
  const rel = pathname === '/' ? '/index.html' : pathname;
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
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

const PORT = int(process.env.VWI_PORT || process.argv.find((a) => a.startsWith('--port='))?.split('=')[1], 8092);

server.listen(PORT, () => {
  const ms = mediaStats();
  const cov = q.get('SELECT COUNT(*) n FROM item').n;
  const lan = lanAddresses();

  console.log('');
  console.log('  在线 VWI 发布系统 v' + VERSION);
  console.log('  ────────────────────────────────────────────');
  console.log('  管理端    http://127.0.0.1:' + PORT + '/');
  console.log('  终端画面  http://127.0.0.1:' + PORT + '/player.html?op=OP30');
  console.log('  数据目录  ' + DATA);
  console.log('  内容      ' + cov + ' 条清单项，媒体 ' + ms.count + ' 个 / ' + (ms.bytes / 1048576).toFixed(1) + 'MB');
  if (seeded.created) {
    console.log('');
    console.log('  已生成：' + seeded.models + ' 个型号 × ' + seeded.processes + ' 道工序（内容为空，等工程部填）');
  }
  if (lan.length) {
    console.log('');
    console.log('  局域网访问（终端装机器上填这个）：');
    for (const a of lan) console.log('    http://' + a + ':' + PORT);
  }
  console.log('');
});

// 局域网 IPv4：终端要填服务器地址，装的时候省得去 ipconfig 里翻
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
});

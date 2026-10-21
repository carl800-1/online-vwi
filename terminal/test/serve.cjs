// 预览用的极简静态服务器：只是为了能用浏览器打开 test/preview.html。
// 不参与交付，也不做目录穿越防护之外的安全措施 —— 监听 127.0.0.1。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);      // terminal/
const PORT = Number(process.env.PORT) || 8099;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8'
};

http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  const p = path.normalize(path.join(ROOT, u));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404).end('not found: ' + u); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`预览服务器 http://127.0.0.1:${PORT}/test/preview.html?s=1`);
});

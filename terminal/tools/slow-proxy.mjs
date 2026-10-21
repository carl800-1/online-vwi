// 限速代理：把 /m/<id> 的下载速度卡住，用来复现"A10 掉队的那台"。
// 为什么需要它：本地回环下 5MB 也是秒下，掉队场景根本不会发生；
// 真实现场的弱网又没法在工位上复现。代理是可控的替代品。
//
// 用法：node tools/slow-proxy.cjs [监听端口] [目标] [每秒字节数]
//   POST /_slow/on  → 开始限速      POST /_slow/off → 取消限速
//   GET  /_slow     → 查看当前状态
import http from 'node:http';

const LISTEN = Number(process.argv[2] || 8095);
const TARGET = new URL(process.argv[3] || 'http://127.0.0.1:8092');
const RATE = Number(process.argv[4] || 10240);   // 默认 10 KB/s

let slow = false;

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/_slow')) {
    if (req.url.endsWith('/on')) slow = true;
    if (req.url.endsWith('/off')) slow = false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ slow, rate: RATE }));
    return;
  }

  const upstream = http.request({
    hostname: TARGET.hostname,
    port: TARGET.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TARGET.host }
  }, (up) => {
    const isMedia = req.url.startsWith('/m/');
    const headers = { ...up.headers };
    delete headers['transfer-encoding'];      // 限速后要按块写，长度由我们自己控制
    res.writeHead(up.statusCode, headers);

    if (!slow || !isMedia) {
      up.pipe(res);
      return;
    }

    // 限速：每 200ms 放行 RATE/5 字节
    const chunk = Math.max(1, Math.floor(RATE / 5));
    let paused = false;
    up.on('data', (buf) => {
      if (paused) return;
      let offset = 0;
      const push = () => {
        if (offset >= buf.length) return;
        const slice = buf.subarray(offset, offset + chunk);
        offset += slice.length;
        const ok = res.write(slice);
        if (offset < buf.length || !ok) {
          paused = true;
          up.pause();
          setTimeout(() => { paused = false; up.resume(); push(); }, 200);
        } else {
          push();
        }
      };
      push();
    });
    up.on('end', () => res.end());
    up.on('error', () => res.destroy());
  });

  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('上游不可达：' + e.message);
  });

  req.pipe(upstream);
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`限速代理已启动 http://127.0.0.1:${LISTEN} → ${TARGET.origin}，限速 ${RATE} B/s（默认关闭）`);
});

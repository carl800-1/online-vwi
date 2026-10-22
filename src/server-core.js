// ESOP 发布系统 · 服务端核心
//
// 原来这段逻辑整个塞在 server.js 里，只有命令行能跑。现在剥出来是为了让同一份
// 服务被三种入口复用：
//   1. node server.js              源码运行 / 绿色免装包
//   2. release\启动服务端.bat      绿色包双击
//   3. server-gui\main.js          Electron 桌面版（图形界面，无浏览器）
//
// 这层不碰命令行、不打印横幅、不注册信号量 —— 那些交给调用方。
// 换句话说：这里只负责「把 HTTP 服务跑起来」，界面长什么样不归它管。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, seed, ensureDefaultProfile, q } from './db.js';
import { findMedia, serveMedia, mediaStats } from './media.js';
import { createRouter } from './router.js';
import { initSwitch } from './switch.js';
import { int } from './util.js';
import { VERSION } from './version.js';

import { register as registerCatalog } from './api/catalog.js';
import { register as registerPlaylist } from './api/playlist.js';
import { register as registerMediaApi } from './api/mediaApi.js';
import { register as registerState } from './api/state.js';
import { register as registerDisplay } from './api/display.js';
import { register as registerProfiles } from './api/profiles.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2'
};

// 同一进程只允许起一个实例。模块级状态（db 句柄、切换状态机、长轮询等待集）
// 都是单例，重复初始化会直接把状态搅乱，所以这里做成幂等。
let instance = null;

// 虚拟网卡的名字特征。这些网卡也有 IPv4、也不是 internal，但**终端连不上**：
//   - Hyper-V 的 vEthernet (Default Switch) 常见 172.x，而且往往排在真网卡前面
//   - VMware / VirtualBox 的仅主机网卡、WSL / Docker 的桥
//   - 各类 VPN 与蓝牙 PAN
// 现场最典型的翻车：运维照着列表第一条地址填进 5 台终端，5 台全连不上，
// 还以为是网络或服务端问题，排查半天。所以这里必须过滤 + 排序，不能只判 internal。
const VIRTUAL_NIC_HINTS = [
  'vethernet', 'hyper-v', 'vmware', 'virtualbox', 'vbox',
  'wsl', 'docker', 'loopback', 'bluetooth', '蓝牙',
  'vpn', 'tap-', 'tun', 'zerotier', 'tailscale', 'hamachi', 'npcap'
];

function isVirtualNic(name, address) {
  const n = (name || '').toLowerCase();
  if (VIRTUAL_NIC_HINTS.some((h) => n.includes(h))) return true;
  // 169.254.x.x 是 DHCP 失败后的自动地址（APIPA），同网段终端根本 ping 不到
  if (address.startsWith('169.254.')) return true;
  return false;
}

/**
 * 列出终端能用来连服务端的地址，按「最可能可用」排前面。
 * 返回 [{ name, address }]，name 是网卡名，界面上标出来便于现场核对。
 */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ name, address: ni.address, virtual: isVirtualNic(name, ni.address) });
    }
  }
  // 真网卡优先；同类里按常见内网段排序（192.168 > 10 > 172.16-31 > 其它）
  const rank = (x) => {
    const a = x.address;
    let seg = 3;
    if (a.startsWith('192.168.')) seg = 0;
    else if (a.startsWith('10.')) seg = 1;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) seg = 2;
    return (x.virtual ? 10 : 0) + seg;
  };
  return out
    .sort((a, b) => rank(a) - rank(b))
    .map(({ name, address }) => ({ name, address }));
}

// 命令行里的 --port=8080
export function portFromArgv(argv = process.argv) {
  const hit = argv.find((a) => a.startsWith('--port='));
  return hit ? hit.split('=')[1] : '';
}

/**
 * 组装并返回服务实例（不 listen）。
 * @param {object} opts
 * @param {string} opts.root  代码根目录。默认取本文件的上上级（项目根）
 * @param {string} opts.data  数据目录。默认 root/data
 * @param {string} opts.publicDir 静态资源目录。默认 root/public
 * @param {number|string} opts.port 监听端口。默认 ESOP_PORT（兼容旧名 VWI_PORT），再默认 8092
 */
export function startServer(opts = {}) {
  if (instance) return instance;

  const ROOT = opts.root || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const DATA = opts.data || process.env.ESOP_DATA || process.env.VWI_DATA || path.join(ROOT, 'data');
  const PUBLIC = opts.publicDir || path.join(ROOT, 'public');
  // 版本号统一从 src/version.js 取，只认 package.json 一处。
  const PORT = int(opts.port || process.env.ESOP_PORT || process.env.VWI_PORT || portFromArgv() || 8092, 8092);

  fs.mkdirSync(DATA, { recursive: true });
  openDb(DATA);
  const seeded = seed();
  ensureDefaultProfile();
  initSwitch();

  const router = createRouter();
  registerCatalog(router);
  registerPlaylist(router);
  registerMediaApi(router);
  registerState(router);
  registerDisplay(router);
  registerProfiles(router);

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
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });

  instance = {
    server,
    router,
    root: ROOT,
    data: DATA,
    publicDir: PUBLIC,
    port: PORT,
    version: VERSION,
    seeded
  };
  return instance;
}

/**
 * 起服务并等端口就绪。
 *
 * 端口以本次传入的 opts.port 为准，这样桌面版遇到 EADDRINUSE 时能换个端口
 * 再调一次 —— 注意 startServer 是幂等的，同一进程只会建一次实例，
 * 但没 listen 成功的 server 对象可以重新 listen。
 */
export function listen(opts = {}) {
  const inst = startServer(opts);
  const port = int(opts.port, inst.port);
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      inst.server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      inst.server.removeListener('error', onError);
      inst.port = inst.server.address().port;
      resolve({ ...inst, actualPort: inst.port });
    };
    inst.server.once('error', onError);
    inst.server.once('listening', onListening);
    inst.server.listen(port);
  });
}

/** 启动横幅要用的概览数据，命令行和桌面界面共用一份。 */
export function summary(inst) {
  const ms = mediaStats();
  return {
    version: inst.version,
    data: inst.data,
    models: q.get('SELECT COUNT(*) n FROM model WHERE enabled = 1').n,
    processes: q.get('SELECT COUNT(*) n FROM process').n,
    items: q.get('SELECT COUNT(*) n FROM item').n,
    mediaCount: ms.count,
    mediaBytes: ms.bytes,
    lan: lanAddresses()
  };
}

/** 已在运行时返回实例，否则 null。给桌面界面判断「是不是我自己在占用端口」。 */
export function current() {
  return instance;
}

export default { startServer, listen, summary, current, lanAddresses, portFromArgv };
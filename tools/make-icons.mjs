// 生成 ESOP 应用图标（ico 多尺寸 + 256 png + 托盘 png）。
// 为什么不用 Pillow / ImageMagick：本机没装，也不该为了一个图标去装。
// 做法：把图标写成 SVG，用无头 Edge 按**目标像素尺寸**逐张渲染成 PNG
//       （16/24/32/48/64/128/256 各自独立渲染，不是拿 256 缩出来，
//         小尺寸才不会被插值糊掉），再把这几张 PNG 塞进 ICO。
//
// 用法：node tools/make-icons.mjs
// 产出：server-gui/assets/{icon.ico,icon-256.png,tray.png}
//       terminal/assets/{icon.ico,icon-256.png,tray.png}
//
// 视觉与左侧栏品牌标（public/index.html 的 #i-brand）同源：
// 蓝色渐变圆角方块 + 白色屏幕 + 两行内容，一眼能认出是同一个程序。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'node_modules', '.cache', 'esop-icons');
const EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ── 图标本体：256 网格 ───────────────────────────────────────────────
// 圆角半径按 Windows 11 图标习惯取 22%；留 6 的透明边，避免贴边发毛。
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#5F9AF9"/>
      <stop offset="1" stop-color="#2563EB"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="244" height="244" rx="54" fill="url(#bg)"/>
  <rect x="42" y="48" width="172" height="124" rx="18" fill="#FFFFFF"/>
  <rect x="66" y="78" width="124" height="15" rx="7.5" fill="#2563EB"/>
  <rect x="66" y="106" width="84" height="15" rx="7.5" fill="#2563EB" opacity="0.62"/>
  <rect x="112" y="172" width="32" height="18" fill="#FFFFFF"/>
  <rect x="88" y="188" width="80" height="16" rx="8" fill="#FFFFFF"/>
</svg>`;

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function renderPng(size) {
  const dir = path.join(TMP, `s${size}`);
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, 'icon.html');
  const png = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${SVG}`);
  fs.rmSync(png, { force: true });
  execFileSync(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--default-background-color=00000000',   // 透明底，否则截图带白底
    `--user-data-dir=${path.join(dir, 'profile')}`,
    `--window-size=${size},${size}`,
    '--force-device-scale-factor=1',
    `--screenshot=${png}`,
    'file:///' + html.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });
  if (!fs.existsSync(png)) throw new Error(`渲染失败：${size}px`);
  return fs.readFileSync(png);
}

// ── ICO 打包：ICONDIR + N×ICONDIRENTRY + PNG 数据 ────────────────────
// Vista 之后 ICO 允许直接内嵌 PNG。这里**每档都塞自己的 PNG**，
// 目录项里写真实宽高，系统就不会拿 256 去插值。
function buildIco(pngs) {
  const n = pngs.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);      // reserved
  head.writeUInt16LE(1, 2);      // type = icon
  head.writeUInt16LE(n, 4);      // count
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);      // 0 表示 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);                        // 调色板数
    dir.writeUInt8(0, o + 3);                        // reserved
    dir.writeUInt16LE(1, o + 4);                     // planes
    dir.writeUInt16LE(32, o + 6);                    // bpp
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}

const rendered = SIZES.map((size) => ({ size, buf: renderPng(size) }));
const ico = buildIco(rendered);
const png256 = rendered.find((r) => r.size === 256).buf;
const tray = rendered.find((r) => r.size === 32).buf;

const targets = [
  path.join(ROOT, 'server-gui', 'assets'),
  path.join(ROOT, 'terminal', 'assets'),
];
for (const dir of targets) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
  fs.writeFileSync(path.join(dir, 'icon-256.png'), png256);
  fs.writeFileSync(path.join(dir, 'tray.png'), tray);
  console.log(`已写入 ${path.relative(ROOT, dir)}：icon.ico ${ico.length} B（${SIZES.join('/')}）`);
}

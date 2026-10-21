// 生成验收用测试图（1920x1080 PNG），零依赖：自带 zlib + 5x7 点阵字模。
// 为什么不用图片库：本机没有 Pillow，PowerShell 的 System.Drawing 也不可用；
// 而验收只需要"一眼能分辨型号/工序"的大字，点阵足够。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 1920;
const H = 1080;

const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function makeCanvas(bg) {
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2];
  }
  return px;
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

function fillRect(px, x0, y0, w, h, rgb) {
  const x1 = Math.min(W, x0 + w);
  const y1 = Math.min(H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      const o = (y * W + x) * 3;
      px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
    }
  }
}

// 点阵文字：cell 是一个点的像素边长，字宽 5 cell、间距 1 cell
function drawText(px, text, x, y, cell, rgb) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] === '1') fillRect(px, cx + col * cell, y + row * cell, cell, cell, rgb);
      }
    }
    cx += 6 * cell;
  }
  return cx;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                       // 每行 filter = None
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const PROCS = [
  { code: 'OP10', color: '#e5484d' },
  { code: 'OP20', color: '#30a46c' },
  { code: 'OP30', color: '#f5a524' },
  { code: 'OP40', color: '#8e4ec6' },
  { code: 'OP50', color: '#0ea5e9' }
];

const MODEL = process.argv[2] || 'X210';
// --noise=N：每 N 个像素掺一个随机点，做成接近不可压缩的大图（用来验证 A8 的目录体量，真实内容多为 MB 级）
const noiseArg = process.argv.find((a) => a.startsWith('--noise='));
const NOISE = noiseArg ? Math.max(1, Number(noiseArg.split('=')[1]) || 3) : 0;
const countArg = process.argv.find((a) => a.startsWith('--count='));
const COPIES = countArg ? Math.max(1, Number(countArg.split('=')[1]) || 1) : 1;
const outDir = path.join(__dirname, 'probe', 'media');
fs.mkdirSync(outDir, { recursive: true });

let seed = (MODEL.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 7919 + 20261021) & 0x7fffffff;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

for (const p of PROCS) {
  for (let k = 1; k <= COPIES; k++) {
    const accent = hex(p.color);
    const px = makeCanvas([11, 15, 20]);

    fillRect(px, 0, 0, W, 90, accent);                          // 顶部色带
    fillRect(px, 0, H - 90, W, 90, [22, 28, 38]);               // 底部信息条

    drawText(px, MODEL, 100, 150, 32, [255, 255, 255]);          // 型号字高 224px
    drawText(px, p.code, 100, 560, 22, accent);                  // 工序字高 154px
    drawText(px, `${MODEL}-${p.code}-${k}`, 100, H - 70, 7, [160, 170, 185]);

    // 右下角线宽标尺：1..10 px 竖线，供 1 米距离细节观察（A7）
    for (let i = 1; i <= 10; i++) {
      const x = 1240 + i * 26;
      fillRect(px, x, 880 - i * 4, i, 120 + i * 4, [255, 255, 255]);
    }

    if (NOISE) {
      for (let i = 0; i < W * H; i += NOISE) {
        const v = Math.floor(rnd() * 256);
        px[i * 3] = v; px[i * 3 + 1] = v; px[i * 3 + 2] = v;
      }
    }

    const suffix = COPIES > 1 ? `-${k}` : '';
    const file = path.join(outDir, `${MODEL.toLowerCase()}-${p.code.toLowerCase()}${suffix}.png`);
    fs.writeFileSync(file, encodePng(px));
    console.log(`生成 ${file} ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  }
}

// 媒体仓库：内容寻址存储（CAS）+ Range 播放支持
// 一期内网部署、无攻击面诉求，不做签名 URL（技术方案 3 节：/m/:id 直接可访问）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as mupdf from 'mupdf';
import { q, mediaDir } from './db.js';
import { now, uid } from './util.js';

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov'
};

const PDF_MIME = 'application/pdf';

function pickMime(name, given) {
  if (given && given !== 'application/octet-stream') return given;
  const ext = (path.extname(name || '').slice(1) || '').toLowerCase();
  if (ext === 'pdf') return PDF_MIME;
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  return given || 'application/octet-stream';
}

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function casPath(sha, ext) {
  return path.join(mediaDir(), sha.slice(0, 2), `${sha}.${ext}`);
}

// ───────────────────────── PDF 拆页 ─────────────────────────

/** 单页渲染目标框（像素）。1280×1024 的屏，留 1.5 倍余量给"放大看细节"。 */
const PDF_BOX_W = 1920;
const PDF_BOX_H = 1536;
/** 页数上限：200 页 A4 已经远超"一道工序的作业指导书"体量，再多多半是选错文件 */
const PDF_MAX_PAGES = 200;

/**
 * 把一份 PDF 逐页渲染成 PNG，每页作为一条独立 image 记录入库。
 *
 * 为什么拆页而不是存原 PDF 让终端自己显示：
 *   终端播放器只有 `<img>` 和 `<video>` 两层，"翻到下一项"是队列驱动的。
 *   PDF 塞进去就得在内嵌阅读器里另做一套翻页控制，5 台机的浏览器行为还不一致。
 *   拆成图片后，PDF 和普通图片在终端眼里完全一样 —— 终端一行代码都不用改，
 *   翻页节奏、缓存、断点续传全部现成。代价只是媒体库里多出 N 条记录。
 *
 * 去重分两层：同一页可以跨型号复用（按 PNG 的 sha）；同一个 PDF 重复上传时
 * 直接按 src_sha 命中已拆好的全部页，不再渲染。
 */
function expandPdf(filePath, { name, sha }) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(filePath), PDF_MIME);
  } catch (e) {
    throw new Error('这个 PDF 打不开（可能已加密或文件损坏）：' + e.message);
  }

  const n = doc.countPages();
  if (!n) throw new Error('PDF 里没有任何页面');
  if (n > PDF_MAX_PAGES) throw new Error(`PDF 有 ${n} 页，超过单份上限 ${PDF_MAX_PAGES} 页`);

  const base = String(name).replace(/\.pdf$/i, '').slice(0, 170) || 'PDF';
  const pages = [];

  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0) || !(h > 0)) throw new Error(`第 ${i + 1} 页尺寸异常`);

    // 等比缩放塞进目标框：竖版 A4 会按高度封顶，横版按宽度封顶，都不裁切
    const scale = Math.min(PDF_BOX_W / w, PDF_BOX_H / h);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const png = Buffer.from(pix.asPNG());

    const pageSha = crypto.createHash('sha256').update(png).digest('hex');
    const exist = q.get('SELECT * FROM media WHERE sha256 = ?', pageSha);
    if (exist) {
      // 同样的页面已经在了（比如另一份 PDF 里有一模一样的页），直接复用
      pages.push(exist);
      continue;
    }

    const pid = pageSha.slice(0, 16);
    const target = casPath(pageSha, 'png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, png);

    q.run(
      `INSERT INTO media(id,sha256,kind,ext,mime,bytes,width,height,duration_ms,name,src_sha,page_no,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pid, pageSha, 'image', 'png', 'image/png', png.length,
      pix.getWidth(), pix.getHeight(), 0,
      `${base} · 第 ${i + 1} 页`, sha, i + 1, now()
    );
    pages.push(q.get('SELECT * FROM media WHERE id = ?', pid));
  }

  return { kind: 'pdf', pages, pageCount: n, duplicated: false };
}

/**
 * 读图片宽高（只处理 PNG / JPEG，够用且零依赖）。
 * 为什么值得做：19 寸是 5:4 屏，16:9 的图上下各浪费 152px，实得只有 25% 面积。
 * 上传时拿到宽高就能当场提醒工程部，而不是等屏上糊了才发现。
 */
export function imageSize(buf) {
  try {
    // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 紧接其后，宽高在 16..23
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: FFD8 开头，逐段找 SOFn（C0-CF，排除 C4/C8/CC）
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch { /* 解析失败就当不知道，不阻塞上传 */ }
  return { width: 0, height: 0 };
}

/**
 * 把上传流落盘。先写临时文件并同步算 sha256，再原子改名到 CAS 位置；
 * 内容已存在时直接删除临时文件（天然去重）。
 */
export function saveStream(readable, { name = '', mime = '' } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(mediaDir(), { recursive: true });
    const tmp = path.join(mediaDir(), '.tmp-' + uid('up'));
    const ws = fs.createWriteStream(tmp);
    const h = crypto.createHash('sha256');
    // 只留前 64KB 用于解析图片宽高，不把整个文件读进内存
    const head = [];
    let headLen = 0;
    let size = 0;
    let aborted = false;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      readable.destroy();
      ws.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };

    readable.on('data', (chunk) => {
      size += chunk.length;
      h.update(chunk);
      if (headLen < 65536) {
        head.push(chunk);
        headLen += chunk.length;
      }
      if (size > 512 * 1024 * 1024) fail(new Error('单个文件不得超过 512MB'));
    });
    readable.on('error', fail);
    ws.on('error', fail);

    readable.pipe(ws);
    ws.on('finish', () => {
      if (aborted) return;
      try {
        const sha = h.digest('hex');
        const finalMime = pickMime(name, mime);

        // PDF 走另一条路：不把自己存成媒体，而是拆成逐页 PNG 入库
        if (finalMime === PDF_MIME) {
          const done = q.all('SELECT * FROM media WHERE src_sha = ? ORDER BY page_no', sha);
          if (done.length) {
            fs.rmSync(tmp, { force: true });
            return resolve({ kind: 'pdf', pages: done, pageCount: done.length, duplicated: true });
          }
          const r = expandPdf(tmp, { name, sha });
          fs.rmSync(tmp, { force: true });
          return resolve(r);
        }

        const ext = path.extname(name).slice(1).toLowerCase() || MIME_EXT[finalMime] || 'bin';
        const id = sha.slice(0, 16);

        const exist = q.get('SELECT * FROM media WHERE sha256 = ?', sha);
        if (exist) {
          fs.rmSync(tmp, { force: true });
          return resolve({ ...exist, duplicated: true });
        }

        const target = casPath(sha, ext);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(tmp, target);

        const kind = kindOf(finalMime);
        const dim = kind === 'image' ? imageSize(Buffer.concat(head)) : { width: 0, height: 0 };

        q.run(
          `INSERT INTO media(id,sha256,kind,ext,mime,bytes,width,height,duration_ms,name,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          id, sha, kind, ext, finalMime, size, dim.width, dim.height, 0,
          String(name).slice(0, 200), now()
        );
        resolve({ ...q.get('SELECT * FROM media WHERE id = ?', id), duplicated: false });
      } catch (e) {
        fail(e);
      }
    });
  });
}

export function findMedia(id) {
  return q.get('SELECT * FROM media WHERE id = ?', String(id || ''));
}

export function diskPathOf(m) {
  if (!m) return '';
  return casPath(m.sha256, m.ext);
}

/** 支持 Range 的媒体响应：视频拖动、断点续传都依赖它 */
export function serveMedia(req, res, m) {
  const file = diskPathOf(m);
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('媒体文件缺失');
  }
  const total = fs.statSync(file).size;
  const baseHeaders = {
    'Content-Type': m.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=604800, immutable',
    ETag: `"${m.sha256.slice(0, 20)}"`
  };

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  const m2 = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m2) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  let start = m2[1] === '' ? null : parseInt(m2[1], 10);
  let end = m2[2] === '' ? null : parseInt(m2[2], 10);
  if (start === null && end === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  if (start === null) {
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  res.writeHead(206, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

export function mediaStats() {
  const row = q.get('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM media');
  return { count: row.n, bytes: row.bytes };
}

/**
 * 清理没有任何清单项引用的媒体。
 * 默认 dryRun，只报告不删 —— 工程部编辑清单时会出现"刚删了又加回来"的中间态，
 * 自动清理容易误删正在用的文件。
 */
export function collectGarbage(dryRun = true) {
  const used = new Set(q.all('SELECT DISTINCT media_id FROM item').map((r) => r.media_id));
  const orphans = q.all('SELECT * FROM media').filter((m) => !used.has(m.id));
  if (!dryRun) {
    for (const m of orphans) {
      fs.rmSync(diskPathOf(m), { force: true });
      q.run('DELETE FROM media WHERE id = ?', m.id);
    }
  }
  return {
    total: orphans.length,
    bytes: orphans.reduce((s, m) => s + m.bytes, 0),
    list: orphans.map((m) => ({ id: m.id, name: m.name, bytes: m.bytes })),
    dryRun
  };
}

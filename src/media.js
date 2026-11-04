// 媒体仓库：按「机种 / 工序」实存，内容哈希只用来校验
//
// 4.4.0 起磁盘布局不再是随机哈希目录：
//   data/media/<机种编号>/<工序码>/<原文件名>.<ext>
//   例：data/media/X200/OP1/装配示意图.png
//      data/media/X200/OP1/装配作业指导书.pdf      ← 原件留档
//      data/media/X200/OP1/装配作业指导书_p01.png  ← 播放用的页
//   没归属的文件（在媒体库右上角直接传的）落在 media/_未分配/ 或 <机种编号>/_未分配/。
//
// 机种这一层用**编号**（唯一、稳定、改名不影响），不用名称 ——
// 名称是中文、可随时改，而且全厂重名严重（一份工时表里 206 个机种都叫「小型角向磨光机」），
// 拿来当目录会让它们全挤进一个文件夹，文件只能靠 -2、-3 区分。
// 工序这一层用**工序码原样**（OP1 就是 OP1），和界面、接口参数一致。
// 不按排序现场编号（1、2、3…）：中间插一道工序会让后面所有目录改名、几千条 rel_path 重写，
// 而工序码是唯一的、稳定的，改码本身就会触发目录改名。
//
// 为什么不再用内容寻址：现场要能打开文件夹就知道"这个机种这台屏用了什么"，
// 备份/迁移直接拎文件夹，出问题能人工替换。代价是同一份图被两个机种用时会各存一份
// —— 这是明知的选择：真正占盘的视频几乎不会跨机种重复，去重省不下多少，可读性省不了。
//
// 内容哈希仍然保留（media.sha256）：用于完整性校验、ETag、断点续传与重复上传识别。
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
/** 没有机种/工序归属的文件先落这里，绑定时由 adoptMedia() 搬进正式目录 */
const POOL = '_未分配';

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

// ───────────────────────── 路径与文件名 ─────────────────────────

/**
 * 机种目录段：机种编号（`X200`、`CR13VCA1`）本来就被界面限制成
 * `^[A-Za-z0-9._-]{1,32}$`，理论上天然合法，但仍然清洗 —— 老库里可能留着脏编号，
 * 而且 `..` 这种也能过正则，不能让它拼出 media/../.. 把文件写到数据目录外面去。
 * 名称不进路径：名称是中文、可随时改，而且全厂重名严重（一份工时表里 206 个机种都叫
 * 「小型角向磨光机」），拿来当目录会让它们全挤进一个文件夹。
 */
function modelSeg(code) {
  let v = String(code || '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  v = v.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/\.+$/, '');
  return (v || 'M').slice(0, 40);
}

/**
 * 工序目录段：**工序码原样**（OP1 → OP1），不转换大小写。
 * 好处是目录名和界面上的工序码、`?op=OP1` 这个接口参数完全一致，对照时不用换脑子；
 * 代价只是目录里大小写混着（`OP1` 与 `_未分配`），不影响任何行为 —— Windows/macOS
 * 的默认文件系统都对大小写不敏感，两种写法指向同一个文件夹。
 * 纯数字码才补 `op` 前缀，否则目录里看不出这层是工序。
 */
function opSeg(code) {
  let v = String(code || '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  v = v.replace(/\.{2,}/g, '.').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!v) return 'OP';
  if (/^\d/.test(v)) v = 'op' + v;   // 纯数字码补前缀，目录里一眼看出这层是工序
  return v.slice(0, 40);
}

/** 文件名主干：保留中文，替换 Windows 非法字符，避开保留名，控制长度 */
function fileBase(name, fallback = 'file') {
  let v = String(name || '');
  v = v.replace(/\.[^.\/\\]*$/, '');                       // 去扩展名（只去最后一段）
  v = v.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');             // Windows 非法字符
  v = v.replace(/\s+/g, ' ').trim();
  v = v.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');      // 首尾的点和空格会被资源管理器吃掉
  if (!v) v = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)) v = '_' + v;
  return v.slice(0, 90);
}

function safeExt(v, fallback = 'bin') {
  const e = String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e || fallback;
}

/** 机种文件夹名（相对 media/ 的第一段）：就是机种编号 */
export function modelDirOf(m) {
  return m ? modelSeg(m.code) : '';
}

/** 归属目录（相对 media/，统一用 / 存库，跨平台） */
function relDirOf({ modelId = '', processId = '' } = {}) {
  const mid = String(modelId || '');
  const pid = String(processId || '');
  const m = mid ? q.get('SELECT id, code, name FROM model WHERE id = ?', mid) : null;
  if (!m) return POOL;
  const segs = [modelDirOf(m)];
  if (!pid) return segs.concat(POOL).join('/');
  const p = q.get('SELECT code, model_id FROM process WHERE id = ?', pid);
  if (!p || p.model_id !== mid) return segs.concat(POOL).join('/');
  return segs.concat(opSeg(p.code)).join('/');
}

function absDirOf(rel) {
  return path.join(mediaDir(), ...String(rel).split('/').filter(Boolean));
}

function shaOfFile(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * 目标文件名：同名且同内容 → 直接复用那份；同名不同内容 → 追加 -2、-3。
 * 不覆盖是硬规矩：覆盖会让还指向旧文件的 item 变成"指向幽灵"，
 * 而且现场人工替换文件时也没法回退。
 */
function uniqueTarget(dirAbs, base, ext, sha) {
  for (let i = 1; i <= 300; i += 1) {
    const name = i === 1 ? `${base}.${ext}` : `${base}-${i}.${ext}`;
    const abs = path.join(dirAbs, name);
    if (!fs.existsSync(abs)) return { abs, name };
    const st = fs.statSync(abs);
    if (st.isFile() && sha) {
      // 大文件先比大小，大小都不一样就别算哈希了
      if (st.size >= 0 && shaOfFile(abs) === sha) return { abs, name, same: true };
    }
  }
  throw new Error(`同名文件太多，先整理一下目录：${base}.${ext}`);
}

/** 跨盘 rename 会 EXDEV，退化成复制 + 删源 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/**
 * 媒体 id 仍然是 16 位十六进制，但不再等于 sha 前 16 位 ——
 * 同一个内容在两个机种下是两条记录、两个 id。前半段取内容哈希（便于人眼核对），
 * 后半段取路径哈希（同内容不同机种自然分开），撞了再随机。
 */
function mediaIdFor(sha, relPath) {
  const tail = crypto.createHash('sha256').update(String(relPath)).digest('hex').slice(0, 4);
  let id = sha.slice(0, 12) + tail;
  // 撞上别人的 id 才换随机尾巴；同一份（同 sha 同路径）本来就该复用，但调用方
  // 在此之前已经按 rel_path 查过了，走到这里的一定是新文件
  for (let i = 0; i < 8; i += 1) {
    if (!q.get('SELECT id FROM media WHERE id = ?', id)) return id;
    id = sha.slice(0, 12) + crypto.randomBytes(2).toString('hex');
  }
  return crypto.randomBytes(8).toString('hex');
}

function insertMedia(row) {
  const id = mediaIdFor(row.sha, row.relPath);
  q.run(
    `INSERT INTO media
     (id,sha256,model_id,process_id,rel_path,kind,ext,mime,bytes,width,height,duration_ms,name,src_sha,page_no,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, row.sha, String(row.modelId || ''), String(row.processId || ''), row.relPath,
    row.kind, row.ext, row.mime, row.bytes, row.width || 0, row.height || 0,
    row.durationMs || 0, row.name, row.srcSha || '', row.pageNo || 0, now()
  );
  return q.get('SELECT * FROM media WHERE id = ?', id);
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
 *   翻页节奏、缓存、断点续传全部现成。
 *
 * 页面按页内容哈希判断"这页已经在了"，所以同一份 PDF 重传不会再多出一套图。
 * 原件（.pdf）另外留一份在同一目录，只作留档：终端不播它，`kind='source'`。
 */
function expandPdf(filePath, { name, sha, rel, dirAbs, modelId, processId }) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(filePath), PDF_MIME);
  } catch (e) {
    throw new Error('这个 PDF 打不开（可能已加密或文件损坏）：' + e.message);
  }

  const n = doc.countPages();
  if (!n) throw new Error('PDF 里没有任何页面');
  if (n > PDF_MAX_PAGES) throw new Error(`PDF 有 ${n} 页，超过单份上限 ${PDF_MAX_PAGES} 页`);

  const base = fileBase(name, 'PDF');
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

    // 单页 PDF 不带 _p01 后缀，多页才编号 —— 现场看到的就是"一份文件"
    const pageBase = n > 1 ? `${base}_p${String(i + 1).padStart(2, '0')}` : base;
    const t = uniqueTarget(dirAbs, pageBase, 'png', pageSha);
    if (!t.same) fs.writeFileSync(t.abs, png);

    const relPath = `${rel}/${t.name}`;
    const name2 = n > 1 ? `${base} · 第 ${i + 1} 页` : base;
    let row = q.get('SELECT * FROM media WHERE rel_path = ?', relPath);
    if (!row) {
      row = insertMedia({
        sha: pageSha, relPath, kind: 'image', ext: 'png', mime: 'image/png', bytes: png.length,
        width: pix.getWidth(), height: pix.getHeight(), name: name2,
        srcSha: sha, pageNo: i + 1, modelId, processId
      });
    }
    pages.push(row);
  }

  return { kind: 'pdf', pages, pageCount: n, duplicated: false };
}

/** 原件留档：与页面同目录放一份 <原名>.pdf，入库给 kind='source'（不参与播放） */
function archivePdfSource(tmp, { name, sha, rel, dirAbs, modelId, processId, bytes }) {
  const base = fileBase(name, 'PDF');
  const t = uniqueTarget(dirAbs, base, 'pdf', sha);
  const relPath = `${rel}/${t.name}`;
  let row = q.get('SELECT * FROM media WHERE rel_path = ?', relPath);
  if (!row) {
    if (!t.same) moveFile(tmp, t.abs);
    row = insertMedia({
      sha, relPath, kind: 'source', ext: 'pdf', mime: PDF_MIME, bytes,
      name: t.name, modelId, processId
    });
  }
  return row;
}

// ───────────────────────── 图片尺寸 ─────────────────────────

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

// ───────────────────────── 上传落盘 ─────────────────────────

/**
 * 把上传流落盘到「机种/工序」目录，先写临时文件并同步算 sha256，再原子改名。
 * modelId / processId 由调用方从 query 带进来：媒体库页面上选中了哪个机种、
 * 拖进哪张工序卡，文件就该落在哪里。没带归属就进 _未分配（绑定时再搬）。
 */
export function saveStream(readable, { name = '', mime = '', modelId = '', processId = '' } = {}) {
  return new Promise((resolve, reject) => {
    const root = mediaDir();
    fs.mkdirSync(root, { recursive: true });
    const tmp = path.join(root, '.tmp-' + uid('up'));
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
        const rel = relDirOf({ modelId, processId });
        const dirAbs = absDirOf(rel);
        fs.mkdirSync(dirAbs, { recursive: true });
        const clean = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* 留着也无所谓 */ } };

        // PDF 走另一条路：拆成逐页 PNG + 原件留档
        if (finalMime === PDF_MIME) {
          const done = q.all(
            'SELECT * FROM media WHERE src_sha = ? AND model_id = ? AND process_id = ? ORDER BY page_no',
            sha, String(modelId || ''), String(processId || '')
          );
          if (done.length) {
            const source = archivePdfSource(tmp, { name, sha, rel, dirAbs, modelId, processId, bytes: size });
            clean();
            return resolve({ kind: 'pdf', pages: done, pageCount: done.length, duplicated: true, source });
          }
          const r = expandPdf(tmp, { name, sha, rel, dirAbs, modelId, processId });
          const source = archivePdfSource(tmp, { name, sha, rel, dirAbs, modelId, processId, bytes: size });
          clean();
          return resolve({ ...r, source });
        }

        const ext = safeExt(path.extname(name).slice(1) || MIME_EXT[finalMime] || 'bin');
        const kind = kindOf(finalMime);
        if (kind === 'file') {
          // 允许落盘但不参与播放（比如 .zip）：进池子留着，至少不丢文件
        }
        const base = fileBase(name, kind === 'video' ? 'video' : 'file');
        const t = uniqueTarget(dirAbs, base, ext, sha);
        const relPath = `${rel}/${t.name}`;

        const dim = kind === 'image' ? imageSize(Buffer.concat(head)) : { width: 0, height: 0 };

        let row = q.get('SELECT * FROM media WHERE rel_path = ?', relPath);
        const duplicated = !!row || !!t.same;
        if (!row) {
          if (!t.same) moveFile(tmp, t.abs);
          row = insertMedia({
            sha, relPath, kind, ext, mime: finalMime, bytes: size,
            width: dim.width, height: dim.height,
            name: String(name || t.name).slice(0, 200), modelId, processId
          });
        }
        clean();
        resolve({ ...row, duplicated });
      } catch (e) {
        fail(e);
      }
    });
  });
}

// ───────────────────────── 读取 ─────────────────────────

export function findMedia(id) {
  return q.get('SELECT * FROM media WHERE id = ?', String(id || ''));
}

/**
 * 盘上真实位置。rel_path 为空 = 4.4.0 之前的老记录，仍在 media/xx/<sha>.<ext>。
 * 最后那道 startsWith 校验是防穿越的最后一道闸：rel_path 里哪怕混进 `..`，
 * 也不允许解析到 media 根之外。
 */
export function diskPathOf(m) {
  if (!m) return '';
  const root = path.resolve(mediaDir());
  const abs = m.rel_path
    ? path.resolve(root, m.rel_path)
    : path.resolve(root, m.sha256.slice(0, 2), `${m.sha256}.${m.ext}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return '';
  return abs;
}

/** 支持 Range 的媒体响应：视频拖动、断点续传都依赖它 */
export function serveMedia(req, res, m) {
  const file = diskPathOf(m);
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('媒体文件缺失');
  }
  const total = fs.statSync(file).size;
  const baseHeaders = {
    'Content-Type': m.mime,
    'Accept-Ranges': 'bytes',
    // id 与内容一一对应，所以敢让浏览器一直用缓存
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

// ───────────────────────── 归属变更：认领 / 改名 / 回收 ─────────────────────────

/** 文件名主干：优先用盘上现成的名字，别把人家的 -2 后缀丢掉 */
function baseOf(m) {
  if (m.rel_path) {
    const f = m.rel_path.split('/').pop() || '';
    return fileBase(f, 'file');
  }
  return fileBase(m.name, 'file');
}

/** 把一个文件搬进新目录，并更新记录（同内容同名直接复用，不重复复制） */
function relocate(m, relDir) {
  const from = diskPathOf(m);
  if (!from || !fs.existsSync(from)) return false;
  const dirAbs = absDirOf(relDir);
  fs.mkdirSync(dirAbs, { recursive: true });
  const t = uniqueTarget(dirAbs, baseOf(m), safeExt(m.ext), m.sha256);
  if (t.abs !== from) {
    if (!t.same) moveFile(from, t.abs);
    else fs.rmSync(from, { force: true });
  }
  q.run('UPDATE media SET rel_path = ?, model_id = ?, process_id = ? WHERE id = ?',
    `${relDir}/${t.name}`, m.model_id, m.process_id, m.id);
  return true;
}

/**
 * 池子里的文件第一次被绑到某道工序时，搬进正式目录。
 * 只搬「还没有归属」的：已经属于别的机种/工序的一律不动 ——
 * 那说明是现场故意共用的，偷偷搬走会让另一个机种的屏黑掉。
 * PDF 原件（kind='source'）跟着同一份 PDF 的页面一起搬。
 */
export function adoptMedia(ids, modelId, processId) {
  const mid = String(modelId || '');
  const pid = String(processId || '');
  if (!mid || !pid) return 0;
  if (!q.get('SELECT id FROM process WHERE id = ? AND model_id = ?', pid, mid)) return 0;
  const rel = relDirOf({ modelId: mid, processId: pid });
  if (!rel || rel === POOL) return 0;   // 机种查不到就别乱搬

  let moved = 0;
  const srcs = new Set();
  for (const raw of (ids || [])) {
    const m = q.get('SELECT * FROM media WHERE id = ?', String(raw || ''));
    if (!m || m.kind === 'source') continue;
    if (m.src_sha) srcs.add(m.src_sha);
    if (m.model_id && m.model_id !== mid) continue;             // 已属别的机种
    if (m.process_id && m.process_id !== pid) continue;          // 已属同机种别的工序
    if (m.rel_path && m.rel_path.startsWith(rel + '/')) continue; // 已经在对的位置
    m.model_id = mid; m.process_id = pid;
    if (relocate(m, rel)) moved += 1;
  }

  // 原件：跟页面一起走，否则页面在 OP12、PDF 留在 _未分配，看着就乱
  for (const sha of srcs) {
    const src = q.get("SELECT * FROM media WHERE kind = 'source' AND sha256 = ? AND (model_id = '' OR model_id = ?)", sha, mid);
    if (!src) continue;
    if (src.process_id && src.process_id !== pid) continue;
    if (src.rel_path && src.rel_path.startsWith(rel + '/')) continue;
    src.model_id = mid; src.process_id = pid;
    relocate(src, rel);
  }
  return moved;
}

/**
 * 把 media/ 下的某段路径整体改名，并同步改掉所有记录的 rel_path。
 * 机种改名（名称变了）与工序改码共用这一套：都是在 rel_path 上换前缀。
 * 两个段都由调用方**在改库之前**算好 —— 算段时要看库里的当前状态，
 * 顺序颠倒会拿"改名后的状态"去对着"改名前的目录"，路径对不上就静默不搬。
 */
export function moveDir(fromRel, toRel) {
  if (!fromRel || !toRel || fromRel === toRel) return false;
  const oldAbs = absDirOf(fromRel);
  const newAbs = absDirOf(toRel);
  if (!fs.existsSync(oldAbs)) return false;
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  if (fs.existsSync(newAbs)) mergeDir(oldAbs, newAbs);
  else fs.renameSync(oldAbs, newAbs);

  q.run(
    `UPDATE media SET rel_path = ? || substr(rel_path, ?)
      WHERE substr(rel_path, 1, ?) = ?
        AND (length(rel_path) = ? OR substr(rel_path, ?, 1) = '/')`,
    toRel, fromRel.length + 1, fromRel.length, fromRel, fromRel.length, fromRel.length + 1
  );
  return true;
}

/** 工序码改了：机种下那层目录改名（OP9 → OP12）；两段都能现算，所以改库前后都行 */
export function moveProcessFolder(modelId, oldCode, newCode) {
  const m = q.get('SELECT id, code, name FROM model WHERE id = ?', String(modelId || ''));
  if (!m) return false;
  const base = modelDirOf(m);
  return moveDir(`${base}/${opSeg(oldCode)}`, `${base}/${opSeg(newCode)}`);
}

/** 目标目录已存在时逐个孩子搬过去，重名加后缀（只在手工建过同名目录时才会遇到） */
function mergeDir(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const name of fs.readdirSync(fromDir)) {
    const src = path.join(fromDir, name);
    let dest = path.join(toDir, name);
    for (let i = 2; fs.existsSync(dest) && i < 300; i += 1) {
      const ext = path.extname(name);
      dest = path.join(toDir, `${path.basename(name, ext)}-${i}${ext}`);
    }
    moveFile(src, dest);
  }
  try { fs.rmdirSync(fromDir); } catch { /* 还有残留就算了 */ }
}

/** 清掉空目录：删完内容后 media/<机种>/<工序>/ 不该留一堆空壳 */
function pruneEmptyDirs() {
  const root = mediaDir();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    if (depth > 0) {
      try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* 非空/占用，跳过 */ }
    }
  };
  walk(root, 0);
}

/**
 * 清理没有任何清单项引用的媒体。
 * 默认 dryRun，只报告不删 —— 工程部编辑清单时会出现"刚删了又加回来"的中间态，
 * 自动清理容易误删正在用的文件。
 *
 * PDF 原件（kind='source'）不按 item 引用判断：它本来就不会出现在清单里。
 * 判定标准是"拆出来的页面还有没有人用"—— 页面全成孤儿了，原件也没有留的意义。
 */
export function collectGarbage(dryRun = true) {
  const used = new Set(q.all('SELECT DISTINCT media_id FROM item').map((r) => r.media_id));
  const aliveSrc = new Set(q.all(
    `SELECT DISTINCT p.src_sha FROM media p JOIN item i ON i.media_id = p.id WHERE p.src_sha <> ''`
  ).map((r) => r.src_sha));

  const orphans = q.all('SELECT * FROM media').filter((m) => {
    if (m.kind === 'source') return !aliveSrc.has(m.sha256);
    return !used.has(m.id);
  });

  if (!dryRun) {
    for (const m of orphans) {
      const p = diskPathOf(m);
      if (p) fs.rmSync(p, { force: true });
      q.run('DELETE FROM media WHERE id = ?', m.id);
    }
    pruneEmptyDirs();
  }
  return {
    total: orphans.length,
    bytes: orphans.reduce((s, m) => s + m.bytes, 0),
    list: orphans.map((m) => ({ id: m.id, name: m.name, bytes: m.bytes, path: m.rel_path })),
    dryRun
  };
}

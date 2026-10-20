// 媒体仓库：内容寻址存储（CAS）+ 带签名的一次性访问地址 + Range 播放支持
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, mediaDir } from './db.js';
import { now, sha256File, uid } from './util.js';

let SECRET = '';

export function initSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    SECRET = fs.readFileSync(file, 'utf8').trim();
  } else {
    SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, SECRET, { mode: 0o600 });
  }
  return SECRET;
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/csv': 'csv'
};

function pickMime(name, given) {
  if (given && given !== 'application/octet-stream') return given;
  const ext = (path.extname(name || '').slice(1) || '').toLowerCase();
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  return given || 'application/octet-stream';
}

function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function casPath(sha, ext) {
  return path.join(mediaDir(), sha.slice(0, 2), `${sha}.${ext}`);
}

/**
 * 把上传流落盘。先写临时文件并同步算 sha256，再原子改名到 CAS 位置；
 * 内容已存在时直接删除临时文件（天然去重）。
 */
export function saveStream(readable, { name = '', mime = '' } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(mediaDir(), '.tmp-' + uid('up'));
    fs.mkdirSync(mediaDir(), { recursive: true });
    const ws = fs.createWriteStream(tmp);
    const h = crypto.createHash('sha256');
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
      if (size > 512 * 1024 * 1024) fail(new Error('单个文件不得超过 512MB'));
    });
    readable.on('error', fail);
    ws.on('error', fail);

    readable.pipe(ws);
    ws.on('finish', async () => {
      if (aborted) return;
      try {
        const sha = h.digest('hex');
        const finalMime = pickMime(name, mime);
        const ext = path.extname(name).slice(1).toLowerCase() || MIME_EXT[finalMime] || 'bin';
        const target = casPath(sha, ext);
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const id = sha.slice(0, 16);
        const exist = q.get('SELECT * FROM media WHERE sha256 = ?', sha);
        if (exist) {
          fs.rmSync(tmp, { force: true });
          return resolve(exist);
        }
        fs.renameSync(tmp, target);

        q.run(
          `INSERT INTO media(id,sha256,ext,mime,size,name,kind,created_at,created_by)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          id, sha, ext, finalMime, size, String(name).slice(0, 200), kindOf(finalMime), now(), 'admin'
        );
        resolve(q.get('SELECT * FROM media WHERE id = ?', id));
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

/** 生成带过期时间的访问地址 */
export function signUrl(id, ttlMs = 24 * 3600 * 1000) {
  const exp = now() + ttlMs;
  const sig = crypto.createHmac('sha256', SECRET).update(`${id}:${exp}`).digest('base64url').slice(0, 22);
  return `/m/${id}?e=${exp}&s=${sig}`;
}

export function verifyUrl(id, exp, sig) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now()) return false;
  const want = crypto.createHmac('sha256', SECRET).update(`${id}:${e}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 支持 Range 的媒体响应，安卓端视频拖动与断点续传都依赖它 */
export function serveMedia(req, res, m, extraHeaders = {}) {
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
    ETag: `"${m.sha256.slice(0, 20)}"`,
    ...extraHeaders
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
    // 后缀范围：最后 N 字节
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
  const row = q.get('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM media');
  return { count: row.n, bytes: row.bytes };
}

/** 清理未被任何页面引用的媒体（谨慎：只在用户显式调用时执行） */
export function collectGarbage(dryRun = true) {
  const used = new Set();
  for (const p of q.all('SELECT blocks FROM page')) {
    let blocks = [];
    try { blocks = JSON.parse(p.blocks); } catch { /* 忽略坏数据 */ }
    for (const b of blocks) if (b && b.mediaId) used.add(b.mediaId);
  }
  const orphans = q.all('SELECT * FROM media').filter((m) => !used.has(m.id));
  if (!dryRun) {
    for (const m of orphans) {
      fs.rmSync(diskPathOf(m), { force: true });
      q.run('DELETE FROM media WHERE id = ?', m.id);
    }
  }
  return { total: orphans.length, bytes: orphans.reduce((s, m) => s + m.size, 0), dryRun };
}

export { sha256File };

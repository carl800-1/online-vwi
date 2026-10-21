// 本地内容管理：磁盘上永远只有"当前这一套"。
//
// 与 docs/03-技术方案.md 5.2 的差异（实现层面改的，理由写在这）：
//   文档原方案是"目录三步 rename：current → old_<ts>，tmp → current"。
//   但 exe 里停播和换目录分属两个进程，rename 必须等渲染层真停了 <video> 才可能成功，
//   而这段等待就是一个可测量的黑屏窗口，直接违反 A2。
//   所以改成**文件级共存 + 精确删除**：
//     · 文件名 = <sha16>.<ext>，新旧文件天然不同名，可以同时存在
//     · 新文件先下到 current/（.part → 校验通过才改正式名）
//     · 渲染层预载第一项后原子切换，旧元素 src 清空释放句柄
//     · 收到 ack 后再删"不在新清单里"的文件
//   结果是：零黑屏、断点可恢复、旧内容在翻转成功前始终完好（A2/A4 的底线），
//   而稳态下目录里只有当前一套（A8 依然成立）。
const fs = require('node:fs');
const path = require('node:path');
const { PATHS } = require('./config');
const net = require('./net');

let index = null;                  // 内存中的索引，磁盘上同步一份
const pendingPurge = new Set();    // 删不掉的文件，等会儿再试
let purgeTimer = null;

function loadIndex() {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(PATHS.index, 'utf8'));
  } catch {
    index = null;
  }
  if (!index || !Array.isArray(index.items)) index = { modelId: '', modelCode: '', seq: 0, items: [] };
  return index;
}

function saveIndex(next) {
  index = next;
  fs.mkdirSync(PATHS.content, { recursive: true });
  const tmp = PATHS.index + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, PATHS.index);      // index 本身很小，原子替换没有成本
  return index;
}

function extOf(item) {
  const e = String(item.ext || '').trim();
  if (e) return e;
  // 服务端没给 ext 时按 mime 兜底：扩展名错了 <video> 会解不出来，不能省这一步
  const mime = String(item.mime || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  return item.kind === 'video' ? 'mp4' : 'jpg';
}

function fileName(mediaId, ext) {
  const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${String(mediaId).replace(/[^a-z0-9]/gi, '')}.${safeExt}`;
}

function filePath(mediaId, ext) {
  return path.join(PATHS.current, fileName(mediaId, ext));
}

function exists(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

/** 本地索引里的清单，并且逐项确认文件还在。缺一个就整体算"不完整"。 */
function localItems() {
  const idx = loadIndex();
  if (!idx.modelId || !idx.items.length) return null;
  const items = [];
  for (const it of idx.items) {
    const p = filePath(it.mediaId, it.ext);
    if (!exists(p)) return null;
    items.push({
      mediaId: it.mediaId,
      kind: it.kind,
      dwellSec: it.dwellSec,
      name: it.name,
      file: p,
      url: toFileUrl(p)
    });
  }
  return { modelId: idx.modelId, modelCode: idx.modelCode, seq: idx.seq, items };
}

function toFileUrl(p) {
  // Windows 路径转 file://，空格与中文都要编码，否则 <img src> 会静默失败
  return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '');
}

function hasModel(modelId) {
  const idx = loadIndex();
  if (!idx.modelId || idx.modelId !== modelId) return false;
  return idx.items.every((it) => exists(filePath(it.mediaId, it.ext)));
}

/**
 * 把服务器给的清单落到本地。已存在的文件直接跳过（文件名就是 sha，存在即完整）。
 * 返回 { items:[{mediaId,kind,dwellSec,name,file,url}], downloaded, skipped, missing:[name] }
 */
async function prepareFiles(server, list, { onProgress, signal } = {}) {
  fs.mkdirSync(PATHS.current, { recursive: true });
  const done = [];
  const missing = [];
  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < list.length; i++) {
    const it = { ...list[i], ext: extOf(list[i]) };   // 后面 pack/commit 都靠这个 ext
    const dest = filePath(it.mediaId, it.ext);

    if (exists(dest)) {
      skipped++;
      done.push(pack(it, dest));
      if (onProgress) onProgress(i + 1, list.length, it.name, 'skip');
      continue;
    }

    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        await net.download(server, it.url, dest, {
          expectedSha: it.sha256,
          signal,
          onProgress: (got, total) => {
            // 单个文件进度不细报，按"第几项"报，顶栏显示 3/11 才有意义
            if (onProgress) onProgress(i, list.length, it.name, 'down', got, total);
          }
        });
        ok = true;
        downloaded++;
      } catch (e) {
        if (e.code === 'ERR_SHA' && attempt === 1) {
          console.warn(`[cache] sha 不符，重下一次：${it.name}`);
          continue;
        }
        console.error(`[cache] 下载失败 ${it.name}:`, e.message);
        break;
      }
    }

    if (ok) done.push(pack(it, dest));
    else missing.push(it.name);
    if (onProgress) onProgress(i + 1, list.length, it.name, ok ? 'done' : 'fail');
  }

  return { items: done, downloaded, skipped, missing };
}

function pack(it, file) {
  return {
    mediaId: it.mediaId,
    ext: it.ext,
    kind: it.kind,
    dwellSec: it.dwellSec,
    name: it.name,
    bytes: it.bytes,
    file,
    url: toFileUrl(file)
  };
}

/** 翻转成功后写索引：从这一刻起，"本地是哪套内容"才算变了。 */
function commit({ modelCode, modelId, seq }, items) {
  return saveIndex({
    modelCode: modelCode || '',
    modelId: modelId || '',
    seq: Number(seq) || 0,
    committedAt: Date.now(),
    items: items.map((it) => ({
      mediaId: it.mediaId,
      ext: it.ext,
      kind: it.kind,
      dwellSec: it.dwellSec,
      name: it.name,
      bytes: it.bytes
    }))
  });
}

/** 删掉不在保留名单里的文件。正在播的、要播的都在名单里，所以安全。 */
function purgeExcept(keepFiles) {
  const keep = new Set([...keepFiles].map((f) => path.basename(f)));
  let deleted = 0;
  let bytes = 0;

  for (const name of safeReaddir(PATHS.current)) {
    if (keep.has(name)) continue;
    const p = path.join(PATHS.current, name);
    try {
      const st = fs.statSync(p);
      fs.unlinkSync(p);
      deleted++;
      bytes += st.size;
    } catch (e) {
      // EBUSY / EPERM：文件还被 <video> 或缩略图缓存占着。这是 Windows 常态，不是异常。
      pendingPurge.add(p);
    }
  }

  if (deleted) console.log(`[cache] purge ${deleted} 个旧文件 ${(bytes / 1048576).toFixed(1)}MB`);
  if (pendingPurge.size) schedulePurgeRetry();
  return { deleted, bytes, pending: pendingPurge.size };
}

function schedulePurgeRetry() {
  if (purgeTimer) return;
  purgeTimer = setTimeout(() => {
    purgeTimer = null;
    let left = 0;
    for (const p of [...pendingPurge]) {
      try {
        fs.unlinkSync(p);
        pendingPurge.delete(p);
      } catch {
        left++;
      }
    }
    if (left) {
      // 连续重试仍删不掉：说明有句柄泄漏。留日志，界面由上层读 stats 显示告警。
      console.warn(`[cache] ${left} 个旧文件仍删不掉，稍后继续`);
      schedulePurgeRetry();
    } else {
      console.log('[cache] 待删文件已清空');
    }
  }, 60_000);
  purgeTimer.unref?.();
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

/** 启动清理：半截下载文件一律删，留索引里没有的孤儿文件也删。 */
function cleanUpOnStart() {
  fs.mkdirSync(PATHS.current, { recursive: true });
  let part = 0;
  for (const name of safeReaddir(PATHS.current)) {
    if (!name.endsWith('.part')) continue;
    try { fs.unlinkSync(path.join(PATHS.current, name)); part++; } catch { /* ignore */ }
  }
  if (part) console.log(`[cache] 清理 ${part} 个未完成下载`);
  try { fs.unlinkSync(PATHS.index + '.tmp'); } catch { /* ignore */ }

  const idx = loadIndex();
  const keep = new Set(idx.items.map((it) => fileName(it.mediaId, it.ext)));
  if (keep.size) {
    const r = purgeExcept(keep);
    if (r.deleted) console.log(`[cache] 启动清理孤儿文件 ${r.deleted} 个`);
  }
}

/** A8 的直接判据：稳态下文件数应等于清单条数，字节数约 27MB。 */
function stats() {
  const idx = loadIndex();
  const files = safeReaddir(PATHS.current);
  let bytes = 0;
  for (const n of files) {
    try { bytes += fs.statSync(path.join(PATHS.current, n)).size; } catch { /* ignore */ }
  }
  return {
    modelCode: idx.modelCode,
    modelId: idx.modelId,
    seq: idx.seq,
    expectFiles: idx.items.length,
    files: files.length,
    bytes,
    pendingPurge: pendingPurge.size,
    currentDir: PATHS.current
  };
}

module.exports = {
  PATHS,
  loadIndex,
  saveIndex,
  localItems,
  hasModel,
  prepareFiles,
  commit,
  purgeExcept,
  cleanUpOnStart,
  stats,
  filePath,
  toFileUrl
};

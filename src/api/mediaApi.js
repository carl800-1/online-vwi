// 媒体库接口：上传走原始流，不经过 JSON 解析
// （踩过的坑：如果先做 JSON body 解析，请求体被消费掉，落盘就是 0 字节）
import { q } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { saveStream, collectGarbage, mediaStats } from '../media.js';

export function register(router) {
  // 上传：请求体是原始字节流，文件名走 query，避免 multipart 解析与内存占用
  router.post('/api/media/upload', async (req, res, ctx) => {
    const raw = ctx.query.filename || ctx.query.name || '';
    if (!raw) throw badRequest('缺少 filename 参数');
    let filename = String(raw);
    try { filename = decodeURIComponent(filename); } catch { /* 已经是明文就原样用 */ }

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const r = await saveStream(req, { name: filename, mime });

    // PDF 上传完成的是「一整份拆好的页」，不是单个文件：
    // 每一页都是独立 media，前端的返回结构也跟着变，让界面一次把整份加进清单。
    if (r.kind === 'pdf') {
      return sendJson(res, 200, {
        kind: 'pdf',
        pageCount: r.pageCount,
        duplicated: !!r.duplicated,
        pages: r.pages.map((p) => ({
          id: p.id, kind: p.kind, name: p.name, bytes: p.bytes,
          width: p.width, height: p.height, url: `/m/${p.id}`
        }))
      });
    }

    const media = r;
    sendJson(res, 200, {
      id: media.id,
      sha256: media.sha256,
      kind: media.kind,
      ext: media.ext,
      mime: media.mime,
      bytes: media.bytes,
      width: media.width,
      height: media.height,
      name: media.name,
      duplicated: !!media.duplicated,
      url: `/m/${media.id}`
    });
  });

  router.get('/api/media', (req, res, ctx) => {
    const kind = ctx.query.kind || '';
    const keyword = String(ctx.query.q || '').trim();
    let sql = `SELECT m.*, (SELECT COUNT(*) FROM item i WHERE i.media_id = m.id) AS used FROM media m`;
    const where = [];
    const args = [];
    if (kind) { where.push('m.kind = ?'); args.push(kind); }
    if (keyword) { where.push('m.name LIKE ?'); args.push(`%${keyword}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY m.created_at DESC LIMIT 500';

    sendJson(res, 200, {
      stats: mediaStats(),
      media: q.all(sql, ...args).map((m) => ({
        id: m.id,
        kind: m.kind,
        ext: m.ext,
        mime: m.mime,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        name: m.name,
        createdAt: m.created_at,
        used: m.used,
        // PDF 拆出来的页：界面靠这两个字段把它们归到同一份 PDF 下，不要散成一堆图
        pageNo: m.page_no,
        srcSha: m.src_sha,
        url: `/m/${m.id}`
      }))
    });
  });

  // 默认 dryRun：先看会删掉什么，确认后再真删。
  // 理由：工程部编辑清单时会有"刚删了又加回来"的中间态，自动清理容易误删正在用的文件。
  router.post('/api/media/gc', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, collectGarbage(body.dryRun !== false));
  });

  // 规格体检：19 寸是 5:4，16:9 的图上下各浪费 152px，实得只有 25% 面积
  router.get('/api/media/advice', (req, res) => {
    // PDF 拆出来的页不算：比例是原 PDF 页面决定的，改不了，报出来只会让人困惑
    const ratio = q.all(`
      SELECT id, name, width, height FROM media
       WHERE kind = 'image' AND width > 0 AND src_sha = ''
         AND ABS(width * 1.0 / height - 1.25) > 0.08
    `);
    const oversized = q.all(
      `SELECT id, name, bytes FROM media WHERE kind = 'image' AND src_sha = '' AND bytes > 400 * 1024`
    );
    sendJson(res, 200, {
      ratioWarnings: ratio.map((m) => ({ ...m, ratio: +(m.width / m.height).toFixed(2) })),
      sizeWarnings: oversized.map((m) => ({ ...m, kb: Math.round(m.bytes / 1024) }))
    });
  });
}

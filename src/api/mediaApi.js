// 媒体接口：流式上传（sha256 去重）、列表、清理
import { q } from '../db.js';
import { str } from '../util.js';
import { sendJson, badRequest } from '../router.js';
import { saveStream, findMedia, signUrl, collectGarbage, mediaStats } from '../media.js';

export function register(r) {
  // 上传：请求体是原始字节流，文件名走 query，避免 multipart 解析与内存占用
  r.post('/api/media/upload', async (req, res, ctx) => {
    const name = str(ctx.query.filename || ctx.query.name, 200).trim();
    if (!name) throw badRequest('缺少 filename 参数');
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const m = await saveStream(req, { name, mime });
    sendJson(res, 200, {
      item: {
        id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind,
        ext: m.ext, sha256: m.sha256, url: signUrl(m.id)
      }
    });
  });

  r.get('/api/media', (req, res, ctx) => {
    const kind = ctx.query.kind || '';
    const keyword = str(ctx.query.q, 60).trim();
    let sql = 'SELECT * FROM media';
    const args = [];
    const where = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (keyword) { where.push('name LIKE ?'); args.push(`%${keyword}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const list = q.all(sql, ...args).map((m) => ({
      id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind,
      ext: m.ext, createdAt: m.created_at, url: signUrl(m.id)
    }));
    sendJson(res, 200, { list, stats: mediaStats() });
  });

  r.get('/api/media/:id', (req, res, ctx) => {
    const m = findMedia(ctx.params.id);
    if (!m) throw badRequest('媒体不存在');
    sendJson(res, 200, {
      item: { id: m.id, name: m.name, mime: m.mime, size: m.size, kind: m.kind, sha256: m.sha256, url: signUrl(m.id) }
    });
  });

  r.post('/api/media/gc', async (req, res, ctx) => {
    const dryRun = ctx.query.apply !== '1';
    const result = collectGarbage(dryRun);
    sendJson(res, 200, { ok: true, ...result });
  });
}

// 播放清单：一个 (型号 × 工序) 下的一组有序内容
// 保存方式刻意做成"整批覆盖"：前端一次提交该工序全部项，
// 后台先删后插。逐条增删会留下"删了第 3 条、第 4 条序号要不要重排"的中间态，
// 整批覆盖没有中间态，也不会出现半套清单被终端读到。
import { q, tx } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { uid, int, clamp } from '../util.js';
import { notifyContentChanged } from '../switch.js';

function loadItems(modelId, processId) {
  return q.all(
    `SELECT i.id, i.ord, i.kind, i.media_id, i.dwell_sec,
            m.name, m.ext, m.mime, m.bytes, m.width, m.height, m.duration_ms
       FROM item i JOIN media m ON m.id = i.media_id
      WHERE i.model_id = ? AND i.process_id = ?
      ORDER BY i.ord, i.id`,
    modelId, processId
  ).map((r) => ({
    id: r.id,
    ord: r.ord,
    kind: r.kind,
    mediaId: r.media_id,
    dwellSec: r.dwell_sec,
    name: r.name,
    ext: r.ext,
    mime: r.mime,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    url: `/m/${r.media_id}`
  }));
}

export function register(router) {
  router.get('/api/playlist', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '');
    const processId = String(ctx.query.processId || '');
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    const process = q.get('SELECT * FROM process WHERE id = ?', processId);
    if (!model) throw badRequest('型号不存在');
    if (!process) throw badRequest('工序不存在');

    const items = loadItems(modelId, processId);
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name },
      process: { id: process.id, code: process.code, name: process.name },
      items,
      // 给前端算总数：这套内容需要多少 MB、几张图几段视频
      stats: {
        count: items.length,
        images: items.filter((i) => i.kind === 'image').length,
        videos: items.filter((i) => i.kind === 'video').length,
        bytes: items.reduce((s, i) => s + i.bytes, 0)
      }
    });
  });

  router.put('/api/playlist', async (req, res) => {
    const body = await readJsonBody(req);
    const modelId = String(body.modelId || '');
    const processId = String(body.processId || '');
    const list = Array.isArray(body.items) ? body.items : null;

    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    const process = q.get('SELECT * FROM process WHERE id = ?', processId);
    if (!model) throw badRequest('型号不存在');
    if (!process) throw badRequest('工序不存在');
    if (!list) throw badRequest('items 必须是数组');

    // 先全部校验完再动数据库：宁可整批失败，也不要写进去一半
    const seen = new Set();
    const rows = list.map((it, i) => {
      const mediaId = String(it.mediaId || '');
      const media = q.get('SELECT * FROM media WHERE id = ?', mediaId);
      if (!media) throw badRequest(`第 ${i + 1} 项的媒体不存在（${mediaId}）`);
      if (seen.has(mediaId)) throw badRequest(`同一个文件不能在一套清单里出现两次：${media.name}`);
      seen.add(mediaId);
      return {
        mediaId,
        kind: media.kind,
        ord: i,
        // 图片停留 1–120 秒；视频不看这个值，播完就下一项
        dwellSec: clamp(it.dwellSec ?? 10, 1, 120)
      };
    });

    tx(() => {
      q.run('DELETE FROM item WHERE model_id = ? AND process_id = ?', modelId, processId);
      for (const r of rows) {
        q.run(
          'INSERT INTO item(id,model_id,process_id,ord,kind,media_id,dwell_sec) VALUES(?,?,?,?,?,?,?)',
          uid('it'), modelId, processId, r.ord, r.kind, r.mediaId, r.dwellSec
        );
      }
    });

    // 提交之后再通知：终端收到的每一次 rev 变化都对应一个已经落库的清单，
    // 顺序反了会让终端读到旧数据（"收到通知但内容没变"）。
    notifyContentChanged();

    sendJson(res, 200, { ok: true, count: rows.length, items: loadItems(modelId, processId) });
  });
}

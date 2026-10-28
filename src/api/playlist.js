// 播放清单（兼容接口）：按「机种 × 工序」读写
//
// 4.0.0 之前内容的宿主是"工位"，老调用方（脚本、旧页面）传的是 processId，
// 还要先展开成 (line_id, code) 才找得到工位。现在工序本身就是宿主，
// processId 直接定位，stationId 也收（老脚本可能还在传）。
// 新代码请直接用 PUT /api/processes/:id。
import { q, processesOf, processById, saveProcess } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';

function pickProcess(modelId, { processId, stationId }) {
  const id = String(processId || stationId || '').trim();
  if (!id) return null;
  const p = processById(id);
  return p && p.model_id === String(modelId || '') ? p : null;
}

function loadItems(processId) {
  return q.all(
    `SELECT i.id, i.ord, i.kind, i.media_id, i.dwell_sec, i.fit, i.zoom,
            m.name, m.ext, m.mime, m.bytes, m.width, m.height, m.duration_ms
       FROM item i JOIN media m ON m.id = i.media_id
      WHERE i.process_id = ?
      ORDER BY i.ord, i.id`,
    processId
  ).map((r) => ({
    id: r.id,
    ord: r.ord,
    kind: r.kind,
    mediaId: r.media_id,
    dwellSec: r.dwell_sec,
    fit: r.fit || 'contain',
    zoom: r.zoom || 100,
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
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');

    const p = pickProcess(modelId, {
      processId: ctx.query.processId,
      stationId: ctx.query.stationId
    });
    if (!p) throw badRequest('这个机种下没有这道工序');

    const items = loadItems(p.id);
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name },
      station: { id: p.id, code: p.code, name: p.name },
      process: { id: p.id, code: p.code, name: p.name, playMode: p.play_mode },
      items,
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
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');

    const p = pickProcess(modelId, { processId: body.processId, stationId: body.stationId });
    if (!p) throw badRequest('这个机种下没有这道工序');

    const list = body.items;
    if (!Array.isArray(list)) throw badRequest('items 必须是数组');

    // 先全部校验完再写库：宁可整批失败，也不要写进去一半
    const seen = new Set();
    const rows = [];
    list.forEach((it, i) => {
      const mediaId = String(it.mediaId || '');
      const media = q.get('SELECT * FROM media WHERE id = ?', mediaId);
      if (!media) throw badRequest(`第 ${i + 1} 项的媒体不存在（${mediaId}）`);
      if (seen.has(mediaId)) throw badRequest(`同一个文件不能在一套清单里出现两次：${media.name}`);
      seen.add(mediaId);
      rows.push({
        mediaId,
        dwellSec: it.dwellSec ?? 10,
        fit: it.fit === 'cover' ? 'cover' : 'contain',
        zoom: it.zoom ?? 100
      });
    });

    saveProcess(modelId, p.id, { items: rows });
    notifyContentChanged();

    sendJson(res, 200, { ok: true, count: rows.length, items: loadItems(p.id) });
  });

  // 机种的全部工序（含内容），机种设置 / 媒体库一次取完
  router.get('/api/playlist/all', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '');
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');
    if (!processesOf(modelId).length) throw badRequest('这个机种还没有工序，先去「机种设置」加几道');
    sendJson(res, 200, { model, stations: processesOf(modelId), processes: processesOf(modelId) });
  });
}

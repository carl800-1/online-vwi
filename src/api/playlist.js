// 播放清单（兼容接口）：按「机种 × 线体 × 工位」读写
//
// 内容的宿主是工位，但老调用方（脚本、旧页面）传的是 processId。
// 这里把 process 展开成 (line_id, code) 再找工位 —— 语义没变
// （"这个机种在这条线的这道工序上该播什么"）。
// 新代码请直接用 /api/stations/:id。
import { q, stationsOf, saveStation } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';

/** processId 或 stationId 都收；返回 station 记录 */
function resolveStation(modelId, { stationId, processId }) {
  if (stationId) {
    return q.get('SELECT * FROM station WHERE id = ? AND model_id = ?', stationId, modelId) || null;
  }
  if (processId) {
    // 工序属于某条线体，所以 process 足够定位到「机种 × 线体 × 码」
    const p = q.get('SELECT * FROM process WHERE id = ?', processId);
    if (!p) return null;
    return q.get('SELECT * FROM station WHERE model_id = ? AND line_id = ? AND code = ?',
      modelId, p.line_id, p.code) || null;
  }
  return null;
}

function loadItems(stationId) {
  return q.all(
    `SELECT i.id, i.ord, i.kind, i.media_id, i.dwell_sec, i.fit, i.zoom,
            m.name, m.ext, m.mime, m.bytes, m.width, m.height, m.duration_ms
       FROM item i JOIN media m ON m.id = i.media_id
      WHERE i.station_id = ?
      ORDER BY i.ord, i.id`,
    stationId
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
    if (!model) throw badRequest('型号不存在');

    const station = resolveStation(modelId, {
      stationId: String(ctx.query.stationId || ''),
      processId: String(ctx.query.processId || '')
    });
    if (!station) throw badRequest('这个机种在这条线的这道工序上还没有工位');

    const items = loadItems(station.id);
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name },
      station: { id: station.id, code: station.code, name: station.name },
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
    if (!model) throw badRequest('型号不存在');

    const station = resolveStation(modelId, {
      stationId: String(body.stationId || ''),
      processId: String(body.processId || '')
    });
    if (!station) throw badRequest('这个机种在这条线的这道工序上还没有工位');

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

    saveStation(modelId, station.id, { items: rows });
    notifyContentChanged();

    sendJson(res, 200, { ok: true, count: rows.length, items: loadItems(station.id) });
  });

  // 机种在一条线上的全部工位（含内容），机种设置页一次取完
  router.get('/api/playlist/all', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '');
    const lineId = String(ctx.query.lineId || '');
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('型号不存在');
    sendJson(res, 200, { model, stations: stationsOf(modelId, lineId) });
  });
}

// 终端接口：身份 = 线体 + 工序，不鉴权（内网 + 一期不做权限）
//
// 为什么身份要加线体：一线和二线的 OP30 是两块屏，服务端要知道是谁在问。
// 但**内容**从 v2.0.0 起不再按线体存：线体的工序只决定"这条线上有几块屏"，
// 播什么由「机种 × 工位」决定，全厂一份。所以同一机种换线不用重传。
// 不带 line 时由 router.js 回落到当前启用线体，现场老终端照常工作。
import { q } from '../db.js';
import { sendJson, badRequest } from '../router.js';
import { touch, getState } from '../switch.js';
import { termMeta } from '../util.js';

/** 机种里 code 等于这道工序的工位。没有就是"这个机种没配这块屏"，要显式告警。 */
export function stationOf(modelId, code) {
  return q.get('SELECT * FROM station WHERE model_id = ? AND code = ?', String(modelId || ''), String(code || ''));
}

export function register(router) {
  /**
   * 拉清单：GET /display/playlist?line=L1&op=OP30&model=X300
   * model 可给 code 也可给 id；不给就用这条线的当前型号。
   * 终端用这个接口既做"切换下载"，也做"首次装机补内容"——同一套代码，两条路径。
   */
  router.get('/display/playlist', (req, res, ctx) => {
    const { process, line } = ctx;
    touch(line.id, process.code, termMeta(ctx));

    const want = String(ctx.query.model || '').trim();
    let model;
    if (want) {
      model = q.get('SELECT * FROM model WHERE code = ? OR id = ?', want, want);
      if (!model) throw badRequest(`型号 ${want} 不存在`);
    } else {
      const cur = getState(line.id).currentModelId;
      model = cur ? q.get('SELECT * FROM model WHERE id = ?', cur) : null;
      if (!model) {
        return sendJson(res, 200, {
          lineCode: line.code, lineName: line.name,
          modelCode: '', modelId: '', processCode: process.code, processName: process.name,
          items: [], empty: true, count: 0, totalBytes: 0,
          message: `「${line.name}」还没有指定当前机种`
        });
      }
    }

    const station = stationOf(model.id, process.code);

    const rows = station
      ? q.all(
          `SELECT i.ord, i.kind, i.dwell_sec, i.fit, i.zoom, i.media_id,
                  m.sha256, m.ext, m.mime, m.bytes, m.name
             FROM item i JOIN media m ON m.id = i.media_id
            WHERE i.station_id = ?
            ORDER BY i.ord`,
          station.id
        )
      : [];

    sendJson(res, 200, {
      lineCode: line.code,
      lineName: line.name,
      modelCode: model.code,
      modelId: model.id,
      modelName: model.name,
      processCode: process.code,
      processName: process.name,
      stationCode: station?.code || '',
      stationName: station?.name || process.name,
      items: rows.map((r) => ({
        mediaId: r.media_id,
        kind: r.kind,
        // 终端拿 sha256 校验用；下载地址稳定，可断点续传
        sha256: r.sha256,
        bytes: r.bytes,
        name: r.name,
        dwellSec: r.dwell_sec,
        // 显示方式随内容一起下发：换型时和清单同时生效，不做单独设置项，
        // 否则"换了型号但尺寸还是上一套的"会成为新的半新半旧。
        fit: r.fit || 'contain',
        zoom: r.zoom || 100,
        mime: r.mime,
        // ext 必须给：终端按 <mediaId>.<ext> 存盘，扩展名错了 <video> 可能解不出来
        ext: r.ext,
        url: `/m/${r.media_id}`
      })),
      // 空清单 = 这个机种在这道工序上还没有内容，或者压根没配这个工位。
      // 终端要显式告警，不能静默播空白。
      empty: rows.length === 0,
      // 区分"工位没配"和"工位配了但没传内容"：前者要去机种设置加工位，后者只是没传
      noStation: !station,
      count: rows.length,
      // 终端算下载进度用（准备中 3/11）
      totalBytes: rows.reduce((s, r) => s + r.bytes, 0)
    });
  }, { op: true });

  // 终端启动自检：确认线体/工序有效、拿到当前型号，避免一开机就黑屏摸索
  router.get('/display/boot', (req, res, ctx) => {
    const { process, line } = ctx;
    touch(line.id, process.code, termMeta(ctx));
    const st = getState(line.id);
    const cur = st.currentModelId ? q.get('SELECT code, name FROM model WHERE id = ?', st.currentModelId) : null;
    const station = cur ? stationOf(cur.id, process.code) : null;
    const have = station
      ? q.get('SELECT COUNT(*) n FROM item WHERE station_id = ?', station.id).n
      : 0;
    sendJson(res, 200, {
      lineId: line.id,
      lineCode: line.code,
      lineName: line.name,
      processCode: process.code,
      processName: process.name,
      modelId: st.currentModelId || '',
      modelCode: cur?.code || '',
      modelName: cur?.name || '',
      stationCode: station?.code || '',
      stationName: station?.name || '',
      // 机种里没有这道工序的工位：终端该提示"这个机种没配这块屏"，
      // 而不是让运维对着空屏猜是网络还是没内容
      noStation: !!cur && !station,
      seq: st.seq,
      rev: st.rev,
      phase: st.phase,
      itemCount: have,
      online: st.online
    });
  }, { op: true });
}

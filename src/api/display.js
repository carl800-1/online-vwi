// 终端接口：只靠 op 认身份，不鉴权（内网 + 一期不做权限）
import { q } from '../db.js';
import { sendJson, badRequest } from '../router.js';
import { touch, getState } from '../switch.js';

export function register(router) {
  /**
   * 拉清单：GET /display/playlist?op=OP30&model=X300
   * model 可给 code 也可给 id；不给就用服务端当前型号。
   * 终端用这个接口既做"切换下载"，也做"首次装机补内容"——同一套代码，两条路径。
   */
  router.get('/display/playlist', (req, res, ctx) => {
    const process = ctx.process;
    touch(process.code);

    const want = String(ctx.query.model || '').trim();
    let model;
    if (want) {
      model = q.get('SELECT * FROM model WHERE code = ? OR id = ?', want, want);
      if (!model) throw badRequest(`型号 ${want} 不存在`);
    } else {
      const cur = getState().currentModelId;
      model = cur ? q.get('SELECT * FROM model WHERE id = ?', cur) : null;
      if (!model) {
        return sendJson(res, 200, {
          modelCode: '', modelId: '', processCode: process.code, processName: process.name,
          items: [], empty: true, count: 0, totalBytes: 0, message: '服务端还没有指定当前型号'
        });
      }
    }

    const rows = q.all(
      `SELECT i.ord, i.kind, i.dwell_sec, i.media_id,
              m.sha256, m.ext, m.mime, m.bytes, m.name
         FROM item i JOIN media m ON m.id = i.media_id
        WHERE i.model_id = ? AND i.process_id = ?
        ORDER BY i.ord`,
      model.id, process.id
    );

    sendJson(res, 200, {
      modelCode: model.code,
      modelId: model.id,
      modelName: model.name,
      processCode: process.code,
      processName: process.name,
      items: rows.map((r) => ({
        mediaId: r.media_id,
        kind: r.kind,
        // 终端拿 sha256 校验用；下载地址稳定，可断点续传
        sha256: r.sha256,
        bytes: r.bytes,
        name: r.name,
        dwellSec: r.dwell_sec,
        mime: r.mime,
        url: `/m/${r.media_id}`
      })),
      // 空清单 = 这道工序这个型号还没有内容。终端要显式告警，不能静默播空白
      empty: rows.length === 0,
      count: rows.length,
      // 终端算下载进度用（准备中 3/11）
      totalBytes: rows.reduce((s, r) => s + r.bytes, 0)
    });
  }, { op: true });

  // 终端启动自检：确认 op 有效、拿到当前型号，避免一开机就黑屏摸索
  router.get('/display/boot', (req, res, ctx) => {
    const process = ctx.process;
    touch(process.code);
    const st = getState();
    const cur = st.currentModelId ? q.get('SELECT code, name FROM model WHERE id = ?', st.currentModelId) : null;
    const have = q.get(
      'SELECT COUNT(*) n FROM item WHERE model_id = ? AND process_id = ?',
      st.currentModelId || '', process.id
    ).n;
    sendJson(res, 200, {
      processCode: process.code,
      processName: process.name,
      modelId: st.currentModelId || '',
      modelCode: cur?.code || '',
      modelName: cur?.name || '',
      seq: st.seq,
      rev: st.rev,
      phase: st.phase,
      itemCount: have,
      online: st.online
    });
  }, { op: true });
}

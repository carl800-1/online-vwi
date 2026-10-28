// 终端接口：身份 = 线体 + 工序码，不鉴权（内网 + 一期不做权限）
//
// v4.0.0 起取内容只走一跳：
//   ?line=L1 → 这条线的当前机种 → 该机种的同码工序 → 清单
// 工序不再属于线体，所以"这条线上有没有 OP30"这种问题已经不存在了；
// 存在的是"这条线现在做的机种有没有 OP30"。后者才是现场真正会遇到的错配。
import { q, processByCode } from '../db.js';
import { sendJson, badRequest } from '../router.js';
import { touch, getState } from '../switch.js';
import { termMeta } from '../util.js';

/** 机种下 code 等于这道工序的工序。没有就是"这个机种没排这块屏"，要显式告警。 */
export function processOf(modelId, code) {
  return processByCode(modelId, code);
}

function itemsOf(processId) {
  if (!processId) return [];
  return q.all(
    `SELECT i.ord, i.kind, i.dwell_sec, i.fit, i.zoom, i.media_id,
            m.sha256, m.ext, m.mime, m.bytes, m.name
       FROM item i JOIN media m ON m.id = i.media_id
      WHERE i.process_id = ?
      ORDER BY i.ord`,
    processId
  );
}

export function register(router) {
  /**
   * 拉清单：GET /display/playlist?line=L1&op=OP1&model=X300
   * model 可给 code 也可给 id；不给就用这条线的当前机种。
   * 终端用这个接口既做"切换下载"，也做"首次装机补内容"——同一套代码，两条路径。
   */
  router.get('/display/playlist', (req, res, ctx) => {
    const { line } = ctx;
    const op = ctx.process.code;
    touch(line.id, op, termMeta(ctx));

    const want = String(ctx.query.model || '').trim();
    let model;
    if (want) {
      model = q.get('SELECT * FROM model WHERE code = ? OR id = ?', want, want);
      if (!model) throw badRequest(`机种 ${want} 不存在`);
    } else {
      const cur = getState(line.id).currentModelId;
      model = cur ? q.get('SELECT * FROM model WHERE id = ?', cur) : null;
      if (!model) {
        return sendJson(res, 200, {
          lineCode: line.code, lineName: line.name,
          modelCode: '', modelId: '', processCode: op, processName: '',
          items: [], empty: true, count: 0, totalBytes: 0,
          message: `「${line.name}」还没有指定当前机种`
        });
      }
    }

    const proc = processOf(model.id, op);
    const rows = itemsOf(proc?.id);

    sendJson(res, 200, {
      lineCode: line.code,
      lineName: line.name,
      modelCode: model.code,
      modelId: model.id,
      modelName: model.name,
      processCode: op,
      processName: proc?.name || '',
      // 终端一直读 stationCode/stationName，4.0.0 起它们就等于工序码/工序名。
      // 不动字段名是为了让 1.7.x 终端不改一行就能用。
      stationCode: proc?.code || '',
      stationName: proc?.name || '',
      // 运营方式：loop = 播完从头再来；once = 播完停在最后一屏。
      // 老终端不认识这个字段，会按自己的默认（循环）走，行为和升级前一致。
      playMode: proc?.play_mode === 'once' ? 'once' : 'loop',
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
      // 空清单 = 这个机种在这道工序上还没有内容，或者压根没排这道工序。
      // 终端要显式告警，不能静默播空白。
      empty: rows.length === 0,
      // 区分"机种没排这道工序"和"排了但没传内容"：前者要调终端工序号或去加工序
      noStation: !proc,
      count: rows.length,
      // 终端算下载进度用（准备中 3/11）
      totalBytes: rows.reduce((s, r) => s + r.bytes, 0),
      message: !proc
        ? `「${model.code}」没有工序 ${op}，请核对终端上配的工序号`
        : (rows.length === 0 ? `「${model.code}」的工序 ${op} 还没有内容` : '')
    });
  }, { op: true });

  // 终端启动自检：确认线体有效、拿到当前机种，避免一开机就黑屏摸索
  router.get('/display/boot', (req, res, ctx) => {
    const { line } = ctx;
    const op = ctx.process.code;
    touch(line.id, op, termMeta(ctx));
    const st = getState(line.id);
    const cur = st.currentModelId ? q.get('SELECT * FROM model WHERE id = ?', st.currentModelId) : null;
    const proc = cur ? processOf(cur.id, op) : null;
    const have = proc ? q.get('SELECT COUNT(*) n FROM item WHERE process_id = ?', proc.id).n : 0;
    sendJson(res, 200, {
      lineId: line.id,
      lineCode: line.code,
      lineName: line.name,
      processCode: op,
      processName: proc?.name || '',
      modelId: st.currentModelId || '',
      modelCode: cur?.code || '',
      modelName: cur?.name || '',
      stationCode: proc?.code || '',
      stationName: proc?.name || '',
      // 当前机种没有这道工序：终端该提示"这个机种没排这块屏"，
      // 而不是让运维对着空屏猜是网络还是没内容
      noStation: !!cur && !proc,
      seq: st.seq,
      rev: st.rev,
      phase: st.phase,
      itemCount: have,
      online: st.online,
      message: cur && !proc ? `「${cur.code}」没有工序 ${op}` : ''
    });
  }, { op: true });
}

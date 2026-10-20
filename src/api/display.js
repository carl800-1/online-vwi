// 终端接口：拉清单、心跳。终端只读，不改任何内容。
import { q } from '../db.js';
import { now, str, int, parseJson } from '../util.js';
import { sendJson, readJsonBody } from '../router.js';
import { sliceForStation } from '../model.js';
import { signUrl } from '../media.js';

export function register(r) {
  const auth = { station: true };

  /**
   * 拉清单。终端带上本地 seq 与 digest：
   *   一致 -> 只回 { unchanged: true }，几十字节
   *   不一致 -> 回完整清单，媒体带签名地址
   * 这条路径是终端内容的唯一真相来源，SSE 只是加速。
   */
  r.get('/display/manifest', (req, res, ctx) => {
    const s = ctx.station;
    const rel = resolveRelease(s);

    if (!rel) {
      return sendJson(res, 200, {
        empty: true,
        reason: '该产线尚未发布任何版本，请联系工艺员在管理端点击发布',
        station: { code: s.code, name: s.name }
      });
    }

    const seq = int(ctx.query.seq, -1);
    const digest = String(ctx.query.digest || '');
    if (seq === rel.seq && digest === rel.digest) {
      return sendJson(res, 200, { unchanged: true, seq: rel.seq, digest: rel.digest });
    }

    const snap = parseJson(rel.manifest, null);
    if (!snap) return sendJson(res, 500, { error: '发布单数据损坏' });

    const sliced = sliceForStation({ ...snap, releaseId: rel.id, seq: rel.seq }, s, signUrl);
    if (!sliced) {
      return sendJson(res, 200, {
        empty: true,
        reason: '本工位不在当前发布快照中（可能是发布后新增的工位），请重新发布一次',
        station: { code: s.code, name: s.name }
      });
    }

    logEvent('sync', s.id, `工位拉取版本 v${rel.seq}`);
    sendJson(res, 200, { ...sliced, serverTime: now() });
  }, auth);

  // 心跳：顺带把终端当前版本、屏幕、磁盘余量报上来
  r.post('/display/heartbeat', async (req, res, ctx) => {
    const s = ctx.station;
    const body = await readJsonBody(req).catch(() => ({}));
    const ip = clientIp(req);
    const prev = s.last_seq || 0;
    const cur = int(body.seq, prev);

    q.run(`UPDATE station SET last_seen = ?, last_ip = ?, last_seq = ?, app_version = ? WHERE id = ?`,
      now(), ip, cur, str(body.appVersion, 40), s.id);

    if (prev !== cur) {
      logEvent('version', s.id, `工位版本 v${prev} -> v${cur}`);
    }

    // 顺带取走待执行指令（P1 用，本期返回空数组占位）
    const cmds = q.all(
      'SELECT id,type,payload FROM command WHERE station_id = ? AND picked_at = 0 ORDER BY id LIMIT 10', s.id);
    if (cmds.length) q.run(`UPDATE command SET picked_at = ? WHERE station_id = ? AND picked_at = 0`, now(), s.id);

    sendJson(res, 200, {
      ok: true,
      serverTime: now(),
      commands: cmds.map((c) => ({ id: c.id, type: c.type, payload: parseJson(c.payload, {}) })),
      hasNewRelease: !!resolveRelease(s) && resolveRelease(s).seq > cur
    });
  }, auth);
}

/** 取该工位当前应使用的发布单：灰度覆盖 > 产线当前版本；被吊销则回退到上一个可用版本 */
function resolveRelease(station) {
  let releaseId = station.override_release_id || '';
  if (!releaseId) {
    const l = q.get('SELECT active_release_id FROM line WHERE id = ?', station.line_id);
    releaseId = l ? l.active_release_id || '' : '';
  }
  if (!releaseId) return null;

  let rel = q.get('SELECT * FROM release WHERE id = ?', releaseId);
  if (rel && !rel.revoked_at) return rel;

  // 覆盖版本被吊销：退回产线当前版本
  const l = q.get('SELECT active_release_id FROM line WHERE id = ?', station.line_id);
  if (l && l.active_release_id && l.active_release_id !== releaseId) {
    const fallback = q.get('SELECT * FROM release WHERE id = ?', l.active_release_id);
    if (fallback && !fallback.revoked_at) return fallback;
  }
  return null;
}

function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '');
}

function logEvent(kind, stationId, msg, data) {
  try {
    q.run('INSERT INTO event_log(at,kind,station_id,msg,data) VALUES(?,?,?,?,?)',
      now(), kind, stationId, msg, data ? JSON.stringify(data) : '');
  } catch { /* 日志失败不影响主流程 */ }
}

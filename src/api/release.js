// 发布接口：不可变快照、预检、回滚、灰度、吊销
import { q } from '../db.js';
import { now, uid, str, int } from '../util.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { preflight, buildSnapshot } from '../model.js';

export function register(r) {
  // 发布：预检通过才允许，生成不可变快照，产线指针切到新单
  r.post('/api/releases', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = str(body.lineId, 40);
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!line) throw badRequest('产线不存在');

    const problems = preflight(lineId);
    if (problems.length) {
      return sendJson(res, 422, { error: '发布前检查未通过', problems });
    }

    const snapshot = buildSnapshot(lineId);

    q.exec('BEGIN IMMEDIATE');
    try {
      const maxSeq = q.get('SELECT COALESCE(MAX(seq),0) AS m FROM release WHERE line_id = ?', lineId).m;
      const seq = maxSeq + 1;
      const id = uid('rl');
      snapshot.releaseId = id;
      snapshot.seq = seq;

      const mediaCount = Object.keys(snapshot.media).length;
      const byteSize = Object.values(snapshot.media).reduce((s, m) => s + (m.size || 0), 0);

      q.run(`INSERT INTO release(id,line_id,seq,title,note,manifest,digest,media_count,byte_size,created_at,created_by)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, lineId, seq,
        str(body.title, 120) || `${line.name} · 第 ${seq} 版`,
        str(body.note, 500),
        JSON.stringify(snapshot), snapshot.digest,
        mediaCount, byteSize, now(), '');
      q.run('UPDATE line SET active_release_id = ? WHERE id = ?', id, lineId);
      q.exec('COMMIT');

      // 发布后清掉工位上的灰度覆盖，避免有人被永久钉在旧版
      q.run('UPDATE station SET override_release_id = \'\' WHERE line_id = ?', lineId);

      sendJson(res, 200, { item: { id, seq, digest: snapshot.digest, mediaCount, byteSize } });
    } catch (e) {
      q.exec('ROLLBACK');
      throw e;
    }
  });

  r.get('/api/releases', (req, res, ctx) => {
    const lineId = ctx.query.lineId || '';
    const rows = lineId
      ? q.all('SELECT * FROM release WHERE line_id = ? ORDER BY seq DESC', lineId)
      : q.all('SELECT * FROM release ORDER BY created_at DESC LIMIT 100');

    const list = rows.map((x) => ({
      id: x.id, lineId: x.line_id, seq: x.seq, title: x.title, note: x.note,
      digest: x.digest, mediaCount: x.media_count, byteSize: x.byte_size,
      createdAt: x.created_at, revokedAt: x.revoked_at,
      active: isActive(x.id),
      stationCount: q.get('SELECT COUNT(*) n FROM station WHERE override_release_id = ?', x.id).n
    }));
    sendJson(res, 200, { list });
  });

  r.get('/api/releases/:id', (req, res, ctx) => {
    const x = q.get('SELECT * FROM release WHERE id = ?', ctx.params.id);
    if (!x) throw badRequest('发布单不存在');
    const snap = JSON.parse(x.manifest);
    sendJson(res, 200, {
      item: {
        id: x.id, lineId: x.line_id, seq: x.seq, title: x.title, note: x.note,
        digest: x.digest, createdAt: x.created_at, revokedAt: x.revoked_at
      },
      snapshot: {
        stations: snap.stations,
        boards: Object.fromEntries(Object.entries(snap.boards).map(([k, b]) => [k, { name: b.name, pageCount: b.pages.length }])),
        media: snap.media
      }
    });
  });

  // 回滚：把产线指针拨回旧单，不重新生成
  r.post('/api/releases/:id/rollback', async (req, res, ctx) => {
    const x = q.get('SELECT * FROM release WHERE id = ?', ctx.params.id);
    if (!x) throw badRequest('发布单不存在');
    if (x.revoked_at) throw badRequest('该发布单已被吊销，不能回滚到它');
    q.run('UPDATE line SET active_release_id = ? WHERE id = ?', x.id, x.line_id);
    q.run("UPDATE station SET override_release_id = '' WHERE line_id = ?", x.line_id);
    sendJson(res, 200, { ok: true, seq: x.seq });
  });

  // 灰度：只让指定工位先吃新版本
  r.post('/api/releases/:id/gray', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const x = q.get('SELECT * FROM release WHERE id = ?', ctx.params.id);
    if (!x) throw badRequest('发布单不存在');
    if (x.revoked_at) throw badRequest('该发布单已被吊销');
    const stationId = str(body.stationId, 40);
    const s = q.get('SELECT * FROM station WHERE id = ?', stationId);
    if (!s) throw badRequest('工位不存在');
    if (s.line_id !== x.line_id) throw badRequest('该发布单不属于此工位所在产线');
    q.run('UPDATE station SET override_release_id = ? WHERE id = ?', x.id, s.id);
    sendJson(res, 200, { ok: true });
  });

  r.del('/api/releases/:id/gray/:stationId', (req, res, ctx) => {
    q.run('UPDATE station SET override_release_id = \'\' WHERE id = ?', ctx.params.stationId);
    sendJson(res, 200, { ok: true });
  });

  // 吊销：终端拒绝使用，历史仍可查
  r.post('/api/releases/:id/revoke', (req, res, ctx) => {
    const x = q.get('SELECT * FROM release WHERE id = ?', ctx.params.id);
    if (!x) throw badRequest('发布单不存在');
    q.run('UPDATE release SET revoked_at = ? WHERE id = ?', now(), x.id);
    if (isActive(x.id)) {
      // 当前在用的被吊销，自动回退到上一个未吊销版本
      const prev = q.get(`SELECT id FROM release WHERE line_id = ? AND revoked_at = 0 AND id != ?
                          ORDER BY seq DESC LIMIT 1`, x.line_id, x.id);
      q.run('UPDATE line SET active_release_id = ? WHERE id = ?', prev ? prev.id : '', x.line_id);
    }
    sendJson(res, 200, { ok: true });
  });
}

function isActive(releaseId) {
  const row = q.get('SELECT COUNT(*) n FROM line WHERE active_release_id = ?', releaseId);
  return row.n > 0;
}

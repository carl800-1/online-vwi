// 内容树接口：产线、看板、页、工位、终端令牌
import crypto from 'node:crypto';
import { q } from '../db.js';
import { now, uid, str, int } from '../util.js';
import { sendJson, sendError, readJsonBody, badRequest } from '../router.js';
import { sanitizePage, LAYOUTS, layoutMeta } from '../model.js';

export function register(r) {
  // ---------- 元信息 ----------
  r.get('/api/meta', (req, res) => sendJson(res, 200, layoutMeta()));

  // ---------- 产线 ----------
  r.get('/api/lines', (req, res) => {
    const lines = q.all('SELECT * FROM line ORDER BY created_at').map((l) => {
      const st = q.get('SELECT COUNT(*) n FROM station WHERE line_id = ?', l.id).n;
      const bd = q.get('SELECT COUNT(*) n FROM board WHERE line_id = ?', l.id).n;
      const rel = l.active_release_id
        ? q.get('SELECT seq,created_at FROM release WHERE id = ?', l.active_release_id)
        : null;
      return {
        id: l.id, code: l.code, name: l.name, note: l.note,
        stationCount: st, boardCount: bd,
        activeSeq: rel ? rel.seq : 0,
        activeAt: rel ? rel.created_at : 0
      };
    });
    sendJson(res, 200, { list: lines });
  });

  r.post('/api/lines', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const code = str(body.code, 40).trim();
    const name = str(body.name, 80).trim();
    if (!code || !name) throw badRequest('产线编码和名称都不能为空');
    if (q.get('SELECT id FROM line WHERE code = ?', code)) throw badRequest(`产线编码 ${code} 已存在`);
    const id = uid('ln');
    q.run('INSERT INTO line(id,code,name,note,created_at) VALUES(?,?,?,?,?)',
      id, code, name, str(body.note, 300), now());
    sendJson(res, 200, { item: { id } });
  });

  r.put('/api/lines/:id', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const line = q.get('SELECT * FROM line WHERE id = ?', ctx.params.id);
    if (!line) throw badRequest('产线不存在');
    q.run('UPDATE line SET name = ?, note = ? WHERE id = ?',
      str(body.name, 80) || line.name, str(body.note, 300), line.id);
    sendJson(res, 200, { ok: true });
  });

  r.del('/api/lines/:id', (req, res, ctx) => {
    const line = q.get('SELECT * FROM line WHERE id = ?', ctx.params.id);
    if (!line) throw badRequest('产线不存在');
    q.run('DELETE FROM line WHERE id = ?', line.id);
    sendJson(res, 200, { ok: true });
  });

  // ---------- 看板 ----------
  r.get('/api/lines/:id/boards', (req, res, ctx) => {
    const list = q.all('SELECT * FROM board WHERE line_id = ? ORDER BY name', ctx.params.id).map((b) => ({
      id: b.id, name: b.name, note: b.note, updatedAt: b.updated_at,
      pageCount: q.get('SELECT COUNT(*) n FROM page WHERE board_id = ?', b.id).n,
      stationCount: q.get('SELECT COUNT(*) n FROM station WHERE board_id = ?', b.id).n
    }));
    sendJson(res, 200, { list });
  });

  r.get('/api/boards/:id', (req, res, ctx) => {
    const b = q.get('SELECT * FROM board WHERE id = ?', ctx.params.id);
    if (!b) throw badRequest('看板不存在');
    const pages = q.all('SELECT * FROM page WHERE board_id = ? ORDER BY ord', b.id).map(parsePageRow);
    sendJson(res, 200, {
      item: { id: b.id, lineId: b.line_id, name: b.name, note: b.note, updatedAt: b.updated_at },
      pages
    });
  });

  r.post('/api/boards', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = str(body.lineId, 40);
    const name = str(body.name, 80).trim();
    if (!q.get('SELECT id FROM line WHERE id = ?', lineId)) throw badRequest('产线不存在');
    if (!name) throw badRequest('看板名称不能为空');
    const id = uid('bd');
    q.run('INSERT INTO board(id,line_id,name,note,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
      id, lineId, name, str(body.note, 300), now(), '');
    sendJson(res, 200, { item: { id } });
  });

  r.put('/api/boards/:id', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const b = q.get('SELECT * FROM board WHERE id = ?', ctx.params.id);
    if (!b) throw badRequest('看板不存在');
    q.run('UPDATE board SET name = ?, note = ?, updated_at = ? WHERE id = ?',
      str(body.name, 80) || b.name, str(body.note, 300), now(), b.id);
    sendJson(res, 200, { ok: true });
  });

  r.del('/api/boards/:id', (req, res, ctx) => {
    const b = q.get('SELECT * FROM board WHERE id = ?', ctx.params.id);
    if (!b) throw badRequest('看板不存在');
    const used = q.get('SELECT COUNT(*) n FROM station WHERE board_id = ?', b.id).n;
    if (used > 0) throw badRequest(`该看板仍被 ${used} 个工位使用，请先解除绑定`);
    q.run('DELETE FROM board WHERE id = ?', b.id);
    sendJson(res, 200, { ok: true });
  });

  // 整批保存页（不是增量 patch，避免排序错乱）
  r.put('/api/boards/:id/pages', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const b = q.get('SELECT * FROM board WHERE id = ?', ctx.params.id);
    if (!b) throw badRequest('看板不存在');
    const raw = Array.isArray(body.pages) ? body.pages : [];
    if (raw.length > 80) throw badRequest('单个看板最多 80 页');

    const pages = raw.map((p, i) => sanitizePage(p, i));
    q.exec('BEGIN');
    try {
      q.run('DELETE FROM page WHERE board_id = ?', b.id);
      for (const p of pages) {
        q.run('INSERT INTO page(id,board_id,ord,layout,title,duration,blocks) VALUES(?,?,?,?,?,?,?)',
          p.id, b.id, p.ord, p.layout, p.title, p.duration, JSON.stringify(p.blocks));
      }
      q.run('UPDATE board SET updated_at = ?, note = ? WHERE id = ?',
        now(), body.note != null ? str(body.note, 300) : b.note, b.id);
      q.exec('COMMIT');
    } catch (e) {
      q.exec('ROLLBACK');
      throw e;
    }
    sendJson(res, 200, { ok: true, count: pages.length });
  });

  // ---------- 工位 ----------
  r.get('/api/stations', (req, res, ctx) => {
    const lineId = ctx.query.lineId;
    const rows = lineId
      ? q.all('SELECT * FROM station WHERE line_id = ? ORDER BY code', lineId)
      : q.all('SELECT * FROM station ORDER BY code');
    const list = rows.map((s) => {
      const board = s.board_id ? q.get('SELECT name FROM board WHERE id = ?', s.board_id) : null;
      const tok = q.get('SELECT token FROM station_token WHERE station_id = ? ORDER BY created_at DESC LIMIT 1', s.id);
      const relId = s.override_release_id || activeReleaseOf(s.line_id);
      const rel = relId ? q.get('SELECT seq FROM release WHERE id = ?', relId) : null;
      return {
        id: s.id, lineId: s.line_id, code: s.code, name: s.name, opNo: s.op_no,
        boardId: s.board_id || '', boardName: board ? board.name : '',
        overrideReleaseId: s.override_release_id || '',
        targetSeq: rel ? rel.seq : 0,
        lastSeq: s.last_seq || 0,
        lastSeen: s.last_seen || 0,
        lastIp: s.last_ip || '',
        appVersion: s.app_version || '',
        online: s.last_seen ? now() - s.last_seen < 90 * 1000 : false,
        hasToken: !!tok,
        screenW: s.screen_w, screenH: s.screen_h
      };
    });
    sendJson(res, 200, { list });
  });

  r.post('/api/stations', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = str(body.lineId, 40);
    const code = str(body.code, 40).trim();
    const name = str(body.name, 80).trim();
    if (!q.get('SELECT id FROM line WHERE id = ?', lineId)) throw badRequest('产线不存在');
    if (!code || !name) throw badRequest('工位编码和名称都不能为空');
    if (q.get('SELECT id FROM station WHERE code = ?', code)) throw badRequest(`工位编码 ${code} 已存在`);
    const boardId = str(body.boardId, 40);
    if (boardId && !q.get('SELECT id FROM board WHERE id = ?', boardId)) throw badRequest('看板不存在');
    const id = uid('st');
    q.run(`INSERT INTO station(id,line_id,code,name,board_id,op_no,screen_w,screen_h,note,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, lineId, code, name, boardId, str(body.opNo, 20),
      int(body.screenW, 1920), int(body.screenH, 1080), str(body.note, 300), now());
    sendJson(res, 200, { item: { id } });
  });

  r.put('/api/stations/:id', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const s = q.get('SELECT * FROM station WHERE id = ?', ctx.params.id);
    if (!s) throw badRequest('工位不存在');
    if (body.boardId !== undefined) {
      const bid = str(body.boardId, 40);
      if (bid && !q.get('SELECT id FROM board WHERE id = ?', bid)) throw badRequest('看板不存在');
      q.run('UPDATE station SET board_id = ? WHERE id = ?', bid, s.id);
    }
    q.run('UPDATE station SET name = ?, op_no = ?, note = ? WHERE id = ?',
      str(body.name, 80) || s.name,
      body.opNo !== undefined ? str(body.opNo, 20) : s.op_no,
      body.note !== undefined ? str(body.note, 300) : s.note,
      s.id);
    sendJson(res, 200, { ok: true });
  });

  r.del('/api/stations/:id', (req, res, ctx) => {
    const s = q.get('SELECT * FROM station WHERE id = ?', ctx.params.id);
    if (!s) throw badRequest('工位不存在');
    q.run('DELETE FROM station WHERE id = ?', s.id);
    sendJson(res, 200, { ok: true });
  });

  // ---------- 终端令牌 ----------
  r.get('/api/stations/:id/token', (req, res, ctx) => {
    const s = q.get('SELECT * FROM station WHERE id = ?', ctx.params.id);
    if (!s) throw badRequest('工位不存在');
    const tok = q.get('SELECT * FROM station_token WHERE station_id = ? ORDER BY created_at DESC LIMIT 1', s.id);
    sendJson(res, 200, {
      token: tok ? tok.token : '',
      playUrl: tok ? playUrlOf(s.code, tok.token) : ''
    });
  });

  r.post('/api/stations/:id/token', (req, res, ctx) => {
    const s = q.get('SELECT * FROM station WHERE id = ?', ctx.params.id);
    if (!s) throw badRequest('工位不存在');
    const token = crypto.randomBytes(24).toString('base64url');
    q.run('DELETE FROM station_token WHERE station_id = ?', s.id);
    q.run('INSERT INTO station_token(token,station_id,created_at) VALUES(?,?,?)', token, s.id, now());
    sendJson(res, 200, { token, playUrl: playUrlOf(s.code, token), rotated: true });
  });

  r.del('/api/stations/:id/token', (req, res, ctx) => {
    q.run('DELETE FROM station_token WHERE station_id = ?', ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

function parsePageRow(p) {
  let blocks = [];
  try { blocks = JSON.parse(p.blocks); } catch { blocks = []; }
  return { id: p.id, ord: p.ord, layout: p.layout, title: p.title, duration: p.duration, blocks };
}

export function activeReleaseOf(lineId) {
  const l = q.get('SELECT active_release_id FROM line WHERE id = ?', lineId);
  return l ? l.active_release_id || '' : '';
}

function playUrlOf(code, token) {
  const base = process.env.VWI_PUBLIC_URL || '';
  const path = `/display?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`;
  return base ? base.replace(/\/$/, '') + path : path;
}

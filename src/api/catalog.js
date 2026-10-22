// 线体、型号、工序档案：这三张表是"内容骨架"，其余一切都是往里填
//
// v1.7.0 起多了一层「线体」：每天的活不一定在同一条产线上，
// 昨天用一线、今天用二线是常态。所以线体要能建、能启停，
// 工序挂在具体线体下（一线 OP30 和二线 OP30 是两份不同的内容）。
import { q, tx, coverage, processesOf, cloneStandardProcesses, enableOnlyLine, lines } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, resetLine } from '../switch.js';
import { now, uid, str, int } from '../util.js';

function lineStats(l) {
  const cov = coverage(l.id);
  const st = getState(l.id);
  const cur = st.currentModelId ? q.get('SELECT code FROM model WHERE id = ?', st.currentModelId) : null;
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    enabled: !!l.enabled,
    sort: l.sort,
    processes: processesOf(l.id).length,
    coverage: { done: cov.done, total: cov.total },
    currentModelId: st.currentModelId,
    currentModelCode: cur?.code || '',
    phase: st.phase,
    pendingModelCode: st.pendingModelId
      ? (q.get('SELECT code FROM model WHERE id = ?', st.pendingModelId)?.code || '') : '',
    online: st.online.length
  };
}

export function register(router) {
  // ---------- 线体 ----------
  router.get('/api/lines', (req, res) => {
    sendJson(res, 200, { lines: lines().map(lineStats) });
  });

  router.post('/api/lines', async (req, res) => {
    const body = await readJsonBody(req);
    const code = str(body.code, 16).trim();
    const name = str(body.name, 40).trim() || code;
    if (!code) throw badRequest('线体编码不能为空');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('线体编码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM line WHERE code = ?', code)) throw badRequest(`线体 ${code} 已存在`);

    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM line').s;
    const id = uid('ln');
    tx(() => {
      q.run('INSERT INTO line(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
        id, code, name, 0, maxSort + 10, now());
      // 新线体照标准 5 道工序起一份，名字可以之后改
      cloneStandardProcesses(id);
    });
    sendJson(res, 200, lineStats(q.get('SELECT * FROM line WHERE id = ?', id)));
  });

  router.put('/api/lines/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const l = q.get('SELECT * FROM line WHERE id = ?', req.params.id);
    if (!l) throw badRequest('线体不存在');

    if (body.code !== undefined) {
      const code = str(body.code, 16).trim();
      if (!code) throw badRequest('线体编码不能为空');
      if (code !== l.code && q.get('SELECT id FROM line WHERE code = ?', code)) {
        throw badRequest(`线体 ${code} 已存在`);
      }
      q.run('UPDATE line SET code = ? WHERE id = ?', code, l.id);
    }
    if (body.name !== undefined) {
      const name = str(body.name, 40).trim();
      if (!name) throw badRequest('线体名称不能为空');
      q.run('UPDATE line SET name = ? WHERE id = ?', name, l.id);
    }
    if (body.sort !== undefined) q.run('UPDATE line SET sort = ? WHERE id = ?', int(body.sort, l.sort), l.id);

    if (body.enabled !== undefined) {
      if (body.enabled) {
        // 同一时刻只允许一条线体在跑：停掉别的，并把它们的在线/举手记录清掉，
        // 否则下次启用时会读到上一次残留的"已就绪"。
        const others = lines().filter((x) => x.id !== l.id && x.enabled);
        enableOnlyLine(l.id);
        for (const o of others) resetLine(o.id);
      } else {
        q.run('UPDATE line SET enabled = 0 WHERE id = ?', l.id);
        resetLine(l.id);
      }
    }

    sendJson(res, 200, lineStats(q.get('SELECT * FROM line WHERE id = ?', l.id)));
  });

  router.del('/api/lines/:id', (req, res) => {
    const l = q.get('SELECT * FROM line WHERE id = ?', req.params.id);
    if (!l) throw badRequest('线体不存在');
    if (l.enabled) throw badRequest('这条线体正在启用，先停用再删除');
    if (q.get('SELECT COUNT(*) n FROM line').n <= 1) throw badRequest('至少保留一条线体');

    const procIds = processesOf(l.id).map((p) => p.id);
    if (procIds.length) {
      const used = q.get(
        `SELECT COUNT(*) n FROM item WHERE process_id IN (${procIds.map(() => '?').join(',')})`,
        ...procIds
      ).n;
      if (used) throw badRequest(`这条线体还有 ${used} 条播放内容，删掉会丢数据；请先清空清单`);
    }
    tx(() => {
      q.run('DELETE FROM process WHERE line_id = ?', l.id);
      q.run('DELETE FROM line_state WHERE line_id = ?', l.id);
      q.run('DELETE FROM line WHERE id = ?', l.id);
    });
    sendJson(res, 200, { ok: true });
  });

  // ---------- 型号 ----------
  // 型号是全厂共用的：一个型号可能在多条线上做，但每条线各配各的内容。
  router.get('/api/models', (req, res, ctx) => {
    const lineId = String(ctx.query.lineId || '').trim() || pickActiveLineId();
    const models = q.all('SELECT * FROM model ORDER BY sort, code');
    const cov = coverage(lineId);
    sendJson(res, 200, {
      lineId,
      models: models.map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        enabled: !!m.enabled,
        sort: m.sort,
        // 完成度按"这套型号在本线体有几道工序已经有内容"算，分母是线体的工序数
        done: cov.byModel[m.id]?.done ?? 0,
        total: cov.byModel[m.id]?.total ?? 0,
        cells: Object.fromEntries(
          Object.entries(cov.cells)
            .filter(([k]) => k.startsWith(m.id + ':'))
            .map(([k, v]) => [k.split(':')[1], v])
        )
      })),
      coverage: { total: cov.total, done: cov.done }
    });
  });

  router.post('/api/models', async (req, res) => {
    const body = await readJsonBody(req);
    const code = str(body.code, 32).trim();
    const name = str(body.name, 80).trim() || code;
    if (!code) throw badRequest('型号编码不能为空');
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(code)) throw badRequest('型号编码只能用字母、数字、点、下划线、横线');

    if (q.get('SELECT id FROM model WHERE code = ?', code)) {
      throw badRequest(`型号 ${code} 已存在`);
    }
    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM model').s;
    const id = uid('md');
    q.run('INSERT INTO model(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
      id, code, name, 1, maxSort + 10, now());
    sendJson(res, 200, { id, code, name });
  });

  router.put('/api/models/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const m = q.get('SELECT * FROM model WHERE id = ?', req.params.id);
    if (!m) throw badRequest('型号不存在');

    const patch = {};
    if (body.code !== undefined) {
      const code = str(body.code, 32).trim();
      if (!code) throw badRequest('型号编码不能为空');
      if (code !== m.code && q.get('SELECT id FROM model WHERE code = ?', code)) {
        throw badRequest(`型号 ${code} 已存在`);
      }
      patch.code = code;
    }
    if (body.name !== undefined) patch.name = str(body.name, 80).trim() || m.code;
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body.sort !== undefined) patch.sort = int(body.sort, m.sort);

    q.run(
      `UPDATE model SET code = ?, name = ?, enabled = ?, sort = ? WHERE id = ?`,
      patch.code ?? m.code, patch.name ?? m.name,
      patch.enabled ?? m.enabled, patch.sort ?? m.sort, m.id
    );
    sendJson(res, 200, { ok: true });
  });

  // ---------- 工序 ----------
  // 工序挂在具体线体下。新建线体时自动带 5 道标准工序，之后可以改名、增删。
  router.get('/api/processes', (req, res, ctx) => {
    const lineId = String(ctx.query.lineId || '').trim() || pickActiveLineId();
    const processes = processesOf(lineId);
    const ids = processes.map((p) => p.id);
    const counts = ids.length
      ? q.all(
          `SELECT process_id, COUNT(DISTINCT model_id) n FROM item
            WHERE process_id IN (${ids.map(() => '?').join(',')})
            GROUP BY process_id`, ...ids)
      : [];
    const map = new Map(counts.map((r) => [r.process_id, r.n]));
    sendJson(res, 200, {
      lineId,
      processes: processes.map((p) => ({
        id: p.id, code: p.code, name: p.name, sort: p.sort,
        // 这道工序已经有几个型号备好了内容
        modelsWithContent: map.get(p.id) || 0
      }))
    });
  });

  router.post('/api/processes', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = String(body.lineId || '').trim() || pickActiveLineId();
    const code = str(body.code, 16).trim().toUpperCase();
    const name = str(body.name, 40).trim();
    if (!code) throw badRequest('工序编码不能为空（例如 OP60）');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('工序编码只能用字母、数字、点、下划线、横线');
    if (!name) throw badRequest('工序名称不能为空');
    if (q.get('SELECT id FROM process WHERE line_id = ? AND code = ?', lineId, code)) {
      throw badRequest(`这条线体上已经有工序 ${code}`);
    }
    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM process WHERE line_id = ?', lineId).s;
    const id = uid('pr');
    q.run('INSERT INTO process(id,line_id,code,name,sort,created_at) VALUES(?,?,?,?,?,?)',
      id, lineId, code, name, maxSort + 10, now());
    sendJson(res, 200, { id, code, name });
  });

  router.put('/api/processes/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const p = q.get('SELECT * FROM process WHERE id = ?', req.params.id);
    if (!p) throw badRequest('工序不存在');

    if (body.code !== undefined) {
      const code = str(body.code, 16).trim().toUpperCase();
      if (!code) throw badRequest('工序编码不能为空');
      if (code !== p.code &&
          q.get('SELECT id FROM process WHERE line_id = ? AND code = ?', p.line_id, code)) {
        throw badRequest(`这条线体上已经有工序 ${code}`);
      }
      q.run('UPDATE process SET code = ? WHERE id = ?', code, p.id);
    }
    if (body.name !== undefined) {
      const name = str(body.name, 40).trim();
      if (!name) throw badRequest('工序名称不能为空');
      q.run('UPDATE process SET name = ? WHERE id = ?', name, p.id);
    }
    sendJson(res, 200, { ok: true });
  });

  router.del('/api/processes/:id', (req, res) => {
    const p = q.get('SELECT * FROM process WHERE id = ?', req.params.id);
    if (!p) throw badRequest('工序不存在');
    if (q.get('SELECT COUNT(*) n FROM process WHERE line_id = ?', p.line_id).n <= 1) {
      throw badRequest('至少保留一道工序');
    }
    const used = q.get('SELECT COUNT(*) n FROM item WHERE process_id = ?', p.id).n;
    if (used) throw badRequest(`这道工序还有 ${used} 条播放内容，删掉会丢数据；请先清空清单`);
    q.run('DELETE FROM process WHERE id = ?', p.id);
    sendJson(res, 200, { ok: true });
  });
}

function pickActiveLineId() {
  const l = q.get('SELECT id FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1')
    || q.get('SELECT id FROM line ORDER BY sort, code LIMIT 1');
  return l?.id || '';
}

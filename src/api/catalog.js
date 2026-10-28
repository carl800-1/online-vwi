// 线体、型号、工序档案：这三张表是"内容骨架"，其余一切都是往里填
//
// v1.7.0 起多了一层「线体」：每天的活不一定在同一条产线上，
// 昨天用一线、今天用二线是常态。所以线体要能建、能启停，
// 工序挂在具体线体下（一线 OP30 和二线 OP30 是两份不同的内容）。
import { q, tx, coverage, processesOf, cloneStandardProcesses, setLineStatus, LINE_STATUS, lines, ensureStationsForLine, ensureAllModelStations } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, resetLine, notifyContentChanged } from '../switch.js';
import { now, uid, str, int } from '../util.js';

function lineStats(l) {
  const cov = coverage(l.id);
  const st = getState(l.id);
  const cur = st.currentModelId ? q.get('SELECT code FROM model WHERE id = ?', st.currentModelId) : null;
  const nxt = q.get('SELECT next_model_id n FROM line_state WHERE line_id = ?', l.id)?.n || '';
  const next = nxt ? q.get('SELECT code, name FROM model WHERE id = ?', nxt) : null;
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    enabled: !!l.enabled,
    status: l.status || (l.enabled ? 'running' : 'stopped'),
    nextModelCode: next?.code || '',
    nextModelName: next?.name || '',
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
    // 立刻给所有机种在这条线上长出一套空工位：否则新线的每块屏都要人去
    // 「机种设置」逐个机种点一次"补齐"才能配内容，一上线就是空的。
    // 放在上面的事务之外 —— 它自己会开事务，套着开 SQLite 会直接报错。
    ensureStationsForLine(id);
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

    // v3.5.0：状态取代「启用勾选框」。四种状态里只有 running 会让终端读这条线。
    // 兼容老的 {enabled: true/false} 调用（3.4.0 及以前的界面、脚本）。
    const want = body.status !== undefined
      ? String(body.status)
      : (body.enabled !== undefined ? (body.enabled ? 'running' : 'stopped') : '');

    if (want) {
      if (!LINE_STATUS.includes(want)) {
        throw badRequest(`状态只能是 ${LINE_STATUS.join(' / ')}`);
      }
      // 停下来的那一刻要清在线与举手记录，否则下次启用会读到上次残留的"已就绪"。
      // 从非运行切到运行不用清；也不再停别的线 —— 现在允许多条线同时跑。
      if (want !== 'running' && l.enabled) resetLine(l.id);
      setLineStatus(l.id, want);
    }

    sendJson(res, 200, lineStats(q.get('SELECT * FROM line WHERE id = ?', l.id)));
  });

  router.del('/api/lines/:id', (req, res) => {
    const l = q.get('SELECT * FROM line WHERE id = ?', req.params.id);
    if (!l) throw badRequest('线体不存在');
    if (l.enabled) throw badRequest('这条线体正在启用，先停用再删除');
    if (q.get('SELECT COUNT(*) n FROM line').n <= 1) throw badRequest('至少保留一条线体');

    // v3.0.0 起工位带线体维度：这条线的工位（和要求、内容）是**这条线专属**的，
    // 线没了就没人读了，跟着一起删 —— 否则会留下永远看不见的孤儿数据。
    // 别的线的工位不受影响（各存各的）。
    const stCount = q.get('SELECT COUNT(*) n FROM station WHERE line_id = ?', l.id).n;
    tx(() => {
      q.run('DELETE FROM item WHERE station_id IN (SELECT id FROM station WHERE line_id = ?)', l.id);
      q.run('DELETE FROM station_req WHERE station_id IN (SELECT id FROM station WHERE line_id = ?)', l.id);
      q.run('DELETE FROM station WHERE line_id = ?', l.id);
      q.run('DELETE FROM process WHERE line_id = ?', l.id);
      q.run('DELETE FROM line_state WHERE line_id = ?', l.id);
      q.run('DELETE FROM line WHERE id = ?', l.id);
    });
    sendJson(res, 200, { ok: true, stations: stCount });
  });

  // ---------- 型号 ----------
  // 型号是全厂共用的：一个型号可能在多条线上做，但每条线各配各的内容。
  router.get('/api/models', (req, res, ctx) => {
    const lineId = String(ctx.query.lineId || '').trim() || pickActiveLineId();
    const models = q.all('SELECT * FROM model ORDER BY sort, code');
    const cov = coverage(lineId);
    // 机种在**该线体上**的工位完成度，给机种设置页左列表打徽标用。
    // 必须按线统计：同一个机种在一线 5 个工位、二线可能只有 3 个。
    const stMap = new Map(
      q.all(`
        SELECT s.model_id,
               COUNT(*) total,
               SUM(CASE WHEN EXISTS(SELECT 1 FROM item i WHERE i.station_id = s.id) THEN 1 ELSE 0 END) done
          FROM station s WHERE s.line_id = ? GROUP BY s.model_id
      `, lineId).map((r) => [r.model_id, { total: r.total, done: r.done || 0 }])
    );
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
        // 这个机种在本线体上的工位完成度（换线会变）
        stDone: stMap.get(m.id)?.done ?? 0,
        stTotal: stMap.get(m.id)?.total ?? 0,
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
    // 新机种要立刻在各条线上都有工位，否则进机种设置是一片空白，
    // 还得逐条线点「按本线工序补齐」—— 现场一条线十几二十道工序，点一遍就是二十次。
    // 注意 ensureStationsForLine 内部自带事务，必须放在任何外层事务之外调用。
    const stations = ensureAllModelStations();
    sendJson(res, 200, { id, code, name, stations });
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
  // 工序挂在具体线体下（这条线上有几块屏）。新建线体时自动带 5 道标准工序。
  // 内容不在这里：播什么由「机种工位」按同码对位决定。
  router.get('/api/processes', (req, res, ctx) => {
    const lineId = String(ctx.query.lineId || '').trim() || pickActiveLineId();
    const processes = processesOf(lineId);
    // 这道工序在多少个机种里有对应工位且已备内容 —— 只做展示，帮人判断"这条屏是不是空转"
    const counts = q.all(`
      SELECT s.code, COUNT(DISTINCT s.model_id) n
        FROM station s JOIN item i ON i.station_id = s.id
       GROUP BY s.code
    `);
    const map = new Map(counts.map((r) => [r.code, r.n]));
    sendJson(res, 200, {
      lineId,
      processes: processes.map((p) => ({
        id: p.id, code: p.code, name: p.name, sort: p.sort,
        modelsWithContent: map.get(p.code) || 0
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
    // 加了工序就等于这条线多了一块屏：所有机种都要长出对应的空工位，
    // 否则那块屏装了终端也永远没地方配内容（「机种设置」里根本没有这张卡）。
    const added = ensureStationsForLine(lineId);
    notifyContentChanged();
    sendJson(res, 200, { id, code, name, stations: added });
  });

  router.put('/api/processes/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const p = q.get('SELECT * FROM process WHERE id = ?', req.params.id);
    if (!p) throw badRequest('工序不存在');

  let renamed = 0;
  let clash = 0;
  let changed = false;

  if (body.code !== undefined) {
    const code = str(body.code, 16).trim().toUpperCase();
    if (!code) throw badRequest('工序编码不能为空');
    if (code !== p.code &&
        q.get('SELECT id FROM process WHERE line_id = ? AND code = ?', p.line_id, code)) {
      throw badRequest(`这条线体上已经有工序 ${code}`);
    }
    if (code !== p.code) {
      // 工位靠 code 与本线工序对位，工序码一改就得带着工位一起改，
      // 否则老码的工位（连同里面的内容）当场变成"对不上"的孤儿，屏上就是空白。
      // 若某个机种已经有新码的工位，跳过它不覆盖 —— 撞唯一键会整条 500，也比悄悄丢内容好。
      for (const s of q.all('SELECT id, model_id FROM station WHERE line_id = ? AND code = ?', p.line_id, p.code)) {
        const take = q.get('SELECT id FROM station WHERE model_id = ? AND line_id = ? AND code = ?',
          s.model_id, p.line_id, code);
        if (take) { clash += 1; continue; }
        q.run('UPDATE station SET code = ? WHERE id = ?', code, s.id);
        renamed += 1;
      }
      q.run('UPDATE process SET code = ? WHERE id = ?', code, p.id);
      changed = true;
    }
  }
  if (body.name !== undefined) {
    const name = str(body.name, 40).trim();
    if (!name) throw badRequest('工序名称不能为空');
    if (name !== p.name) {
      q.run('UPDATE process SET name = ? WHERE id = ?', name, p.id);
      // 工位名跟着工序名走，只在"工位名还是旧工序名"时才改，避免覆盖人为改过的名字。
      q.run('UPDATE station SET name = ? WHERE line_id = ? AND code = ? AND name = ?',
        name, p.line_id, (body.code !== undefined ? str(body.code, 16).trim().toUpperCase() : p.code), p.name);
      changed = true;
    }
  }
  if (changed) notifyContentChanged();
  sendJson(res, 200, { ok: true, renamed, clash });
});

  router.del('/api/processes/:id', (req, res) => {
    const p = q.get('SELECT * FROM process WHERE id = ?', req.params.id);
    if (!p) throw badRequest('工序不存在');
    if (q.get('SELECT COUNT(*) n FROM process WHERE line_id = ?', p.line_id).n <= 1) {
      throw badRequest('至少保留一道工序');
    }
    // 内容在机种工位上，删工序不动内容；只是这条线少一块屏。
    q.run('DELETE FROM process WHERE id = ?', p.id);
    sendJson(res, 200, { ok: true });
  });
}

function pickActiveLineId() {
  const l = q.get('SELECT id FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1')
    || q.get('SELECT id FROM line ORDER BY sort, code LIMIT 1');
  return l?.id || '';
}

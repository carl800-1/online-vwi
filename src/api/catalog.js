// 型号与工序档案：这两张表是"内容骨架"，其余一切都是往里填
import { q, tx, coverage } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { now, uid, str, int } from '../util.js';

export function register(router) {
  // ---------- 型号 ----------
  router.get('/api/models', (req, res) => {
    const models = q.all('SELECT * FROM model ORDER BY sort, code');
    const cov = coverage();
    sendJson(res, 200, {
      models: models.map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        enabled: !!m.enabled,
        sort: m.sort,
        // 完成度按"这套型号有几道工序已经有内容"算，分母是工序数
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
  // 一期固定 5 道，不提供增删：一台屏就是一道工序，数量由产线决定。
  // 但名字必须能改——用户还没定工序叫什么，默认的"上料/装配/调试/检验/包装"是占位。
  router.get('/api/processes', (req, res) => {
    const processes = q.all('SELECT * FROM process ORDER BY sort, code');
    const counts = q.all('SELECT process_id, COUNT(DISTINCT model_id) n FROM item GROUP BY process_id');
    const map = new Map(counts.map((r) => [r.process_id, r.n]));
    sendJson(res, 200, {
      processes: processes.map((p) => ({
        id: p.id, code: p.code, name: p.name, sort: p.sort,
        // 这道工序已经有几个型号备好了内容
        modelsWithContent: map.get(p.id) || 0
      }))
    });
  });

  router.put('/api/processes/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const p = q.get('SELECT * FROM process WHERE id = ?', req.params.id);
    if (!p) throw badRequest('工序不存在');
    const name = body.name !== undefined ? str(body.name, 40).trim() : p.name;
    if (!name) throw badRequest('工序名称不能为空');
    q.run('UPDATE process SET name = ? WHERE id = ?', name, p.id);
    sendJson(res, 200, { ok: true });
  });
}

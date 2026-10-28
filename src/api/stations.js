// 工位：某个机种在**某条线体上**的「这块屏该看什么」
//
// 三层关系必须分清，否则会当成三套数据：
//   线体（line）      = 一条产线
//   工序（process）   = 这条线上有几块屏，属于现场布局
//   工位（station）   = 这个机种在这条线的这块屏放什么，属于产品 × 线体
//
// v3.0.0 起工位带线体维度：同一个机种在一线和二线的工艺路线可以完全不同
// （工序数量、甚至同一串 OP 号的含义都不同），所以**不能靠工序码跨线对位**。
// 两条线大体相同时又不想重录，用 POST /api/stations/copy 整套复制过来再改。
import { q, tx, stationsOf, stationById, saveStation, copyStations } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';
import { now, uid, str, int } from '../util.js';

/** 没指定线体时回落到"启用中的那条"，和终端不带 line 时的回落规则保持一致。 */
function activeLineId() {
  const hit = q.get('SELECT id FROM line WHERE enabled = 1 ORDER BY sort, id LIMIT 1');
  return hit ? hit.id : (q.get('SELECT id FROM line ORDER BY sort, id LIMIT 1')?.id || '');
}

function mustLine(lineId) {
  const line = q.get('SELECT * FROM line WHERE id = ?', String(lineId || '').trim() || activeLineId());
  if (!line) throw badRequest('线体不存在，请先在「线体设置」里建一条线');
  return line;
}

function mustModel(modelId) {
  const model = q.get('SELECT * FROM model WHERE id = ?', String(modelId || '').trim());
  if (!model) throw badRequest('机种不存在');
  return model;
}

export function register(router) {
  /**
   * GET /api/stations?modelId=&lineId=
   * 一个机种在一条线上的全部工位（含要求与已上传内容），一次取完。
   * 这就是「机种设置」主界面的数据源：先选机种、再选线体，看到的是这条线的那一套。
   */
  router.get('/api/stations', (req, res, ctx) => {
    const model = mustModel(ctx.query.modelId);
    const line = mustLine(ctx.query.lineId);
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name, enabled: !!model.enabled },
      line: { id: line.id, code: line.code, name: line.name, enabled: !!line.enabled },
      stations: stationsOf(model.id, line.id)
    });
  });

  router.post('/api/stations', async (req, res) => {
    const body = await readJsonBody(req);
    const model = mustModel(body.modelId);
    const line = mustLine(body.lineId);

    const code = str(body.code, 16).trim().toUpperCase();
    if (!code) throw badRequest('工位编码不能为空（例如 OP60）');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('工位编码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM station WHERE model_id = ? AND line_id = ? AND code = ?', model.id, line.id, code)) {
      throw badRequest(`「${model.code}」在「${line.name}」上已经有工位 ${code}`);
    }

    const maxSort = q.get(
      'SELECT COALESCE(MAX(sort),0) s FROM station WHERE model_id = ? AND line_id = ?', model.id, line.id
    ).s;
    const id = uid('st');
    tx(() => {
      q.run(
        'INSERT INTO station(id,model_id,line_id,code,name,sort,max_mb,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id, model.id, line.id, code, str(body.name, 40).trim() || code,
        maxSort + 10, int(body.maxMb, 20), str(body.note, 200), now()
      );
      // 新工位默认允许图片、至少 1 张：现场最常见的起点，视频/PDF 按需勾
      q.run(
        'INSERT INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
        uid('sr'), id, 'image', 1, 1280, 720
      );
    });
    notifyContentChanged();
    sendJson(res, 200, stationsOf(model.id, line.id).find((s) => s.id === id));
  });

  /**
   * 改工位：名称、单文件上限、允许类型与份数、以及内容清单，一次提交整份。
   * 内容也走这里（而不是单独的 playlist 接口）—— 工位和它的内容是一件事，
   * 分成两个接口就会出现"要求已保存、内容没保存"的半套状态。
   */
  router.put('/api/stations/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const st = stationById(req.params.id);
    if (!st) throw badRequest('工位不存在');

    // 类型/体积校验在 saveStation 里做 —— 兼容接口 /api/playlist 也走那条路，
    // 两处都写一遍迟早会不一致。
    saveStation(st.model_id, st.id, {
      name: body.name,
      maxMb: body.maxMb,
      note: body.note,
      reqs: Array.isArray(body.reqs) ? body.reqs : undefined,
      items: Array.isArray(body.items) ? body.items : undefined
    });

    notifyContentChanged();
    sendJson(res, 200, stationsOf(st.model_id, st.line_id).find((x) => x.id === st.id));
  });

  router.del('/api/stations/:id', (req, res) => {
    const st = stationById(req.params.id);
    if (!st) throw badRequest('工位不存在');
    const n = q.get('SELECT COUNT(*) n FROM item WHERE station_id = ?', st.id).n;
    if (n) throw badRequest(`这个工位还有 ${n} 项内容，删掉会丢数据；请先清空内容`);
    const left = q.get(
      'SELECT COUNT(*) n FROM station WHERE model_id = ? AND line_id = ?', st.model_id, st.line_id
    ).n;
    if (left <= 1) throw badRequest('至少保留一个工位');

    tx(() => {
      q.run('DELETE FROM station_req WHERE station_id = ?', st.id);
      q.run('DELETE FROM station WHERE id = ?', st.id);
    });
    notifyContentChanged();
    sendJson(res, 200, { ok: true });
  });

  /**
   * 按本线工序补齐这个机种的工位（POST /api/stations/sync {modelId, lineId}）。
   *
   * 方向在 v3.0.0 反过来了：以前是"拿机种工位去补线体工序"，现在线体工序是主、
   * 工位是从它长出来的。所以这里只做一件事 —— 线上新加了工序，这个机种还没跟上，
   * 补几个空工位出来。**不删**多出来的工位（那可能已经配了内容）。
   */
  router.post('/api/stations/sync', async (req, res) => {
    const body = await readJsonBody(req);
    const model = mustModel(body.modelId);
    const line = mustLine(body.lineId);

    const procs = q.all('SELECT * FROM process WHERE line_id = ? ORDER BY sort, code', line.id);
    if (!procs.length) throw badRequest(`「${line.name}」还没有工序，先去「线体设置」加几道`);

    const have = new Set(
      q.all('SELECT code FROM station WHERE model_id = ? AND line_id = ?', model.id, line.id).map((r) => r.code)
    );
    const created = [];
    const t = now();

    tx(() => {
      procs.forEach((p) => {
        if (have.has(p.code)) return;
        const id = uid('st');
        const maxSort = q.get(
          'SELECT COALESCE(MAX(sort),0) s FROM station WHERE model_id = ? AND line_id = ?', model.id, line.id
        ).s;
        q.run(
          'INSERT INTO station(id,model_id,line_id,code,name,sort,max_mb,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          id, model.id, line.id, p.code, p.name, p.sort || maxSort + 10, 20, '', t
        );
        q.run(
          'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), id, 'image', 1, 1280, 720
        );
        created.push(p.code);
      });
    });

    if (created.length) notifyContentChanged();
    sendJson(res, 200, {
      lineName: line.name,
      created,
      kept: [...have],
      total: stationsOf(model.id, line.id).length
    });
  });

  /**
   * 从另一条线复制一套工位过来（POST /api/stations/copy）。
   *
   * 现实里两条线的工艺大同小异，七八个工位只差一两个。从空白开始一张张传太笨，
   * 复制一份过来再改那两处最省事。复制完是**完全独立**的两份：改这边不影响那边。
   *
   * body: { modelId, fromLineId, toLineId, codes?: [], overwrite?: bool }
   *   codes     只复制这几道（省略 = 全部）
   *   overwrite 目标线同名工位**已有内容**时是否覆盖（默认跳过）
   *
   * 注意判据是"有没有内容"而不是"有没有工位"：目标线的工位通常已经按工序建好了，
   * 只是空着 —— 空壳直接填，不算冲突。
   */
  router.post('/api/stations/copy', async (req, res) => {
    const body = await readJsonBody(req);
    const model = mustModel(body.modelId);
    const from = mustLine(body.fromLineId);
    const to = mustLine(body.toLineId);
    if (from.id === to.id) throw badRequest('源线体和目标线体是同一条');

    const srcCount = q.get(
      'SELECT COUNT(*) n FROM station WHERE model_id = ? AND line_id = ?', model.id, from.id
    ).n;
    if (!srcCount) throw badRequest(`「${model.code}」在「${from.name}」上还没有配过工位，没有可复制的内容`);

    const r = copyStations(model.id, from.id, to.id, {
      codes: Array.isArray(body.codes) ? body.codes : undefined,
      overwrite: !!body.overwrite
    });
    notifyContentChanged();

    sendJson(res, 200, {
      fromName: from.name,
      toName: to.name,
      created: r.created,   // 目标线原本没有这个工位，建出来并填了内容
      filled: r.filled,     // 工位本来就在（按工序自动建的），把内容填进去了
      skipped: r.skipped,   // 目标线这个工位已经有内容，没动
      replaced: r.replaced, // overwrite 时被覆盖的
      empty: r.empty,       // 来源线这个工位本来就没内容，没什么可复制
      stations: stationsOf(model.id, to.id)
    });
  });
}

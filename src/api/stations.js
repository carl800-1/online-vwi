// 工位：机种下的「这块屏该看什么」
//
// 和线体工序的关系必须分清，否则会被当成两套数据：
//   线体工序（process）= 这条产线上有几块屏，属于现场布局，一条线一套
//   机种工位（station）= 这个机种的这块屏该放什么，属于产品，全厂一份
// 两者靠**编码对位**：线体的 OP30 播的就是机种里 code=OP30 的工位。
// 所以换线不用重传内容，改一次工位全线生效。
import { q, tx, stationsOf, stationById, saveStation, processesOf } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';
import { now, uid, str, int } from '../util.js';

export function register(router) {
  // 某个机种的全部工位（含要求与已上传内容），一次取完
  router.get('/api/stations', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '').trim();
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name, enabled: !!model.enabled },
      stations: stationsOf(modelId)
    });
  });

  router.post('/api/stations', async (req, res) => {
    const body = await readJsonBody(req);
    const modelId = String(body.modelId || '').trim();
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');

    const code = str(body.code, 16).trim().toUpperCase();
    if (!code) throw badRequest('工位编码不能为空（例如 OP60）');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('工位编码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM station WHERE model_id = ? AND code = ?', modelId, code)) {
      throw badRequest(`这个机种已经有工位 ${code}`);
    }

    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM station WHERE model_id = ?', modelId).s;
    const id = uid('st');
    tx(() => {
      q.run(
        'INSERT INTO station(id,model_id,code,name,sort,max_mb,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id, modelId, code, str(body.name, 40).trim() || code,
        maxSort + 10, int(body.maxMb, 20), str(body.note, 200), now()
      );
      // 新工位默认允许图片、至少 1 张：现场最常见的起点，视频/PDF 按需勾
      q.run(
        'INSERT INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
        uid('sr'), id, 'image', 1, 1280, 720
      );
    });
    notifyContentChanged();
    sendJson(res, 200, stationsOf(modelId).find((s) => s.id === id));
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
    sendJson(res, 200, stationsOf(st.model_id).find((x) => x.id === st.id));
  });

  router.del('/api/stations/:id', (req, res) => {
    const st = stationById(req.params.id);
    if (!st) throw badRequest('工位不存在');
    const n = q.get('SELECT COUNT(*) n FROM item WHERE station_id = ?', st.id).n;
    if (n) throw badRequest(`这个工位还有 ${n} 项内容，删掉会丢数据；请先清空内容`);
    const left = q.get('SELECT COUNT(*) n FROM station WHERE model_id = ?', st.model_id).n;
    if (left <= 1) throw badRequest('至少保留一个工位');

    tx(() => {
      q.run('DELETE FROM station_req WHERE station_id = ?', st.id);
      q.run('DELETE FROM station WHERE id = ?', st.id);
    });
    notifyContentChanged();
    sendJson(res, 200, { ok: true });
  });

  /**
   * 把机种的工位对齐到线体：缺的工序补上、同码的改名和排序。
   *
   * 用途很实际：机种配了 OP10–OP50 五个工位，但线体是新建的只有 3 个工序，
   * 那两块屏装上终端也永远拉不到内容。点一下按机种补齐线体的工序。
   * 默认**不删**线体上多出来的工序 —— 那是物理屏位，删了等于把屏废掉。
   */
  router.post('/api/stations/sync', async (req, res) => {
    const body = await readJsonBody(req);
    const modelId = String(body.modelId || '').trim();
    const lineId = String(body.lineId || '').trim();
    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!model) throw badRequest('机种不存在');
    if (!line) throw badRequest('线体不存在');

    const stations = stationsOf(modelId);
    if (!stations.length) throw badRequest('这个机种还没有工位');

    const existing = processesOf(line.id);
    const byCode = new Map(existing.map((p) => [p.code, p]));
    const created = [];
    const updated = [];

    tx(() => {
      stations.forEach((s) => {
        const hit = byCode.get(s.code);
        if (hit) {
          if (hit.name !== s.name || hit.sort !== s.sort) {
            q.run('UPDATE process SET name = ?, sort = ? WHERE id = ?', s.name, s.sort, hit.id);
            updated.push({ code: s.code, from: hit.name, to: s.name });
          }
        } else {
          q.run(
            'INSERT INTO process(id,line_id,code,name,sort,created_at) VALUES(?,?,?,?,?,?)',
            uid('pr'), line.id, s.code, s.name, s.sort, now()
          );
          created.push({ code: s.code, name: s.name });
        }
      });
    });

    sendJson(res, 200, {
      lineName: line.name,
      processes: processesOf(line.id).length,
      created,
      updated,
      kept: existing.filter((p) => !stations.some((s) => s.code === p.code)).map((p) => p.code)
    });
  });
}

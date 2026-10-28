// 线体、机种、工序：三张表就是全部「内容骨架」，其余都是往里填
//
// v4.0.0 的关系比 3.x 少一层，这是这次重构的全部意义：
//   线体（line）  = 物理产线。只回答"有哪几条线、现在什么状态、有几块屏"。
//   机种（model）= 产品。回答"这个产品有几道工序、能在哪几条线上做"。
//   工序（process）= 机种下的一道工序 = 一块屏。内容挂在这里。
//
// 以前还有「工位」夹在中间（机种 × 线体 × 工序码），存在的理由是同一机种在
// 两条线上的工艺可以不同。现场并不需要，却让每条新线都要长出几百个空壳，
// 改一道工序要改所有线的同码工位 —— 所以 4.0.0 把它并回工序。
import {
  q, tx, coverage, processesOf, processById, saveProcess, modelsOfLine, modelLines, setModelLines,
  createDefaultProcesses, setLineStatus, LINE_STATUS, lines
} from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, resetLine } from '../switch.js';
import { now, uid, str, int } from '../util.js';

function lineStats(l) {
  const st = getState(l.id);
  const cur = st.currentModelId ? q.get('SELECT code FROM model WHERE id = ?', st.currentModelId) : null;
  const nxt = q.get('SELECT next_model_id n FROM line_state WHERE line_id = ?', l.id)?.n || '';
  const next = nxt ? q.get('SELECT code, name FROM model WHERE id = ?', nxt) : null;
  const models = modelsOfLine(l.id);
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    enabled: !!l.enabled,
    status: l.status || (l.enabled ? 'running' : 'stopped'),
    // 这条线有几块屏。只做展示：真正能配几道工序由机种决定，
    // 现场把机种工序数设得比屏多，应该自己去减工序，而不是让系统拦下来。
    slots: l.slots || 0,
    sort: l.sort,
    // 「可生产机种」：机种设置里勾了这条线的那些机种
    modelCount: models.length,
    modelCodes: models.map((m) => m.code),
    currentModelId: st.currentModelId,
    currentModelCode: cur?.code || '',
    nextModelCode: next?.code || '',
    nextModelName: next?.name || '',
    phase: st.phase,
    pendingModelCode: st.pendingModelId
      ? (q.get('SELECT code FROM model WHERE id = ?', st.pendingModelId)?.code || '') : '',
    online: st.online.length
  };
}

/** 线体编码自动生成：L1、L2…。终端 config.json 里填的就是它，所以仍要唯一且稳定。 */
function nextLineCode() {
  const used = new Set(q.all('SELECT code FROM line').map((r) => r.code));
  for (let i = 1; i < 999; i += 1) {
    const c = `L${i}`;
    if (!used.has(c)) return c;
  }
  return `L${Date.now()}`;
}

/**
 * 机种编号自动生成：M1、M2…
 * 现场不想先想编号 —— 它只是个不重复的标识，建完想改在「改编号/名称」里改。
 */
function nextModelCode() {
  const used = new Set(q.all('SELECT code FROM model').map((r) => r.code));
  for (let i = 1; i < 9999; i += 1) {
    const c = `M${i}`;
    if (!used.has(c)) return c;
  }
  return `M${Date.now()}`;
}

function mustModel(id) {
  const m = q.get('SELECT * FROM model WHERE id = ?', String(id || '').trim());
  if (!m) throw badRequest('机种不存在');
  return m;
}

export function register(router) {
  // ---------- 线体 ----------
  router.get('/api/lines', (req, res) => {
    sendJson(res, 200, { lines: lines().map(lineStats) });
  });

  /**
   * 新建线体。界面上只问三件事：名称、几块屏、当前状态。
   * 编码自动给（L1、L2…），不用现场想；要改在「改名」里改。
   * 不再自动铺工序 —— 工序是机种的属性，建线体跟工序无关。
   */
  router.post('/api/lines', async (req, res) => {
    const body = await readJsonBody(req);
    const name = str(body.name, 40).trim();
    if (!name) throw badRequest('线体名称不能为空');
    if (q.get('SELECT id FROM line WHERE name = ?', name)) throw badRequest(`线体「${name}」已存在`);

    const code = str(body.code, 16).trim() || nextLineCode();
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('线体编码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM line WHERE code = ?', code)) throw badRequest(`线体编码 ${code} 已被占用`);

    const status = LINE_STATUS.includes(String(body.status)) ? String(body.status) : 'stopped';
    const slots = Math.min(200, Math.max(1, int(body.slots, 5)));
    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM line').s;
    const id = uid('ln');
    q.run(
      'INSERT INTO line(id,code,name,enabled,status,slots,sort,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id, code, name, status === 'running' ? 1 : 0, status, slots, maxSort + 10, now()
    );
    sendJson(res, 200, lineStats(q.get('SELECT * FROM line WHERE id = ?', id)));
  });

  router.put('/api/lines/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const l = q.get('SELECT * FROM line WHERE id = ?', req.params.id);
    if (!l) throw badRequest('线体不存在');

    if (body.code !== undefined) {
      const code = str(body.code, 16).trim();
      if (!code) throw badRequest('线体编码不能为空');
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('线体编码只能用字母、数字、点、下划线、横线');
      if (code !== l.code && q.get('SELECT id FROM line WHERE code = ?', code)) {
        throw badRequest(`线体编码 ${code} 已被占用`);
      }
      q.run('UPDATE line SET code = ? WHERE id = ?', code, l.id);
    }
    if (body.name !== undefined) {
      const name = str(body.name, 40).trim();
      if (!name) throw badRequest('线体名称不能为空');
      if (name !== l.name && q.get('SELECT id FROM line WHERE name = ?', name)) {
        throw badRequest(`线体「${name}」已存在`);
      }
      q.run('UPDATE line SET name = ? WHERE id = ?', name, l.id);
    }
    if (body.slots !== undefined) {
      q.run('UPDATE line SET slots = ? WHERE id = ?', Math.min(200, Math.max(1, int(body.slots, l.slots))), l.id);
    }
    if (body.sort !== undefined) q.run('UPDATE line SET sort = ? WHERE id = ?', int(body.sort, l.sort), l.id);

    // 状态取代「启用勾选框」。四种状态里只有 running 会让终端读这条线。
    // 兼容老的 {enabled: true/false} 调用。
    const want = body.status !== undefined
      ? String(body.status)
      : (body.enabled !== undefined ? (body.enabled ? 'running' : 'stopped') : '');

    if (want) {
      if (!LINE_STATUS.includes(want)) throw badRequest(`状态只能是 ${LINE_STATUS.join(' / ')}`);
      // 停下来的那一刻要清在线与举手记录，否则下次启用会读到上次残留的"已就绪"。
      if (want !== 'running' && l.enabled) resetLine(l.id);
      setLineStatus(l.id, want);
    }

    sendJson(res, 200, lineStats(q.get('SELECT * FROM line WHERE id = ?', l.id)));
  });

  router.del('/api/lines/:id', (req, res) => {
    const l = q.get('SELECT * FROM line WHERE id = ?', req.params.id);
    if (!l) throw badRequest('线体不存在');
    if (l.enabled) throw badRequest('这条线体正在运行，先改成停线再删除');
    if (q.get('SELECT COUNT(*) n FROM line').n <= 1) throw badRequest('至少保留一条线体');
    // 内容不挂在线体上，删线只断"可生产"的关系，一道工序都不会丢。
    tx(() => {
      q.run('DELETE FROM model_line WHERE line_id = ?', l.id);
      q.run('DELETE FROM line_state WHERE line_id = ?', l.id);
      q.run('DELETE FROM line WHERE id = ?', l.id);
    });
    sendJson(res, 200, { ok: true });
  });

  // ---------- 机种 ----------
  // 机种是全厂共用的：一个机种可能安排在几条线上做，工序仍只有一套。
  router.get('/api/models', (req, res) => {
    const models = q.all('SELECT * FROM model ORDER BY sort, code');
    const cov = coverage();
    const lineMap = new Map();
    for (const r of q.all(
      `SELECT ml.model_id, l.id, l.code, l.name, l.status
         FROM model_line ml JOIN line l ON l.id = ml.line_id ORDER BY l.sort, l.code`
    )) {
      if (!lineMap.has(r.model_id)) lineMap.set(r.model_id, []);
      lineMap.get(r.model_id).push({ id: r.id, code: r.code, name: r.name, status: r.status });
    }
    sendJson(res, 200, {
      models: models.map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        enabled: !!m.enabled,
        sort: m.sort,
        done: cov.byModel[m.id]?.done ?? 0,
        total: cov.byModel[m.id]?.total ?? 0,
        // 这个机种勾了哪几条线（可生产机种的反向），以及各线现在什么状态
        lines: lineMap.get(m.id) || [],
        cells: Object.fromEntries(
          Object.entries(cov.cells)
            .filter(([k]) => k.startsWith(m.id + ':'))
            .map(([k, v]) => [k.split(':')[1], v])
        )
      })),
      coverage: { total: cov.total, done: cov.done },
      // 新建弹窗里「机种编号」的预填值：现场不想自己去想一个不重复的号
      nextCode: nextModelCode()
    });
  });

  /**
   * 新建机种。body: { name, processCount, lineIds[], code? }
   * 一次把"几道工序"和"在哪几条线做"都定下来 —— 这正是用户要的新建弹窗。
   * code 不传就自动给 M1、M2…（界面新建弹窗不显示编码，建完可在「改编码/名称」里改）。
   */
  router.post('/api/models', async (req, res) => {
    const body = await readJsonBody(req);
    const code = str(body.code, 32).trim() || nextModelCode();
    const name = str(body.name, 80).trim() || code;
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(code)) throw badRequest('机种编号只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM model WHERE code = ?', code)) throw badRequest(`机种 ${code} 已存在`);

    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM model').s;
    const id = uid('md');
    q.run('INSERT INTO model(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
      id, code, name, 1, maxSort + 10, now());

    const count = int(body.processCount, 5);
    const made = createDefaultProcesses(id, count);
    const lineIds = Array.isArray(body.lineIds) ? body.lineIds : [];
    setModelLines(id, lineIds);

    sendJson(res, 200, {
      id, code, name, processes: made, lineCount: lineIds.length
    });
  });

  router.put('/api/models/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const m = mustModel(req.params.id);

    if (body.code !== undefined) {
      const code = str(body.code, 32).trim();
      if (!code) throw badRequest('机种编号不能为空');
      if (code !== m.code && q.get('SELECT id FROM model WHERE code = ?', code)) {
        throw badRequest(`机种 ${code} 已存在`);
      }
      q.run('UPDATE model SET code = ? WHERE id = ?', code, m.id);
    }
    if (body.name !== undefined) {
      q.run('UPDATE model SET name = ? WHERE id = ?', str(body.name, 80).trim() || m.code, m.id);
    }
    if (body.enabled !== undefined) q.run('UPDATE model SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, m.id);
    if (body.sort !== undefined) q.run('UPDATE model SET sort = ? WHERE id = ?', int(body.sort, m.sort), m.id);

    // 可生产线体：传数组就整批覆盖（这是机种设置里那个多选框）
    let lineCount;
    if (Array.isArray(body.lineIds)) {
      lineCount = setModelLines(m.id, body.lineIds).length;
    }
    sendJson(res, 200, { ok: true, lineCount });
  });

  router.del('/api/models/:id', (req, res) => {
    const m = mustModel(req.params.id);
    // 正在被某条线生产时不许删：删了终端会立刻变成"没有当前机种"，屏上停住。
    const used = q.get(
      "SELECT COUNT(*) n FROM line_state WHERE current_model_id = ? OR pending_model_id = ? OR next_model_id = ?",
      m.id, m.id, m.id
    ).n;
    if (used) throw badRequest(`「${m.code}」还排在某条线上（当前 / 切换中 / 下一个），先把它换掉再删`);
    tx(() => {
      q.run('DELETE FROM model_line WHERE model_id = ?', m.id);
      q.run('DELETE FROM model WHERE id = ?', m.id);
    });
    sendJson(res, 200, { ok: true });
  });

  // ---------- 工序（= 内容槽位）----------
  router.get('/api/processes', (req, res, ctx) => {
    const model = mustModel(ctx.query.modelId);
    sendJson(res, 200, {
      model: { id: model.id, code: model.code, name: model.name, enabled: !!model.enabled },
      lines: modelLines(model.id).map((l) => ({ id: l.id, code: l.code, name: l.name, status: l.status })),
      processes: processesOf(model.id)
    });
  });

  router.post('/api/processes', async (req, res) => {
    const body = await readJsonBody(req);
    const model = mustModel(body.modelId);
    const code = str(body.code, 16).trim().toUpperCase();
    const name = str(body.name, 40).trim();
    if (!code) throw badRequest('工序码不能为空（例如 OP6）');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('工序码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM process WHERE model_id = ? AND code = ?', model.id, code)) {
      throw badRequest(`「${model.code}」已经有工序 ${code}`);
    }
    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM process WHERE model_id = ?', model.id).s;
    const id = uid('pr');
    tx(() => {
      q.run(
        'INSERT INTO process(id,model_id,code,name,sort,max_mb,note,play_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id, model.id, code, name || code, maxSort + 10, 20, '', 'loop', now()
      );
      // 新工序默认允许图片、至少 1 张：现场最常见的起点，视频/PDF 按需勾
      q.run(
        'INSERT INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
        uid('sr'), id, 'image', 1, 1280, 720
      );
    });
    sendJson(res, 200, processesOf(model.id).find((p) => p.id === id));
  });

  /**
   * 改工序：名称、做什么、体积上限、播放方式、允许类型、内容清单，一次提交整份。
   * 工序和它的内容是一件事，分成两个接口就会出现"要求已保存、内容没保存"的半套状态。
   */
  router.put('/api/processes/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const p = processById(req.params.id);
    if (!p) throw badRequest('工序不存在');

    let renamed = 0;
    let clash = 0;
    let code = p.code;

    if (body.code !== undefined) {
      code = str(body.code, 16).trim().toUpperCase();
      if (!code) throw badRequest('工序码不能为空');
      if (!/^[A-Za-z0-9._-]{1,16}$/.test(code)) throw badRequest('工序码只能用字母、数字、点、下划线、横线');
      if (code !== p.code) {
        if (q.get('SELECT id FROM process WHERE model_id = ? AND code = ?', p.model_id, code)) {
          throw badRequest(`「${p.model_id}」已经有工序 ${code}`);
        }
        q.run('UPDATE process SET code = ? WHERE id = ?', code, p.id);
        renamed = 1;
      }
    }

    // name/note/maxMb/playMode/reqs/items 全部交给 saveProcess，
    // 兼容接口 /api/playlist 也走那条路，两处各写一遍迟早不一致。
    const touched = ['name', 'maxMb', 'note', 'playMode', 'reqs', 'items']
      .some((k) => body[k] !== undefined);
    if (touched) {
      saveProcessBody(p.model_id, p.id, body);
    }

    sendJson(res, 200, {
      ok: true, renamed, clash,
      process: processesOf(p.model_id).find((x) => x.id === p.id)
    });
  });

  router.del('/api/processes/:id', (req, res) => {
    const p = processById(req.params.id);
    if (!p) throw badRequest('工序不存在');
    if (q.get('SELECT COUNT(*) n FROM process WHERE model_id = ?', p.model_id).n <= 1) {
      throw badRequest('至少保留一道工序');
    }
    // 有内容也不拦 —— 删工序本来就是"这块屏不要了"，但要说清删掉几条，让界面去确认。
    const n = q.get('SELECT COUNT(*) n FROM item WHERE process_id = ?', p.id).n;
    q.run('DELETE FROM process WHERE id = ?', p.id);
    sendJson(res, 200, { ok: true, items: n });
  });
}

/** 把 body 里的可写字段转给 saveProcess（单独抽出来只是为了上面的 touched 判断好读）。 */
function saveProcessBody(modelId, processId, body) {
  return saveProcess(modelId, processId, {
    name: body.name,
    maxMb: body.maxMb,
    note: body.note,
    playMode: body.playMode,
    reqs: Array.isArray(body.reqs) ? body.reqs : undefined,
    items: Array.isArray(body.items) ? body.items : undefined
  });
}

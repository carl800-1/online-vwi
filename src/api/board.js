// 作业内容总览：所有线体一屏看完
//
// 这一页回答现场每天都会问的四件事：
//   今天哪几条线在跑？每条线在做哪个机种？正在换型的话换到哪了？哪几块屏还没备齐？
// 所以它只读 + 换型，不做内容编辑 —— 内容的录入在「机种设置」里，
// 那是工程部坐下来干的活，跟产线上盯着屏幕换型是两件事。
import { q, lines, processesOf, setNextModel } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, terminalsOf, switchTo, SWITCH_TIMEOUT_MS } from '../switch.js';
import { now } from '../util.js';

/** 客户端状态：一屏到底走到哪一步了 */
function statusOf(c, phase, curCode) {
  if (!c.seen) return 'absent';              // 从来没连过 —— 多半没装机
  if (!c.online) return 'offline';           // 连过但掉了
  if (phase === 'prepare' && c.ready) return 'ready';
  if (phase === 'prepare') return c.done > 0 ? 'loading' : 'preparing';
  if (!curCode) return 'nomodel';            // 线在跑，但没指定机种
  if (c.modelCode === curCode) return 'playing';
  return 'stale';                            // 在线，屏上还是上一套
}

export function register(router) {
  /**
   * GET /api/board
   * 一次把全部线体的总览数据给全：多少条线就是多少次循环，不值得分页或按需拉。
   */
  router.get('/api/board', (req, res) => {
    const out = lines().map((l) => {
      const st = getState(l.id);
      const terms = terminalsOf(l.id);
      const byOp = new Map(terms.map((t) => [t.op, t]));

      const cur = st.currentModelId ? q.get('SELECT code, name FROM model WHERE id = ?', st.currentModelId) : null;
      const pend = st.pendingModelId ? q.get('SELECT code FROM model WHERE id = ?', st.pendingModelId) : null;
      // 排产：下一个要生产的机种。和 pending 分开存 —— pending 是正在切，切完就空。
      const nxtId = q.get('SELECT next_model_id n FROM line_state WHERE line_id = ?', l.id)?.n || '';
      const nxt = nxtId ? q.get('SELECT code, name FROM model WHERE id = ?', nxtId) : null;

      // v4.0.0：这条线"有几块屏"= 它当前机种有几道工序。没指定机种时不知道要有几块，
      // 先返回空列表 —— 界面会显示"未指定机种"，比编一排假工位诚实。
      const procs = st.currentModelId ? processesOf(st.currentModelId) : [];

      // 当前机种每道工序有没有内容：换型前就看出来"OP4 这套机种压根没配"
      const have = new Map(
        (st.currentModelId
          ? q.all(
              `SELECT p.code, COUNT(i.id) n
                 FROM process p JOIN item i ON i.process_id = p.id
                WHERE p.model_id = ?
                GROUP BY p.code`,
              st.currentModelId
            )
          : []
        ).map((r) => [r.code, r.n])
      );

      const clients = procs.map((p) => {
        const t = byOp.get(p.code);
        const c = {
          op: p.code,
          name: p.name,
          processId: p.id,
          seen: !!t,
          online: !!t && t.online,
          ageMs: t ? t.ageMs : 0,
          ip: t ? t.ip : '',
          ready: !!t && t.ready,
          done: t ? t.done : 0,
          total: t ? t.total : 0,
          modelCode: t ? t.modelCode : '',
          // 这个机种在这道工序上有没有内容。没有的话，换型必然卡在这里
          hasContent: (have.get(p.code) || 0) > 0
        };
        c.status = statusOf(c, st.phase, cur?.code || '');
        return c;
      });

      return {
        id: l.id,
        code: l.code,
        name: l.name,
        enabled: !!l.enabled,
        status: l.status || (l.enabled ? 'running' : 'stopped'),
        sort: l.sort,
        phase: st.phase,
        currentModelId: st.currentModelId,
        currentModelCode: cur?.code || '',
        currentModelName: cur?.name || '',
        nextModelId: nxtId,
        nextModelCode: nxt?.code || '',
        nextModelName: nxt?.name || '',
        pendingModelId: st.pendingModelId,
        pendingModelCode: pend?.code || '',
        deadline: st.deadline,
        timeoutMs: SWITCH_TIMEOUT_MS,
        processes: procs.length,
        slots: l.slots || 0,
        onlineCount: clients.filter((c) => c.online).length,
        readyCount: clients.filter((c) => c.ready).length,
        noContentCount: cur ? clients.filter((c) => !c.hasContent).length : 0,
        clients
      };
    });

    // 概览：今天开线几条、几条停用、几条在维修、几条在保养。
    // 只数线体本身的状态，不掺在线数 —— 那是"屏连没连上"，另一回事。
    const overview = { total: out.length, running: 0, stopped: 0, maintain: 0, care: 0 };
    for (const l of out) overview[l.status] = (overview[l.status] || 0) + 1;

    sendJson(res, 200, { lines: out, overview, ts: now() });
  });

  /**
   * POST /api/board/next
   * 排产：给这条线定"下一个要生产的机种"。传空 modelCode = 取消排产。
   * 和 /api/board/switch 分开：这一步只记下来，不动终端 —— 排产可能提前一天做。
   */
  router.post('/api/board/next', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = String(body.lineId || '').trim();
    const code = String(body.modelCode || '').trim();
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!line) throw badRequest('线体不存在');

    let modelId = '';
    if (code) {
      const model = q.get('SELECT * FROM model WHERE code = ?', code);
      if (!model) throw badRequest(`机种 ${code} 不存在`);
      modelId = model.id;
    }

    try {
      setNextModel(line.id, modelId);
    } catch (e) {
      throw badRequest(e.message);
    }
    sendJson(res, 200, { ok: true, nextModelCode: code });
  });

  /**
   * POST /api/board/switch
   * 总览页直接换型。和 /api/switch 等价，但把线体、机种都放在 body 里，
   * 免得总览页还要维护一套"当前选中哪条线"的前端状态。
   */
  router.post('/api/board/switch', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = String(body.lineId || '').trim();
    const code = String(body.modelCode || '').trim();
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!line) throw badRequest('线体不存在');
    if (!line.enabled) {
      throw badRequest(`「${line.name}」现在不是运行状态，终端不会读它的内容。先把它改成「运行中」。`);
    }
    if (!code) throw badRequest('缺少 modelCode');

    const model = q.get('SELECT * FROM model WHERE code = ?', code);
    if (!model) throw badRequest(`机种 ${code} 不存在`);
    if (!model.enabled) throw badRequest(`机种 ${code} 已停用`);

    const r = switchTo(line, model);
    if (!r.ok) throw badRequest(r.message || '换型失败');
    // 只回最小结果：总览页换完会重新拉 /api/board，不需要在这里拼一份完整状态
    sendJson(res, 200, { ok: true, activated: !!r.activated, phase: getState(line.id).phase });
  });
}

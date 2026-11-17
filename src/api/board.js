// 作业内容：这条线上"正在生产什么" + 每道工序那块屏在不在。
//
// 只做两件事：读总览、指定当前机种（点「推送」走的就是 /api/board/current）。
// 换型不再是"等所有屏备齐再一起翻"的两段式 —— 指定即生效，屏自己按新机种来拉内容。
import { q, lines, processesOf } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, terminalsOf, setCurrentModel } from '../switch.js';
import { now } from '../util.js';

/** 一屏当前算什么状态：没连过 / 离线 / 在播当前机种 / 还停在上一套 */
function statusOf(c, curCode) {
  if (!c.seen) return 'absent';
  if (!c.online) return 'offline';
  if (!curCode) return 'nomodel';
  if (c.modelCode === curCode) return 'playing';
  return 'stale';
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

      // "这条线有几块屏" = 它当前机种有几道工序。没指定机种时不知道要有几块，
      // 先返回空列表 —— 界面显示"未指定机种"，比编一排假工位诚实。
      const procs = st.currentModelId ? processesOf(st.currentModelId) : [];

      // 当前机种每道工序有没有内容：推送前就看出来"OP4 这套机种压根没配"
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
          done: t ? t.done : 0,
          total: t ? t.total : 0,
          modelCode: t ? t.modelCode : '',
          hasContent: (have.get(p.code) || 0) > 0
        };
        c.status = statusOf(c, cur?.code || '');
        return c;
      });

      return {
        id: l.id,
        code: l.code,
        name: l.name,
        enabled: !!l.enabled,
        status: l.status || (l.enabled ? 'running' : 'stopped'),
        sort: l.sort,
        currentModelId: st.currentModelId,
        currentModelCode: cur?.code || '',
        currentModelName: cur?.name || '',
        processes: procs.length,
        slots: l.slots || 0,
        onlineCount: clients.filter((c) => c.online).length,
        noContentCount: cur ? clients.filter((c) => !c.hasContent).length : 0,
        clients
      };
    });

    // 概览：几条线在跑、几条停 / 修 / 养。只数线体状态，不掺在线数。
    const overview = { total: out.length, running: 0, stopped: 0, maintain: 0, care: 0 };
    for (const l of out) overview[l.status] = (overview[l.status] || 0) + 1;

    sendJson(res, 200, { lines: out, overview, ts: now() });
  });

  /**
   * POST /api/board/current
   * 把某个机种设为这条线「正在生产」，屏立即来拉它的内容（推送面板的「推送」）。
   * 落库即生效，不等屏下载、不设超时。
   */
  router.post('/api/board/current', async (req, res) => {
    const body = await readJsonBody(req);
    const lineId = String(body.lineId || '').trim();
    const code = String(body.modelCode || '').trim();
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!line) throw badRequest('线体不存在');
    if (!code) throw badRequest('缺少 modelCode');

    const model = q.get('SELECT * FROM model WHERE code = ?', code);
    if (!model) throw badRequest(`机种 ${code} 不存在`);

    const r = setCurrentModel(line.id, model.id);
    if (!r.ok) throw badRequest(r.message || '指定失败');
    sendJson(res, 200, { ok: true, currentModelCode: code, same: !!r.same });
  });
}

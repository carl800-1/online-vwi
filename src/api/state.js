// 切换与状态：这是整个系统最核心的三个接口，全部按线体独立
import { q, activeLine, lineById, lineByCode, processesOf } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import {
  getState, switchTo, markReady, waitForChange, cancelSwitch, touch,
  setProgress, terminalsOf, SWITCH_TIMEOUT_MS
} from '../switch.js';
import { resolveTerminal } from '../router.js';
import { VERSION } from '../version.js';
import { termMeta, now } from '../util.js';

/** 管理端传 lineId / lineCode；都不传时用当前启用的线体。 */
function pickLine(src) {
  const id = String(src.lineId || '').trim();
  const code = String(src.lineCode || '').trim();
  let line = null;
  if (id) line = lineById(id);
  else if (code) line = lineByCode(code);
  else line = activeLine();
  if (!line) throw badRequest(id || code ? '线体不存在' : '还没有启用任何线体，请先「启用线体」');
  return line;
}

function decorate(state) {
  const cur = state.currentModelId ? q.get('SELECT code, name FROM model WHERE id = ?', state.currentModelId) : null;
  const pend = state.pendingModelId ? q.get('SELECT code, name FROM model WHERE id = ?', state.pendingModelId) : null;
  // v4.0.0：一道工序就是一块屏，线体的屏数 = 当前机种的工序数
  const procCount = state.currentModelId ? processesOf(state.currentModelId).length : 0;
  return {
    lineId: state.lineId,
    rev: state.rev,
    contentRev: state.contentRev,
    seq: state.seq,
    phase: state.phase,
    currentModelId: state.currentModelId,
    modelCode: cur?.code || '',
    modelName: cur?.name || '',
    pendingModelId: state.pendingModelId,
    pendingModelCode: pend?.code || '',
    deadline: state.deadline,
    timeoutMs: SWITCH_TIMEOUT_MS,
    processCount: procCount,
    online: state.online,
    ready: state.ready.map((r) => r.op),
    ts: Date.now()
  };
}

export function register(router) {
  // ---------- 发起切换 ----------
  router.post('/api/switch', async (req, res) => {
    const body = await readJsonBody(req);
    const code = String(body.modelCode || '').trim();
    if (!code) throw badRequest('缺少 modelCode');
    const line = pickLine(body);

    const model = q.get('SELECT * FROM model WHERE code = ?', code);
    if (!model) throw badRequest(`型号 ${code} 不存在`);
    if (!model.enabled) throw badRequest(`型号 ${code} 已停用`);

    const r = switchTo(line, model);
    if (!r.ok) throw badRequest(r.message || '切换失败');
    sendJson(res, 200, { ...r, state: decorate(getState(line.id)) });
  });

  // ---------- 放弃本次切换 ----------
  router.post('/api/switch/cancel', async (req, res) => {
    const body = await readJsonBody(req).catch(() => ({}));
    const line = pickLine(body);
    const r = cancelSwitch(line.id);
    sendJson(res, 200, { ...r, state: decorate(getState(line.id)) });
  });

  // ---------- 终端举手：本工序内容已备齐 ----------
  router.post('/api/ready', async (req, res, ctx) => {
    const body = await readJsonBody(req);

    // 终端可能只带 op（老配置），也可能连 line 一起带；都以 body 为准，其次 query
    const term = { query: { ...ctx.query, ...body } };
    const err = resolveTerminal(req, term);
    if (err) throw Object.assign(new Error(err.message), { status: err.status });

    const modelId = String(body.modelId || '').trim();
    if (!modelId) throw badRequest('缺少 modelId');

    touch(term.line.id, term.process.code, termMeta(ctx));
    const r = markReady(term.line.id, term.process.code, modelId);
    if (!r.ok) sendJson(res, 409, { ...r, state: decorate(getState(term.line.id)) });
    else sendJson(res, 200, { ...r, state: decorate(getState(term.line.id)) });
  });

  // ---------- 长轮询 ----------
  // 终端带 ?line=L1&op=OP30&since=<rev>；管理端带 ?lineId=<id>&since=<rev>（不带 op）
  router.get('/api/state', async (req, res, ctx) => {
    let line;
    if (ctx.query.op) {
      // 终端身份要校验（线体存不存在、工序在不在），配错立刻报，不要静默
      const err = resolveTerminal(req, ctx);
      if (err) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      line = ctx.line;
      touch(line.id, ctx.process.code, termMeta(ctx));
    } else {
      line = pickLine(ctx.query);
    }

    const since = Number(ctx.query.since || 0) || 0;
    await waitForChange(since, res);

    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, decorate(getState(line.id)));
  });

  // ---------- 终端心跳：参数 + 下载进度 ----------
  /**
   * POST /api/telemetry
   * 终端每 5 秒一次，带 res/ver/free/pd/pt。
   * 为什么不复用长轮询：长轮询是"等变化"的，25 秒才回一次；
   * 而右栏的进度条要 2 秒级刷新，挂到长轮询上既看不到进度，又会把耳朵堵住。
   * 这里只写内存，不 bump rev —— 管理端右栏自己轮询，不惊动终端。
   */
  router.post('/api/telemetry', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const term = { query: { ...ctx.query, ...body } };
    const err = resolveTerminal(req, term);
    if (err) throw Object.assign(new Error(err.message), { status: err.status });

    const meta = { ...termMeta({ query: { ...term.query, model: term.query.model } }), ip: ctx.ip };
    if (body.done !== undefined) meta.done = Number(body.done) || 0;
    if (body.total !== undefined) meta.total = Number(body.total) || 0;
    touch(term.line.id, term.process.code, meta);
    if (body.done !== undefined || body.total !== undefined) {
      setProgress(term.line.id, term.process.code, body.done, body.total, body.model);
    }
    sendJson(res, 200, { ok: true, ts: now() });
  });

  // ---------- 某条线体的终端实时参数（管理端右栏） ----------
  /**
   * GET /api/terminals?lineId=&modelCode=
   *
   * 返回的是「这条线的每道工序」而不是「当前在线的机器」：
   * 从来没有任何终端报到的工序也要出现一行，否则现场只会看到 3 个卡片，
   * 看不出 OP40 那台到底是没装还是没开。这一步区分只能靠界面做。
   */
  router.get('/api/terminals', (req, res, ctx) => {
    const line = pickLine(ctx.query);
    const st = getState(line.id);
    const st0 = st.currentModelId;
    // 屏的清单来自当前机种：机种有几道工序，这条线就有几块屏
    const procs = st0 ? processesOf(st0) : [];
    const term = terminalsOf(line.id);
    const byOp = new Map(term.map((t) => [t.op, t]));

    const rows = procs.map((p) => {
      const t = byOp.get(p.code);
      return {
        op: p.code,
        name: p.name,
        processId: p.id,
        // 从没报到过：terminal = null，界面显示「未上线」
        seen: !!t,
        online: !!t && t.online,
        ageMs: t ? t.ageMs : 0,
        ip: t ? t.ip : '',
        res: t ? t.res : '',
        ver: t ? t.ver : '',
        free: t ? t.free : 0,
        done: t ? t.done : 0,
        total: t ? t.total : 0,
        modelCode: t ? t.modelCode : '',
        status: t ? t.status : '',
        ready: !!t && t.ready
      };
    });

    sendJson(res, 200, {
      lineId: line.id,
      lineCode: line.code,
      lineName: line.name,
      enabled: !!line.enabled,
      phase: st.phase,
      currentModelCode: st.currentModelId
        ? (q.get('SELECT code FROM model WHERE id = ?', st.currentModelId)?.code || '') : '',
      pendingModelCode: st.pendingModelId
        ? (q.get('SELECT code FROM model WHERE id = ?', st.pendingModelId)?.code || '') : '',
      onlineCount: rows.filter((r) => r.online).length,
      total: rows.length,
      terminals: rows,
      ts: now()
    });
  });

  // ---------- 健康检查与概览（管理端首页用） ----------
  router.get('/api/status', (req, res, ctx) => {
    const line = pickLine(ctx.query);
    const state = decorate(getState(line.id));
    const models = q.get('SELECT COUNT(*) n FROM model WHERE enabled = 1').n;
    const items = q.get('SELECT COUNT(*) n FROM item').n;
    const media = q.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM media');
    sendJson(res, 200, {
      ...state,
      lineCode: line.code,
      lineName: line.name,
      models,
      processes: state.processCount,
      items,
      media: { count: media.n, bytes: media.b },
      version: VERSION
    });
  });
}

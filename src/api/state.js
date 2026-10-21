// 切换与状态：这是整个系统最核心的三个接口
import { q } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { getState, switchTo, markReady, waitForChange, cancelSwitch, touch, SWITCH_TIMEOUT_MS } from '../switch.js';

function decorate(state) {
  const cur = state.currentModelId ? q.get('SELECT code, name FROM model WHERE id = ?', state.currentModelId) : null;
  const pend = state.pendingModelId ? q.get('SELECT code, name FROM model WHERE id = ?', state.pendingModelId) : null;
  const procCount = q.get('SELECT COUNT(*) n FROM process').n;
  return {
    rev: state.rev,
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

    const model = q.get('SELECT * FROM model WHERE code = ?', code);
    if (!model) throw badRequest(`型号 ${code} 不存在`);
    if (!model.enabled) throw badRequest(`型号 ${code} 已停用`);

    const r = switchTo(model);
    if (!r.ok) throw badRequest(r.message || '切换失败');
    sendJson(res, 200, { ...r, state: decorate(getState()) });
  });

  // ---------- 放弃本次切换 ----------
  router.post('/api/switch/cancel', (req, res) => {
    const r = cancelSwitch();
    sendJson(res, 200, { ...r, state: decorate(getState()) });
  });

  // ---------- 终端举手：本工序内容已备齐 ----------
  router.post('/api/ready', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    const op = String(body.op || ctx.query.op || '').trim();
    const modelId = String(body.modelId || '').trim();
    if (!op) throw badRequest('缺少 op');
    if (!modelId) throw badRequest('缺少 modelId');

    const r = markReady(op, modelId);
    if (!r.ok) sendJson(res, 409, { ...r, state: decorate(getState()) });
    else sendJson(res, 200, { ...r, state: decorate(getState()) });
  });

  // ---------- 长轮询 ----------
  // 终端带 ?op=OP30&since=<rev>；管理端可以不带 op（只看在线情况）
  router.get('/api/state', async (req, res, ctx) => {
    const op = String(ctx.query.op || '').trim();
    if (op) touch(op);

    const since = Number(ctx.query.since || 0) || 0;
    await waitForChange(since, res);

    if (res.writableEnded || res.destroyed) return;
    sendJson(res, 200, decorate(getState()));
  });

  // ---------- 健康检查与概览（管理端首页用） ----------
  router.get('/api/status', (req, res) => {
    touch(''); // 不记录 op，只占位
    const state = decorate(getState());
    const models = q.get('SELECT COUNT(*) n FROM model WHERE enabled = 1').n;
    const procs = q.get('SELECT COUNT(*) n FROM process').n;
    const items = q.get('SELECT COUNT(*) n FROM item').n;
    const media = q.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM media');
    sendJson(res, 200, {
      ...state,
      models,
      processes: procs,
      items,
      media: { count: media.n, bytes: media.b },
      version: '2.0.0'
    });
  });
}

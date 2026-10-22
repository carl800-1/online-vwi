// 配置库：产品工艺配置档案
//
// 回答现场最常问的三个问题：
//   ① 这个产品在哪几条线上做？          → profile.line_codes
//   ② 要做几道工序、每道叫什么？        → profile_step
//   ③ 每道工序要交哪些文件、什么要求？  → profile_req
//
// 它跟「线体内容」的关系必须说清楚，否则会被当成两份数据：
//   配置库 = 应该有什么（模板/检查表，可以有多份，按产品区分）
//   线体内容 = 实际有什么（item 表，按 线体工序 × 型号 存）
// 配置库从不复制内容、也不参与下发；它只在两个地方起作用：
//   「应用到线体」——按档案对齐这条线的工序清单（增/删/改名/排序）
//   「校验」      ——拿档案去量实际内容，指出哪道工序缺什么
// 所以改档案不会影响正在播的内容，这是刻意的：模板被改坏不该让产线黑屏。
import { q, tx, profiles, profileById, saveProfileSteps, processesOf, lines, KINDS } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { now, uid, str, int } from '../util.js';

const KIND_NAME = { image: '图片', video: '视频', pdf: 'PDF' };

function kindName(k) {
  return KIND_NAME[k] || k;
}

/** item 的类型：PDF 拆出来的页在库里是 image，靠 src_sha 认回来 */
function classify(row) {
  if (row.kind === 'video') return 'video';
  if (row.src_sha) return 'pdf';
  return 'image';
}

function normSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s, i) => ({
      seq: int(s.seq, (i + 1) * 10),
      code: str(s.code, 16).trim().toUpperCase(),
      name: str(s.name, 40).trim() || str(s.code, 16).trim(),
      maxMb: Math.max(0, int(s.maxMb, 0)),
      note: str(s.note, 200),
      reqs: (Array.isArray(s.reqs) ? s.reqs : [])
        .filter((r) => KINDS.includes(r.kind))
        .map((r) => ({
          kind: r.kind,
          minCount: Math.max(0, int(r.minCount, 0)),
          minWidth: Math.max(0, int(r.minWidth, 0)),
          minHeight: Math.max(0, int(r.minHeight, 0))
        }))
    }))
    .filter((s) => s.code)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 校验一份档案在「某线体 × 某型号」下的实际内容。
 * 只读，不改任何东西 —— 现场可以放心点，不会动生产数据。
 */
function checkOne(profile, lineId, model, onlyCode) {
  const procs = new Map(processesOf(lineId).map((p) => [p.code, p]));
  const steps = profile.steps
    .filter((s) => !onlyCode || s.code === onlyCode)
    .map((s) => {
      const p = procs.get(s.code);
      if (!p) {
        return {
          code: s.code, name: s.name, processId: '', exists: false, ok: false,
          count: 0, actual: { image: 0, video: 0, pdf: 0 },
          issues: ['线体上还没有这道工序，先「应用到线体」'],
          badItems: []
        };
      }

      const rows = model.id
        ? q.all(
            `SELECT i.media_id, i.kind, i.ord, m.name, m.width, m.height, m.bytes, m.src_sha
               FROM item i JOIN media m ON m.id = i.media_id
              WHERE i.model_id = ? AND i.process_id = ?
              ORDER BY i.ord`,
            model.id, p.id
          )
        : [];

      const actual = { image: 0, video: 0, pdf: 0 };
      const badItems = [];
      for (const r of rows) {
        const k = classify(r);
        actual[k]++;
        const why = [];
        const req = s.reqs.find((x) => x.kind === k);
        if (!req) {
          why.push(`配置不允许放${kindName(k)}`);
        } else if (k === 'image' && (req.minWidth || req.minHeight)) {
          if ((req.minWidth && r.width < req.minWidth) || (req.minHeight && r.height < req.minHeight)) {
            why.push(`分辨率 ${r.width}×${r.height} 低于要求 ${req.minWidth}×${req.minHeight}`);
          }
        }
        if (s.maxMb && r.bytes > s.maxMb * 1024 * 1024) {
          why.push(`体积 ${(r.bytes / 1048576).toFixed(1)}MB 超过上限 ${s.maxMb}MB`);
        }
        if (why.length) badItems.push({ mediaId: r.media_id, name: r.name, reason: why.join('；') });
      }

      const issues = [];
      for (const req of s.reqs) {
        if (actual[req.kind] < req.minCount) {
          issues.push(`${kindName(req.kind)}至少要 ${req.minCount} 份，现有 ${actual[req.kind]} 份`);
        }
      }
      for (const k of KINDS) {
        if (actual[k] > 0 && !s.reqs.some((r) => r.kind === k)) {
          issues.push(`含有 ${actual[k]} 个配置外的${kindName(k)}`);
        }
      }
      if (badItems.length) {
        // 同一个原因可能命中多项，这里只报条数，明细在 badItems
        issues.push(`${badItems.length} 项不符合规格`);
      }

      return {
        code: s.code,
        name: s.name,
        processId: p.id,
        exists: true,
        ok: issues.length === 0,
        count: rows.length,
        actual,
        issues,
        badItems
      };
    });

  const passed = steps.filter((s) => s.ok).length;
  return {
    lineId,
    profileId: profile.id,
    profileCode: profile.code,
    modelId: model.id || '',
    modelCode: model.code || '',
    ok: steps.length > 0 && passed === steps.length,
    summary: { passed, total: steps.length },
    steps
  };
}

export function register(router) {
  // ---------- 档案列表 ----------
  router.get('/api/profiles', (req, res) => {
    sendJson(res, 200, { profiles: profiles(), kinds: KINDS.map((k) => ({ kind: k, name: kindName(k) })) });
  });

  router.post('/api/profiles', async (req, res) => {
    const body = await readJsonBody(req);
    const code = str(body.code, 24).trim().toUpperCase();
    if (!code) throw badRequest('配置编码不能为空');
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(code)) throw badRequest('配置编码只能用字母、数字、点、下划线、横线');
    if (q.get('SELECT id FROM profile WHERE code = ?', code)) throw badRequest(`配置 ${code} 已存在`);

    const id = uid('pf');
    const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM profile').s;
    q.run(
      'INSERT INTO profile(id,code,name,model_id,line_codes,note,enabled,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, code, str(body.name, 80).trim() || code, str(body.modelId, 40), str(body.lineCodes, 200),
      str(body.note, 400), 1, maxSort + 10, now()
    );
    // 建的时候可以一次带工序（从别的档案复制的场景），不带就是空档案
    const steps = normSteps(body.steps);
    if (steps.length) saveProfileSteps(id, steps);
    sendJson(res, 200, profileById(id));
  });

  router.put('/api/profiles/:id', async (req, res) => {
    const body = await readJsonBody(req);
    const p = q.get('SELECT * FROM profile WHERE id = ?', req.params.id);
    if (!p) throw badRequest('配置档案不存在');

    if (body.code !== undefined) {
      const code = str(body.code, 24).trim().toUpperCase();
      if (!code) throw badRequest('配置编码不能为空');
      if (code !== p.code && q.get('SELECT id FROM profile WHERE code = ?', code)) {
        throw badRequest(`配置 ${code} 已存在`);
      }
      q.run('UPDATE profile SET code = ? WHERE id = ?', code, p.id);
    }
    if (body.name !== undefined) {
      const name = str(body.name, 80).trim();
      if (!name) throw badRequest('配置名称不能为空');
      q.run('UPDATE profile SET name = ? WHERE id = ?', name, p.id);
    }
    if (body.modelId !== undefined) {
      const mid = str(body.modelId, 40);
      if (mid && !q.get('SELECT id FROM model WHERE id = ?', mid)) throw badRequest('关联的型号不存在');
      q.run('UPDATE profile SET model_id = ? WHERE id = ?', mid, p.id);
    }
    if (body.lineCodes !== undefined) {
      const codes = String(body.lineCodes || '').split(',').map((x) => x.trim()).filter(Boolean);
      const known = new Set(lines().map((l) => l.code));
      const bad = codes.filter((c) => !known.has(c));
      if (bad.length) throw badRequest(`线体 ${bad.join('、')} 不存在`);
      q.run('UPDATE profile SET line_codes = ? WHERE id = ?', codes.join(','), p.id);
    }
    if (body.note !== undefined) q.run('UPDATE profile SET note = ? WHERE id = ?', str(body.note, 400), p.id);
    if (body.enabled !== undefined) q.run('UPDATE profile SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, p.id);
    if (body.sort !== undefined) q.run('UPDATE profile SET sort = ? WHERE id = ?', int(body.sort, p.sort), p.id);
    if (body.steps !== undefined) saveProfileSteps(p.id, normSteps(body.steps));

    sendJson(res, 200, profileById(p.id));
  });

  router.del('/api/profiles/:id', (req, res) => {
    const p = q.get('SELECT * FROM profile WHERE id = ?', req.params.id);
    if (!p) throw badRequest('配置档案不存在');
    tx(() => {
      const ids = q.all('SELECT id FROM profile_step WHERE profile_id = ?', p.id);
      for (const r of ids) q.run('DELETE FROM profile_req WHERE step_id = ?', r.id);
      q.run('DELETE FROM profile_step WHERE profile_id = ?', p.id);
      q.run('DELETE FROM profile WHERE id = ?', p.id);
    });
    sendJson(res, 200, { ok: true });
  });

  /**
   * 应用到线体：按档案对齐这条线的工序清单。
   *
   * 只动 process 表，不动任何播放清单（item）。
   * 配置外的工序如果已经有内容，**保留**并把数量报回去 ——
   * 自动删掉"配置里没有但有内容"的工序，等于替人删了他的活儿。
   */
  router.post('/api/profiles/:id/apply', async (req, res) => {
    const body = await readJsonBody(req);
    const profile = profileById(req.params.id);
    if (!profile) throw badRequest('配置档案不存在');
    if (!profile.steps.length) throw badRequest('这份配置还没有工序要求，先加几道');

    const lineId = str(body.lineId, 40);
    const line = q.get('SELECT * FROM line WHERE id = ? OR code = ?', lineId, lineId);
    if (!line) throw badRequest('线体不存在');
    // 默认**不删**配置外的工序：只有在界面里明确勾了才删，而且只删没内容的。
    // 一份只有 2 道工序的配置被误套到 5 道工序的线上，自动删掉 3 道是不可接受的损失。
    const prune = body.prune === true;

    const existing = processesOf(line.id);
    const byCode = new Map(existing.map((p) => [p.code, p]));
    const wanted = new Set(profile.steps.map((s) => s.code));
    const created = [];
    const updated = [];
    const removed = [];
    const kept = [];

    tx(() => {
      profile.steps.forEach((s, i) => {
        const sort = s.seq || (i + 1) * 10;
        const hit = byCode.get(s.code);
        if (hit) {
          if (hit.name !== s.name || hit.sort !== sort) {
            q.run('UPDATE process SET name = ?, sort = ? WHERE id = ?', s.name, sort, hit.id);
            updated.push({ code: s.code, from: hit.name, to: s.name });
          }
        } else {
          q.run('INSERT INTO process(id,line_id,code,name,sort,created_at) VALUES(?,?,?,?,?,?)',
            uid('pr'), line.id, s.code, s.name, sort, now());
          created.push({ code: s.code, name: s.name });
        }
      });

      for (const p of existing) {
        if (wanted.has(p.code)) continue;
        const n = q.get('SELECT COUNT(*) n FROM item WHERE process_id = ?', p.id).n;
        if (!prune) {
          kept.push({ code: p.code, name: p.name, items: n, reason: '配置外，已保留' });
          continue;
        }
        if (n > 0) {
          kept.push({ code: p.code, name: p.name, items: n, reason: '配置外但有内容，不能删' });
          continue;
        }
        // 至少留一道工序，否则矩阵和终端身份都没有落脚点
        const left = q.get('SELECT COUNT(*) n FROM process WHERE line_id = ?', line.id).n;
        if (left <= 1) { kept.push({ code: p.code, name: p.name, items: 0, reason: '至少保留一道工序' }); continue; }
        q.run('DELETE FROM process WHERE id = ?', p.id);
        removed.push({ code: p.code, name: p.name });
      }
    });

    sendJson(res, 200, {
      ok: true,
      lineId: line.id,
      lineCode: line.code,
      lineName: line.name,
      created, updated, removed, kept,
      processes: processesOf(line.id).length
    });
  });

  // ---------- 校验 ----------
  // 传 processCode 只查那一道，用于清单抽屉里的即时校验
  router.get('/api/profiles/:id/check', (req, res, ctx) => {
    const profile = profileById(req.params.id);
    if (!profile) throw badRequest('配置档案不存在');

    const lineParam = String(ctx.query.lineId || ctx.query.lineCode || '').trim();
    const line = lineParam
      ? q.get('SELECT * FROM line WHERE id = ? OR code = ?', lineParam, lineParam)
      : q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1')
        || q.get('SELECT * FROM line ORDER BY sort, code LIMIT 1');
    if (!line) throw badRequest('还没有线体');

    const mc = String(ctx.query.modelCode || ctx.query.modelId || '').trim();
    let model = null;
    if (mc) {
      model = q.get('SELECT * FROM model WHERE code = ? OR id = ?', mc, mc);
      if (!model) throw badRequest(`型号 ${mc} 不存在`);
    }

    sendJson(res, 200, checkOne(profile, line.id, model || { id: '', code: '' }, String(ctx.query.processCode || '').trim()));
  });

  /**
   * 按「线体 + 型号」自动挑一份最匹配的档案，供矩阵/抽屉用。
   * 匹配顺序：明确绑了这个型号 > 绑了这条线的通用档案 > 什么都不绑的通用档案。
   * 找不到就返回 null，界面上就不显示要求 —— 没配置不等于不合格。
   */
  router.get('/api/profiles/match', (req, res, ctx) => {
    const lineParam = String(ctx.query.lineId || ctx.query.lineCode || '').trim();
    const line = lineParam
      ? q.get('SELECT * FROM line WHERE id = ? OR code = ?', lineParam, lineParam)
      : q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1');
    const modelCode = String(ctx.query.modelCode || '').trim();
    const model = modelCode ? q.get('SELECT * FROM model WHERE code = ? OR id = ?', modelCode, modelCode) : null;
    if (!line) return sendJson(res, 200, { profile: null });

    const all = profiles()
      .filter((p) => p.enabled)
      .sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
    const fitsLine = (p) => !p.lineCodes.length || p.lineCodes.includes(line.code);

    // 优先级：明确绑了型号 > 名字/编码里带型号（P-X300、X300 工艺）> 绑了线体的通用档案 > 通用档案
    const lc = modelCode.toUpperCase();
    const hit =
      (model && all.find((p) => p.modelId === model.id)) ||
      (lc && all.find((p) => fitsLine(p) && (
        p.code.toUpperCase().includes(lc) || p.name.toUpperCase().includes(lc)))) ||
      all.find((p) => fitsLine(p) && p.lineCodes.length && !p.modelId) ||
      all.find((p) => fitsLine(p) && !p.modelId) ||
      null;

    if (!hit) return sendJson(res, 200, { profile: null });

    const check = model ? checkOne(hit, line.id, model, '') : null;
    sendJson(res, 200, {
      profile: hit,
      check,
      // 工序码 → 要求，前端拿它给矩阵表头加角标
      byCode: Object.fromEntries(hit.steps.map((s) => [s.code, s]))
    });
  });
}

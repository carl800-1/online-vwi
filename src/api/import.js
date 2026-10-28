// 工序表导入：先解析成行给界面看，确认之后整批写库。
//
// 为什么分两步：工艺表是现场自己做的，格式千差万别（有表头没表头、三列四列、
// 序号列在最前）。直接解析即入库，一旦列错位就得一条条删回来；先预览一眼，
// 发现不对就换个文件，什么都不用收拾。
//
// 认列只认**表头名**，不认列号。现场常常在模板前面插一列「序号」，或者把
// 「做什么」调到第二列 —— 按位置读的话整表错位，而表头名是稳的。
// 认不出表头（纯三列、没有标题行）才退回按位置读，老文件照样能导。
//
// v4.0.0：工序归机种，表里不再有「线体」列。带机种列就按行分流到各自机种，
// 没有机种列才退回「导到界面当前选中的机种」—— 老的带线体列的文件也能导，
// 线体列会被识别出来并忽略，不会因为多一列就整表错位。
import { q, tx } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';
import { now, str, uid } from '../util.js';
import { parseSheet } from '../xlsx.js';

/** 工序码：字母或数字开头，允许 - _ . 。中文工序码现场也有，所以不强制字母 */
const CODE_RE = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]{0,15}$/;

/**
 * 表头别名表。键归一化后匹配（去空格、去括号备注、去标点、转小写），
 * 值是要映射到的字段。一个字段挂多少个叫法都不算多 —— 工艺表从谁手里
 * 出来，表头就长谁的样。
 *
 * 刻意**不收**「序号」「行号」：那是 Excel 自己的行序号，收进来当工序码
 * 就是灾难（一表工序码变成 1、2、3）。不收，它自然被忽略。
 *
 * 「线体」仍然认（为了不让多出来的列把表头顶乱），但映射成 ignore，读到了也不写库。
 */
const ALIAS = {
  model: ['机种', '机种名称', '机种编码', '机种代号', '机型', '产品', '产品名称', 'model'],
  line: ['线体', '线体名称', '线体编码', '产线', '产线名称', '生产线', 'line'],
  code: ['工序码', '工序号', '工序编码', '工序编号', '工位码', '工位编号', '编号', 'code', 'op', 'opcode'],
  name: ['名称', '工序名称', '工位名称', '工序名', 'name'],
  note: ['做什么', '工序内容', '工位内容', '内容', '说明', '描述', '备注', '用途', '要求', 'note', 'remark', 'desc']
};

const FIELDS = ['model', 'line', 'code', 'name', 'note'];

function normHeader(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '') // 「工序码（必填）」→「工序码」
    .replace(/[：:、,，;；*＊]/g, '');
}

const FIELD_OF = new Map();
for (const f of FIELDS) for (const a of ALIAS[f]) FIELD_OF.set(normHeader(a), f);

/** 表头行识别：前几行里挑「能认出最多字段」的那一行，至少认出两个（且得有工序码）才算 */
function findHeader(rows) {
  let best = null;
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i += 1) {
    const r = rows[i] || [];
    const map = {};
    r.forEach((cell, ci) => {
      const f = FIELD_OF.get(normHeader(cell));
      if (f && map[f] === undefined) map[f] = ci;
    });
    const n = Object.keys(map).length;
    if (!n) continue;
    if (map.code === undefined && n < 2) continue;
    if (!best || n > best.n) best = { index: i, map, n };
  }
  // 只认出一个字段（比如整表第一格恰好叫「名称」）容易误判成标题行，要求至少两个
  return best && best.n >= 2 ? best : null;
}

/** 按名字或编码找机种；同一个键命中多条时记为 null（重名歧义） */
function indexTargets(list) {
  const hits = new Map();
  for (const r of list) {
    for (const k of [r.code, r.name]) {
      const key = String(k == null ? '' : k).trim().toLowerCase();
      if (!key) continue;
      const arr = hits.get(key) || [];
      if (!arr.includes(r)) arr.push(r);
      hits.set(key, arr);
    }
  }
  const out = new Map();
  for (const [k, arr] of hits) out.set(k, arr.length === 1 ? arr[0] : null);
  return out;
}

function readBuf(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(badRequest('文件太大（上限 8 MB），工序表一般几十 KB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const cellAt = (row, i) => (i === undefined || i === null ? '' : str(row && row[i], 500).trim());

export function register(router) {
  // 第一步：只解析、只判定，不落库
  router.post('/api/import/parse', async (req, res, ctx) => {
    let filename = 'workbook.xlsx';
    try { filename = decodeURIComponent(String(ctx.query.filename || filename)); } catch { /* 明文就用原样 */ }

    // 老的三列文件没有机种列时，用界面上选中的那个兜底
    const selModelId = String(ctx.query.modelId || '').trim();

    const buf = await readBuf(req);
    if (!buf.length) throw badRequest('文件是空的');

    let all;
    try {
      all = parseSheet(buf);
    } catch (e) {
      throw badRequest(e.message || '读不出这个文件，请确认是 .xlsx 或 .csv');
    }
    if (!all.length) throw badRequest('这张表里没有读到任何内容');

    const head = findHeader(all);
    // 认不出表头就按位置读：0 工序码 / 1 名称 / 2 做什么，与 3.3.0 完全一致
    const map = head ? head.map : { code: 0, name: 1, note: 2 };
    const body = head ? all.slice(head.index + 1) : all;
    if (!body.length) throw badRequest('只有标题行，没有工序数据');
    if (map.code === undefined) map.code = 0;

    // 只要认得出「机种」列就按行分流；v3.4.0 那种带线体的五列表也走这条，
    // 线体列被识别出来但不用（工序不再属于线体）。
    const flat = map.model !== undefined;

    const models = q.all('SELECT * FROM model');
    const byModel = indexTargets(models);
    const selModel = selModelId ? models.find((m) => m.id === selModelId) : null;

    if (!flat && !selModel) {
      throw badRequest('这张表里没有「机种」列 —— 先在左上角选好机种再导，或者在表里补上这一列');
    }

    const seen = new Map(); // "modelId|code" → 首次出现的行号
    const out = [];

    body.forEach((r, i) => {
      const rowNo = (head ? head.index + 1 : 0) + i + 1; // 回到 Excel 里的真实行号
      const code = cellAt(r, map.code).toUpperCase();
      const name = cellAt(r, map.name);
      const note = cellAt(r, map.note);
      const rec = { row: rowNo, code, name, note, status: 'new', reason: '' };

      // 整行空白：直接忽略，不算"不合要求"（表格末尾常有空行）
      if (!code && !name && !note) { return; }

      if (flat) {
        const mv = cellAt(r, map.model);
        rec.modelName = mv;
        if (!mv) { rec.status = 'bad'; rec.reason = '没有填机种'; out.push(rec); return; }

        const m = byModel.get(mv.toLowerCase());
        if (m === undefined) { rec.status = 'bad'; rec.reason = `机种「${mv}」还没建档`; out.push(rec); return; }
        if (m === null) { rec.status = 'bad'; rec.reason = `机种「${mv}」有重名，请改用机种编码`; out.push(rec); return; }

        rec.modelId = m.id;
        rec.modelName = m.name;
      } else {
        rec.modelId = selModel.id;
        rec.modelName = selModel.name;
      }

      if (!code) { rec.status = 'bad'; rec.reason = '没有工序码'; out.push(rec); return; }
      if (!CODE_RE.test(code)) {
        rec.status = 'bad';
        rec.reason = '工序码只能用字母、数字、中文和 - _ . ，最长 16 个字符';
        out.push(rec);
        return;
      }

      const key = `${rec.modelId}|${code}`;
      if (seen.has(key)) {
        rec.status = 'bad';
        rec.reason = `与第 ${seen.get(key)} 行工序码重复`;
        out.push(rec);
        return;
      }
      seen.set(key, rowNo);

      const old = q.get('SELECT * FROM process WHERE model_id = ? AND code = ?', rec.modelId, code);
      if (!old) {
        rec.status = 'new';
      } else {
        const sameName = (old.name || '') === (name || code);
        const sameNote = (old.note || '') === note;
        rec.status = sameName && sameNote ? 'same' : 'diff';
        if (rec.status === 'diff') {
          const bits = [];
          if (!sameName) bits.push(`名称 ${old.name || '—'} → ${name || code}`);
          if (!sameNote) bits.push('「做什么」有改动');
          rec.detail = bits.join('，');
        }
      }
      out.push(rec);
    });

    if (!out.length) throw badRequest('这张表里没有读到任何工序行');

    const counts = { new: 0, same: 0, diff: 0, bad: 0 };
    for (const r of out) counts[r.status] += 1;

    // 涉及哪些机种，弹窗顶部要报出来
    const targetMap = new Map();
    for (const r of out) {
      if (r.status === 'bad') continue;
      const t = targetMap.get(r.modelId)
        || { modelId: r.modelId, modelName: r.modelName, n: 0 };
      t.n += 1;
      targetMap.set(r.modelId, t);
    }

    sendJson(res, 200, {
      filename,
      header: head ? (all[head.index] || []) : null,
      headerRow: head ? head.index + 1 : 0,
      mapping: map,
      positional: !head,
      mode: flat ? 'flat' : 'single',
      total: out.length,
      counts,
      targets: [...targetMap.values()],
      rows: out
    });
  });

  // 第二步：按确认过的行批量建/更新
  //
  // mode：
  //   merge        只加库里没有的，已存在的一律跳过（最安全，重复导同一份表不会动任何东西）
  //   update       加新的 + 覆盖已存在的名称与「做什么」（不动已配内容）
  //   update-only  只改已存在的，不建新工序（表里混了草稿行时用这个）
  router.post('/api/processes/import', async (req, res) => {
    const body = await readJsonBody(req);
    const mode = ['merge', 'update', 'update-only'].includes(body.mode) ? body.mode : 'merge';

    // 兼容 3.3.0 的调用方式：rows 是「三列数组 + 顶层 modelId/lineId」。
    let rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length && Array.isArray(rows[0])) {
      rows = rows.map((r, i) => ({
        row: i + 1, modelId: body.modelId, lineId: body.lineId,
        code: r[0], name: r[1], note: r[2]
      }));
    }
    if (!rows.length) throw badRequest('没有可导入的行');

    const models = new Map(q.all('SELECT * FROM model').map((m) => [m.id, m]));

    const stat = { created: 0, updated: 0, kept: 0, skipped: 0, bad: [] };
    const batchId = uid('b');
    const ts = now();
    const touched = new Set();

    // 整批一个事务：中途出错整批回滚，不会留下"导了一半"的工序表
    tx(() => {
      rows.forEach((r, i) => {
        const rowNo = Number(r && r.row) || i + 1;
        const modelId = String((r && r.modelId) || '').trim();
        const code = str(r && r.code, 40).trim().toUpperCase();
        const name = str(r && r.name, 40).trim();
        const note = str(r && r.note, 200).trim();

        if (!models.has(modelId)) { stat.bad.push({ row: rowNo, code, reason: '机种不存在' }); return; }
        if (!code) { stat.bad.push({ row: rowNo, code, reason: '没有工序码' }); return; }
        if (!CODE_RE.test(code)) {
          stat.bad.push({ row: rowNo, code, reason: '工序码只能用字母、数字、中文和 - _ . ，最长 16 个字符' });
          return;
        }

        const old = q.get('SELECT * FROM process WHERE model_id = ? AND code = ?', modelId, code);

        if (!old) {
          if (mode === 'update-only') { stat.skipped += 1; return; }
          // 排在最后：新导入的工序接在已有工序后面，不插队
          const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM process WHERE model_id = ?', modelId).s;
          const id = uid('pr');
          q.run(
            'INSERT INTO process(id,model_id,code,name,sort,max_mb,note,play_mode,import_batch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            id, modelId, code, name || code, maxSort + 10, 20, note, 'loop', batchId, ts
          );
          // 新工序默认允许图片、至少 1 张，和界面上按「+ 加工序」建出来的一致
          q.run(
            'INSERT OR IGNORE INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
            uid('sr'), id, 'image', 1, 1280, 720
          );
          stat.created += 1;
          touched.add(modelId);
          return;
        }

        if (mode === 'merge') { stat.skipped += 1; return; }

        const nextName = str(name || old.name, 40);
        if ((old.name || '') === nextName && (old.note || '') === note) {
          stat.kept += 1; // 内容一模一样，不算更新，省得库里白改一遍
          return;
        }
        q.run('UPDATE process SET name = ?, note = ? WHERE id = ?', nextName, note, old.id);
        stat.updated += 1;
        touched.add(modelId);
      });
    });

    if (stat.created || stat.updated) notifyContentChanged();
    sendJson(res, 200, {
      ...stat,
      mode,
      // 没有新建任何工序时不发批次号 —— 界面上就不会出现一个点了没反应的「撤销」
      batchId: stat.created ? batchId : '',
      touched: [...touched]
    });
  });

  // 撤销本次导入：按批次号精确删除这一批**新建**的工序。
  // 更新过的（改名/改说明）不回滚 —— 旧值没留底，硬编一个"还原"更容易错。
  router.post('/api/processes/import/undo', async (req, res) => {
    const body = await readJsonBody(req);
    const batchId = String(body.batchId || '').trim();
    if (!batchId) throw badRequest('缺少批次号');

    const ps = q.all('SELECT * FROM process WHERE import_batch = ?', batchId);
    if (!ps.length) throw badRequest('这个批次没有可撤销的工序了（可能已经撤过）');

    const ids = ps.map((p) => p.id);
    const holes = ids.map(() => '?').join(',');
    const withContent = q.get(
      `SELECT COUNT(DISTINCT process_id) c FROM item WHERE process_id IN (${holes})`, ...ids
    ).c;

    let deleted = 0;
    tx(() => {
      // process_req 与 item 都是 ON DELETE CASCADE，跟着一起走
      const r = q.run('DELETE FROM process WHERE import_batch = ?', batchId);
      deleted = Number(r && r.changes) || ids.length;
    });

    notifyContentChanged();
    sendJson(res, 200, { deleted, withContent });
  });

  // 老地址：3.4.0 及以前的界面 / 脚本还在打这两个
  router.post('/api/stations/import', (req, res, ctx) => {
    // 直接转发到新处理函数，语义完全一致（rows 里带 modelId 即可）
    return handleLegacyImport(req, res, ctx);
  });
}

// 旧路径单独走一遍，避免路由表里出现"同一条链注册两次 handler"的写法。
async function handleLegacyImport(req, res) {
  const body = await readJsonBody(req);
  const mode = ['merge', 'update', 'update-only'].includes(body.mode) ? body.mode : 'merge';
  let rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length && Array.isArray(rows[0])) {
    rows = rows.map((r, i) => ({ row: i + 1, modelId: body.modelId, code: r[0], name: r[1], note: r[2] }));
  }
  if (!rows.length) throw badRequest('没有可导入的行');

  const models = new Map(q.all('SELECT * FROM model').map((m) => [m.id, m]));
  const stat = { created: 0, updated: 0, kept: 0, skipped: 0, bad: [] };
  const batchId = uid('b');
  const ts = now();
  tx(() => {
    rows.forEach((r, i) => {
      const rowNo = Number(r && r.row) || i + 1;
      const modelId = String((r && r.modelId) || '').trim();
      const code = str(r && r.code, 40).trim().toUpperCase();
      const name = str(r && r.name, 40).trim();
      const note = str(r && r.note, 200).trim();
      if (!models.has(modelId)) { stat.bad.push({ row: rowNo, code, reason: '机种不存在' }); return; }
      if (!code || !CODE_RE.test(code)) { stat.bad.push({ row: rowNo, code, reason: '工序码不合法' }); return; }
      const old = q.get('SELECT * FROM process WHERE model_id = ? AND code = ?', modelId, code);
      if (!old) {
        if (mode === 'update-only') { stat.skipped += 1; return; }
        const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM process WHERE model_id = ?', modelId).s;
        q.run(
          'INSERT INTO process(id,model_id,code,name,sort,max_mb,note,play_mode,import_batch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          uid('pr'), modelId, code, name || code, maxSort + 10, 20, note, 'loop', batchId, ts
        );
        stat.created += 1;
        return;
      }
      if (mode === 'merge') { stat.skipped += 1; return; }
      const nextName = str(name || old.name, 40);
      if ((old.name || '') === nextName && (old.note || '') === note) { stat.kept += 1; return; }
      q.run('UPDATE process SET name = ?, note = ? WHERE id = ?', nextName, note, old.id);
      stat.updated += 1;
    });
  });
  if (stat.created || stat.updated) notifyContentChanged();
  sendJson(res, 200, { ...stat, mode, batchId: stat.created ? batchId : '', touched: [] });
}

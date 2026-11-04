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
//
// v4.3.0：线体设置导出的那份**全量五页**里的「工序参数」页也能导回来了。
// 除四列之外还认：播放方式 / 单文件上限 / 允许类型 / 图片最小尺寸 / 工序工时。
// 认得出哪列就写哪列，认不出（比如老的纯四列表、或者用户自己删了某列）就跳过 ——
// 所以同一份解析代码同时对付「四列老表」和「十二列全量表」，不用两套。
//
// 只读认出「工序参数」页：多页工作簿直接丢进来时按页名找，找不到才退回第一页。
// 否则拿线体设置导出的那份表来导工序，读到的会是「线体清单」，一屏幕全是不合要求。
import { q, tx } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';
import { now, str, uid } from '../util.js';
import { parseSheets } from '../xlsx.js';

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
  // 「机种编号」是 4.3.0 全量导出里的列名，**必须认**：同一张表里紧跟其后的是
  // 「产品名称」，而很多机种共用同一个产品名称（一堆「电钻」）。认不出来就会把
  // 产品名称当成机种去查，几十行里挑出一个碰巧唯一的，其余全报「有重名」。
  model: ['机种', '机种名称', '机种编码', '机种编号', '机种代号', '机型', '产品',
    '产品名称', '产品编号', '型号', 'model'],
  line: ['线体', '线体名称', '线体编码', '产线', '产线名称', '生产线', 'line'],
  code: ['工序码', '工序号', '工序编码', '工序编号', '工位码', '工位编号', '编号', 'code', 'op', 'opcode'],
  name: ['名称', '工序名称', '工位名称', '工序名', 'name'],
  note: ['做什么', '工序内容', '工位内容', '内容', '说明', '描述', '备注', '用途', '要求', 'note', 'remark', 'desc'],

  // ---- 4.3.0 新认的五列（全量导出里的「工序参数」页带的就是它们）----
  play: ['播放方式', '播放模式', '播放', 'playmode', 'play'],
  maxMb: ['单文件上限', '单文件上限mb', '文件大小上限', '大小上限', 'maxmb'],
  cycleSec: ['工序工时', '工时秒件', '工序工时秒件', '标准工时', '工时', 'cyclesecond', 'cycleseconds'],
  kinds: ['允许类型', '允许的文件类型', '允许的文件类型与数量', '文件类型', '允许', 'kinds'],
  minSize: ['图片最小尺寸', '最小尺寸', '最小分辨率', '分辨率', 'minsize'],
  // 4.5.0：播放内容（终端放哪几类）。和「允许」是两件事，
  // 一个管能不能传、一个管放不放，表头也不能互相认。
  playKinds: ['播放内容', '播放类型', '播放内容类型', '放哪几类', 'playkinds']
};

const FIELDS = ['model', 'line', 'code', 'name', 'note',
  'play', 'maxMb', 'cycleSec', 'kinds', 'minSize', 'playKinds'];

/** 导入时优先认这几页（按顺序），都找不到才退回第一页 */
const SHEET_ORDER = ['工序参数', '工序清单', '工序表', 'Sheet1'];

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

// 上限 64 MB：线体设置导出的那份全量表带着 1.6 万道工序，约 10~12 MB。
// 以前卡 8 MB，全量表根本导不进来。
//
// 超限时**不要 req.destroy()** —— 那会让浏览器显示"连接被重置"，看不到这句人话。
// 改成继续把数据读完但不再往 chunks 里塞，最后统一回一个 400 JSON。
const MAX_BUF = 64 * 1024 * 1024;

function readBuf(req, limit = MAX_BUF) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) reject(badRequest(`文件太大（上限 ${Math.round(limit / 1048576)} MB）`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const cellAt = (row, i) => (i === undefined || i === null ? '' : str(row && row[i], 500).trim());

/** 「循环播放 / 播一遍停 / loop / once / 循环 / 一遍」→ loop|once|undefined（没填） */
function parsePlay(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return undefined;
  if (t.includes('once') || t.includes('一遍') || t.includes('停') || t === 'b') return 'once';
  if (t.includes('loop') || t.includes('循环') || t.includes('重复')) return 'loop';
  return undefined;   // 认不出就当没填，不瞎猜
}

/** 数字列：空串 = 没填（undefined），乱填 = NaN（调用方记 bad） */
function parseNum(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return undefined;
  const n = Number(t.replace(/[，,]/g, '.'));
  return Number.isFinite(n) ? n : NaN;
}

const KIND_OF_CN = { 图片: 'image', 图像: 'image', image: 'image', img: 'image',
  pdf: 'pdf', PDF: 'pdf', 文档: 'pdf',
  视频: 'video', video: 'video', mp4: 'video' };

const PLAY_CN = { image: '图片', pdf: 'PDF', video: '视频' };
/** 三类数组 → 人话。全放（或空）写「全部」，和导出那一栏保持一致 */
function playKindsCn(arr) {
  const s = Array.isArray(arr) ? arr : [];
  const hit = ['image', 'pdf', 'video'].filter((k) => s.includes(k));
  if (!hit.length || hit.length === 3) return '全部';
  return hit.map((k) => PLAY_CN[k]).join('；');
}

/** 三类数组 → 存库文本。没给 / 三类全给 → ''（= 全放），和 saveProcess 一个写法 */
function playKindsText(arr) {
  if (!Array.isArray(arr) || !arr.length || arr.length === 3) return '';
  return arr.join(',');
}

/**
 * 「允许类型」解析成 [{kind, minCount}]。
 * 认这些写法：`图片≥1`、`图片1`、`图片`、`图片≥1；PDF≥1`、`图片,PDF`，
 * 以及导出时写的 `不限` / 空 → []（= 不限类型，process_req 整表为空）。
 */
function parseKinds(v) {
  const t = String(v || '').trim();
  if (!t || /^(不限|无|none|-|—)$/i.test(t)) return [];
  const out = [];
  for (const part of t.split(/[；;、,，\/|]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^([^≥>\d\s]+)\s*[≥>≥]?\s*(\d*)$/);
    const cn = m ? m[1] : seg;
    const kind = KIND_OF_CN[cn] || KIND_OF_CN[cn.toLowerCase()];
    if (!kind) return null;                  // 认不出类型 → 整格算坏，不半懂半不懂地写
    if (out.some((x) => x.kind === kind)) continue;
    out.push({ kind, minCount: m && m[2] ? Number(m[2]) : 0 });
  }
  return out.length ? out : [];
}

/**
 * 「播放内容」解析成 ['image','pdf','video'] 的子集（顺序按界面：图片 / PDF / 视频）。
 * 认：`全部`、`不限`、`图片；PDF；视频`、`图片,视频`、`图片、PDF`。
 * 认不出 → null（整行 bad，不猜）；空 → undefined（= 这格不改）。
 *
 * 与「允许类型」分开解析：那边带数量（`图片≥1`），这边只关心放不放。
 */
function parsePlayKinds(v) {
  const t = String(v || '').trim();
  if (!t) return undefined;
  if (/^(全部|全放|不限|所有|all|-|—)$/i.test(t)) return ['image', 'pdf', 'video'];
  const out = [];
  for (const part of t.split(/[；;、,，\/|＋+]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const kind = KIND_OF_CN[seg] || KIND_OF_CN[seg.toLowerCase()];
    if (!kind) return null;
    if (!out.includes(kind)) out.push(kind);
  }
  if (!out.length) return null;
  return ['image', 'pdf', 'video'].filter((k) => out.includes(k));
}

/** 「1280×720」「1280x720」「宽≥1280」「高≥720」→ {w,h}；空 → null */
function parseSize(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const m = t.match(/(\d+)\s*[×xX*]\s*(\d+)/);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  const w = t.match(/宽\D*(\d+)/);
  const h = t.match(/高\D*(\d+)/);
  if (w || h) return { w: w ? Number(w[1]) : 0, h: h ? Number(h[1]) : 0 };
  return null;
}

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
    let sheetName = '';
    try {
      const sheets = parseSheets(buf);
      // 多页工作簿按页名找「工序参数」；单页 / 老文件就用第一页
      const hit = SHEET_ORDER.map((n) => sheets.find((x) => x.name === n)).find((x) => x && x.rows.length)
        || sheets.find((x) => x.rows.length)
        || sheets[0];
      all = hit.rows;
      sheetName = hit.name;
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

      // ---- 4.3.0：额外的五列。认得出列才解析，没这列就当老四列表处理 ----
      // 解析出问题（数字里混了字母、类型名认不出）整行记 bad —— 宁可让人改，
      // 也别把「8.5」写成 0、把「图片」猜成「视频」。
      const extra = {};
      const extraBad = [];
      if (map.play !== undefined) {
        const raw = cellAt(r, map.play);
        const v = parsePlay(raw);
        if (v) extra.playMode = v;
        else if (raw) extraBad.push(`播放方式「${raw}」认不出，写「循环播放」或「播一遍停」`);
      }
      if (map.maxMb !== undefined) {
        const v = parseNum(cellAt(r, map.maxMb));
        if (v === undefined) { /* 留空 = 不改 */ }
        else if (Number.isNaN(v) || v < 0) extraBad.push('单文件上限要填 0 或正数（0 = 不限）');
        else extra.maxMb = Math.min(9999, Math.round(v));
      }
      if (map.cycleSec !== undefined) {
        const v = parseNum(cellAt(r, map.cycleSec));
        if (v === undefined) { /* 留空 = 不改 */ }
        else if (Number.isNaN(v) || v < 0) extraBad.push('工序工时填秒数（例如 8.5），留空表示还没测');
        else extra.cycleSec = Math.min(86400, Math.round(v * 10) / 10);
      }
      if (map.kinds !== undefined) {
        const raw = cellAt(r, map.kinds);
        if (raw) {
          const k = parseKinds(raw);
          if (k === null) extraBad.push(`允许类型「${raw}」认不出，写「图片≥1；PDF≥1」或「不限」`);
          else extra.kinds = k;
        }
      }
      if (map.minSize !== undefined) {
        const raw = cellAt(r, map.minSize);
        if (raw) {
          const sz = parseSize(raw);
          if (!sz) extraBad.push(`图片最小尺寸「${raw}」认不出，写「1280×720」`);
          else extra.minSize = sz;
        }
      }
      if (map.playKinds !== undefined) {
        const raw = cellAt(r, map.playKinds);
        const pk = parsePlayKinds(raw);
        if (pk === null) extraBad.push(`播放内容「${raw}」认不出，写「全部」或「图片；视频」`);
        else if (pk) extra.playKinds = pk;
      }

      if (extraBad.length) {
        rec.status = 'bad';
        rec.reason = extraBad[0];
        out.push(rec);
        return;
      }

      const old = q.get('SELECT * FROM process WHERE model_id = ? AND code = ?', rec.modelId, code);
      if (!old) {
        rec.status = 'new';
      } else {
        const bits = [];
        if ((old.name || '') !== (name || code)) bits.push(`名称 ${old.name || '—'} → ${name || code}`);
        if ((old.note || '') !== note) bits.push('「做什么」有改动');

        // 只在"表里有这一列"时才比对，否则老四列表会把每一行都标成有变化
        if (extra.playMode !== undefined && (old.play_mode || 'loop') !== extra.playMode) {
          bits.push(`播放方式 ${old.play_mode === 'once' ? '播一遍停' : '循环播放'} → ${
            extra.playMode === 'once' ? '播一遍停' : '循环播放'}`);
        }
        if (extra.maxMb !== undefined && Number(old.max_mb || 0) !== extra.maxMb) {
          bits.push(`单文件上限 ${Number(old.max_mb || 0)} → ${extra.maxMb} MB`);
        }
        if (extra.cycleSec !== undefined && (Number(old.cycle_sec) || 0) !== extra.cycleSec) {
          bits.push(`工序工时 ${Number(old.cycle_sec) || 0} → ${extra.cycleSec} 秒`);
        }
        if (extra.kinds !== undefined) {
          const cur = q.all('SELECT * FROM process_req WHERE process_id = ? ORDER BY kind', old.id);
          const curText = cur.map((x) => `${x.kind}:${x.min_count}`).sort().join(',');
          const newText = extra.kinds.map((x) => `${x.kind}:${x.minCount}`).sort().join(',');
          if (curText !== newText) bits.push(`允许类型 ${curText || '不限'} → ${newText || '不限'}`);
        }
        if (extra.minSize !== undefined) {
          const img = q.get("SELECT * FROM process_req WHERE process_id = ? AND kind = 'image'", old.id);
          const cw = img ? Number(img.min_width) || 0 : 0;
          const ch = img ? Number(img.min_height) || 0 : 0;
          if (cw !== extra.minSize.w || ch !== extra.minSize.h) {
            bits.push(`图片最小尺寸 ${cw || ch ? `${cw}×${ch}` : '不限'} → ${extra.minSize.w}×${extra.minSize.h}`);
          }
        }
        if (extra.playKinds !== undefined) {
          // 空串 = 三类全放，比较前先归一，否则"全部"每次都被当成"改了"
          const cur = String(old.play_kinds || '').split(',').filter(Boolean);
          if (playKindsCn(cur) !== playKindsCn(extra.playKinds)) {
            bits.push(`播放内容 ${playKindsCn(cur)} → ${playKindsCn(extra.playKinds)}`);
          }
        }

        rec.status = bits.length ? 'diff' : 'same';
        if (bits.length) rec.detail = bits.join('，');
      }

      // 额外的值随行带着走：写库那一步照着它改，不再回头读一遍表
      if (Object.keys(extra).length) rec.extra = extra;
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
      sheet: sheetName,
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

        const extra = (r && r.extra) || {};

        if (!old) {
          if (mode === 'update-only') { stat.skipped += 1; return; }
          // 排在最后：新导入的工序接在已有工序后面，不插队
          const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM process WHERE model_id = ?', modelId).s;
          const id = uid('pr');
          q.run(
            'INSERT INTO process(id,model_id,code,name,sort,max_mb,note,play_mode,cycle_sec,play_kinds,import_batch,created_at)'
            + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            id, modelId, code, name || code, maxSort + 10,
            extra.maxMb === undefined ? 20 : extra.maxMb, note,
            extra.playMode || 'loop', extra.cycleSec === undefined ? 0 : extra.cycleSec,
            playKindsText(extra.playKinds),
            batchId, ts
          );
          if (extra.kinds !== undefined || extra.minSize !== undefined) {
            applyReqs(id, extra);
          } else {
            // 新工序默认允许图片、至少 1 张，和界面上按「+ 加工序」建出来的一致
            q.run(
              'INSERT OR IGNORE INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
              uid('sr'), id, 'image', 1, 1280, 720
            );
          }
          stat.created += 1;
          touched.add(modelId);
          return;
        }

        if (mode === 'merge') { stat.skipped += 1; return; }

        const nextName = str(name || old.name, 40);
        const nextMb = extra.maxMb === undefined ? Number(old.max_mb || 0) : extra.maxMb;
        const nextPlay = extra.playMode === undefined ? (old.play_mode || 'loop') : extra.playMode;
        const nextSec = extra.cycleSec === undefined ? (Number(old.cycle_sec) || 0) : extra.cycleSec;
        const nextPK = extra.playKinds === undefined
          ? String(old.play_kinds || '')
          : playKindsText(extra.playKinds);

        // 允许类型要不要动，先算出来再比 —— 全量导出每行都带「允许类型」，
        // 不先比一下的话，导一次「什么都没改」的表也会把 1.6 万行全标成更新
        const needReqs = extra.kinds !== undefined || extra.minSize !== undefined;
        const curReqs = needReqs ? q.all('SELECT * FROM process_req WHERE process_id = ?', old.id) : [];
        const nextReqs = needReqs ? planReqs(curReqs, extra) : [];
        const reqSame = needReqs ? sameReqs(curReqs, nextReqs) : true;

        // 四列老表走到这里时 extra 是空的，行为和 4.2.x 完全一样
        if ((old.name || '') === nextName && (old.note || '') === note
            && Number(old.max_mb || 0) === nextMb && (old.play_mode || 'loop') === nextPlay
            && (Number(old.cycle_sec) || 0) === nextSec && String(old.play_kinds || '') === nextPK
            && reqSame) {
          stat.kept += 1; // 内容一模一样，不算更新，省得库里白改一遍
          return;
        }
        q.run(
          'UPDATE process SET name = ?, note = ?, max_mb = ?, play_mode = ?, cycle_sec = ?, play_kinds = ? WHERE id = ?',
          nextName, note, nextMb, nextPlay, nextSec, nextPK, old.id
        );
        if (needReqs && !reqSame) writeReqs(old.id, nextReqs);
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

/**
 * 按 extra 重写一道工序的 process_req（允许哪些类型、各要几份、图片最小尺寸）。
 *
 * 「允许类型」是**整份替换**语义：表里写了什么就是什么，没写到的类型等于取消允许。
 * 只给了「图片最小尺寸」没给类型时，只改 image 那一条的宽高，不动别的。
 * 结果是空表 = 不限类型（老库和界面都按这个口径，见 process_req 建表注释）。
 */
function planReqs(cur, extra) {
  const byKind = new Map(cur.map((r) => [r.kind, r]));

  let list;
  if (extra.kinds !== undefined) {
    list = extra.kinds.map((k) => {
      const had = byKind.get(k.kind);
      return {
        kind: k.kind,
        minCount: Math.max(0, Number(k.minCount) || 0),
        w: had ? Number(had.min_width) || 0 : 0,
        h: had ? Number(had.min_height) || 0 : 0
      };
    });
  } else {
    list = cur.map((r) => ({
      kind: r.kind,
      minCount: Number(r.min_count) || 0,
      w: Number(r.min_width) || 0,
      h: Number(r.min_height) || 0
    }));
  }

  if (extra.minSize !== undefined) {
    const img = list.find((x) => x.kind === 'image');
    // 没允许图片时尺寸没有意义，忽略而不是偷偷把图片类型加回来
    if (img) { img.w = Math.max(0, extra.minSize.w || 0); img.h = Math.max(0, extra.minSize.h || 0); }
  }
  return list;
}

const reqKey = (list) => list
  .map((r) => `${r.kind}:${r.minCount}:${r.w}:${r.h}`).sort().join('|');

/** 表里写的和库里一模一样 → 不必写库（全量导出每行都带「允许类型」，否则每次导都全量更新一遍） */
function sameReqs(cur, next) {
  return reqKey(cur.map((r) => ({
    kind: r.kind, minCount: Number(r.min_count) || 0,
    w: Number(r.min_width) || 0, h: Number(r.min_height) || 0
  }))) === reqKey(next);
}

function writeReqs(processId, list) {
  q.run('DELETE FROM process_req WHERE process_id = ?', processId);
  for (const r of list) {
    q.run(
      'INSERT INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
      uid('sr'), processId, r.kind, r.minCount, r.w, r.h
    );
  }
}

/** 新建工序时用：没有 reqs 列就直接按默认（允许图片≥1、1280×720）建 */
function applyReqs(processId, extra) {
  const cur = q.all('SELECT * FROM process_req WHERE process_id = ?', processId);
  writeReqs(processId, planReqs(cur, extra));
}

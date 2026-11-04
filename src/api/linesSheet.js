// 线体设置的全量 Excel 导入 / 导出。
//
// 与工序那条链（api/import.js + api/export.js）同构：导出一份表 → 在 Excel 里改
// → 整份导回，先解析预览、确认了才写库。两步而不是"选中文件即入库"，理由和工序一样：
// 线体表是现场自己拼的，列一错位（把工位数填进名称列）一导就得一条条改回来。
//
// 导出的是一份**五页签的全量快照**（4.3.0 起）。以前的导出只有四列
// （名称/编码/工位数/状态），拿着它换一套系统重配，工时、节拍、工序参数
// 一样都还原不出来。现在的五页：
//
//   1 线体清单     四列，**可整份导回**（和以前完全一样，老脚本照用）
//   2 线体配置     只读快照：启用/排序/可生产机种数/当前机种/排产下一机种
//   3 线体工时设定 一条线 × 一个机种一行：标准产能、节拍、工序数、工时合计、
//                  瓶颈工位、线平衡率、理论班产 —— 工时设定的主表
//   4 工序参数     一道工序一行（全厂 1.6 万行）：播放方式、单文件上限、
//                  允许类型、图片最小尺寸、播放项数、工序工时、工时占比，**可导回**
//   5 字段说明     每个列名对应哪个数据库字段、能不能导回、导回时怎么解析
//
// 为什么第 1 页还是只有四列、没把新参数塞进去：这一页是**唯一被导入写库**的一页，
// 往里加列就得让导入去理解「启用」「排序」这些运行态，一条写错就把线停掉。
// 要看的参数放第 2、3 页，只读；要改的去界面改。
//
// 为什么「状态」只导出、不导入：它是**现场实时状态**（运行 / 停线 / 维修 / 保养），
// 不是配置。拿一份上周导出的表导回来，不该把昨天刚点的「运行」冲回「停线」。
// 认这一列只是为了它在表里不把别的列顶乱，读到了也不写库。
//
// 编码是终端 config.json 里填的寻址标识，所以改编码是**危险动作**：
// 预览里会明写「现场终端要跟着改」，不让人以为是改个显示名。
import { q, tx, lines } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { parseSheets, buildWorkbook } from '../xlsx.js';
import { sendXlsx, stamp } from './export.js';
import { now, str, int, uid } from '../util.js';

const TITLE = ['线体名称', '编码', '工位数', '状态'];
const WIDTHS = [26, 14, 10, 10];

/** 线体状态 → 表格里的中文。导入时不读，只用于导出。 */
const ST_TEXT = { running: '运行', stopped: '停线', maintain: '维修', care: '保养' };

/** 播放方式的中文。和界面上那个下拉的文案一字不差，导出再导回才对得上 */
const PLAY_TEXT = { loop: '循环播放', once: '播一遍停' };
const KIND_CN = { image: '图片', video: '视频', pdf: 'PDF' };
const KINDS = ['image', 'video', 'pdf'];

/**
 * 播放内容（`process.play_kinds`）→ 表格里的中文。
 * 空串 = 三类全放（默认），写「全部」；只放两类就写「图片；视频」。
 * 分隔符用全角分号，和「允许类型」那一栏一个风格；导回时两种分号都认。
 */
const PLAY_KINDS = ['image', 'pdf', 'video'];
function playKindsText(text) {
  const set = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hit = PLAY_KINDS.filter((k) => set.includes(k));
  if (!hit.length || hit.length === PLAY_KINDS.length) return '全部';
  return hit.map((k) => KIND_CN[k]).join('；');
}

/** 终端/接口要求的编码形状，和 POST /api/lines 里的正则保持一致 */
const CODE_RE = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * 表头别名。键归一化后匹配（去空格、去括号备注、去标点、转小写）。
 *
 * 刻意**不收**「序号」「行号」：那是 Excel 自己的行号，收进来当编码就是灾难。
 * 也不收裸的 "line" —— 它在英文表里指"线体名称"还是"线体编码"说不清，
 * 与其猜错，不如让它落到"认不出表头"按位置读，至少读法可预期。
 */
const ALIAS = {
  name: ['线体名称', '线体', '产线', '产线名称', '生产线', '生产线名称', '名称', 'linename', 'name'],
  code: ['编码', '代码', '编号', '线体编码', '线体代码', 'linecode', 'code'],
  slots: ['工位数', '工位数量', '工位', '屏数', '屏幕数', '块数', 'slots'],
  status: ['状态', '线体状态', 'status']   // 认出来，但不写库
};

const FIELDS = ['name', 'code', 'slots', 'status'];

function normHeader(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')   // 「工位数（几块屏）」→「工位数」
    .replace(/[：:、,，;；*＊]/g, '');
}

const FIELD_OF = new Map();
for (const f of FIELDS) for (const a of ALIAS[f]) FIELD_OF.set(normHeader(a), f);

/** 表头行识别：前 5 行里挑「能认出最多字段」的那行，且必须认出名称或编码之一 */
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
    if (map.name === undefined && map.code === undefined) continue;
    if (!best || n > best.n) best = { index: i, map, n };
  }
  // 只认出一个字段（比如整表第一格恰好叫「名称」）容易误判成标题行，要求至少两个
  return best && best.n >= 2 ? best : null;
}

// 上限 64 MB：同一个文件里可能带着「线体清单」+「工序参数」等五页（约 10~12 MB），
// 线体设置这边只读第 1 页，但请求体是整个文件。超限的处理同 import.js：
// 读完再回 400，不 destroy —— 否则前端只能看到"连接被重置"。
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

const cellAt = (row, i) => (i === undefined || i === null ? '' : str(row && row[i], 200).trim());

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** 导出行：按排序取，和界面上的表格同序。工位数给数字，Excel 里能直接排序求和 */
function collect() {
  return lines().map((l) => [l.name, l.code, Number(l.slots || 0), ST_TEXT[l.status] || l.status || '停线']);
}

/**
 * 一次把所有要在表里露面的数据拉齐，再用它拼五页。
 *
 * 刻意不按线逐条查：11 条线 × 1107 机种 × 15 道工序 = 十几万次查询，
 * 导出要转十几秒（`GET /api/models` 在 4.2.0 踩过一模一样的坑，12.7 秒 → 124 ms）。
 * 四张大表各查一次、在内存里 join 完，全量导出稳定在几百毫秒。
 */
function snapshot() {
  const ls = lines();
  const models = q.all('SELECT * FROM model ORDER BY sort, code');
  const modelOf = new Map(models.map((m) => [m.id, m]));

  // 工序：按机种分组，顺带把工时合计与瓶颈算出来（第 3、4 页都要用）
  const procs = q.all('SELECT * FROM process ORDER BY model_id, sort, code');
  const reqsOf = new Map();
  for (const r of q.all('SELECT * FROM process_req ORDER BY kind')) {
    if (!reqsOf.has(r.process_id)) reqsOf.set(r.process_id, []);
    reqsOf.get(r.process_id).push(r);
  }
  const itemsOf = new Map(
    q.all('SELECT process_id, COUNT(*) n FROM item GROUP BY process_id')
      .map((r) => [r.process_id, Number(r.n) || 0])
  );

  const byModel = new Map();
  for (const p of procs) {
    if (!byModel.has(p.model_id)) byModel.set(p.model_id, []);
    byModel.get(p.model_id).push(p);
  }

  /** 某个机种的工时画像：合计 / 瓶颈 / 填了几道 / 平衡率 */
  const times = new Map();
  for (const [mid, list] of byModel) {
    const secs = list.map((p) => Number(p.cycle_sec) || 0).filter((n) => n > 0);
    const sum = secs.reduce((a, b) => a + b, 0);
    const max = secs.length ? Math.max(...secs) : 0;
    times.set(mid, {
      sum,
      max,
      filled: secs.length,
      total: list.length,
      // 线平衡率 = 各工位工时之和 ÷（工位数 × 瓶颈工时）。
      // **只统计填了工时的工序** —— 没填的那些当 0 会把平衡率压得莫名其妙，
      // 那不是线不平衡，是数据没录。分母里也不含它们（用 filled 而不是 total）。
      balance: secs.length && max > 0 ? round1((sum / (secs.length * max)) * 100) : null
    });
  }

  // 线体 × 机种 的关系（可生产机种），按线分组
  const linesOfModel = new Map();
  for (const r of q.all('SELECT * FROM model_line')) {
    if (!linesOfModel.has(r.model_id)) linesOfModel.set(r.model_id, []);
    linesOfModel.get(r.model_id).push(r.line_id);
  }

  const state = new Map(q.all('SELECT * FROM line_state').map((r) => [r.line_id, r]));

  return { ls, models, modelOf, byModel, reqsOf, itemsOf, times, linesOfModel, state };
}

/** 第 2 页：线体配置（只读快照）。运行态和排序放这儿，第 1 页不放 —— 见文件头 */
function sheetLineConfig(snap) {
  const head = ['线体名称', '编码', '工位数', '状态', '启用', '排序',
    '可生产机种数', '当前机种', '排产下一机种', '切换中'];
  const codeOf = (id) => (id && snap.modelOf.has(id) ? snap.modelOf.get(id).code : '');
  const rows = snap.ls.map((l) => {
    const st = snap.state.get(l.id) || {};
    const n = snap.models.filter((m) => (snap.linesOfModel.get(m.id) || []).includes(l.id)).length;
    return [
      l.name, l.code, Number(l.slots || 0), ST_TEXT[l.status] || l.status || '停线',
      l.enabled ? '是' : '否', Number(l.sort || 0), n,
      codeOf(st.current_model_id), codeOf(st.next_model_id), codeOf(st.pending_model_id)
    ];
  });
  return { name: '线体配置', widths: [26, 12, 8, 8, 8, 8, 13, 12, 14, 10], rows: [head, ...rows] };
}

/**
 * 第 3 页：线体工时设定。一条线 × 一个挂在这条线上的机种 = 一行。
 *
 * 节拍 = 3600 ÷ 标准产能（秒/件）。标准产能是机种的属性（model.std_rate），
 * 节拍是它换算出来的 —— 表里两个都列，是为了让人不用自己按计算器，
 * 但**改的时候改标准产能**（界面上那一格），节拍会自动跟着变。
 */
function sheetLineRate(snap) {
  const head = ['线体名称', '编码', '机种编号', '产品名称', '标准产能(件/时)', '节拍(秒/件)',
    '工序数', '已填工时工序数', '工时合计(秒)', '瓶颈工位(秒)', '线平衡率(%)',
    '理论班产(件/8时)', '产线工位数'];
  const rows = [];
  for (const l of snap.ls) {
    for (const m of snap.models) {
      if (!(snap.linesOfModel.get(m.id) || []).includes(l.id)) continue;
      const t = snap.times.get(m.id) || { sum: 0, max: 0, filled: 0, total: 0, balance: null };
      const rate = Number(m.std_rate) || 0;
      rows.push([
        l.name, l.code, m.code, m.name,
        rate || '',
        rate > 0 ? round1(3600 / rate) : '',
        t.total, t.filled,
        t.sum ? round1(t.sum) : '',
        t.max ? round1(t.max) : '',
        t.balance == null ? '' : t.balance,
        rate > 0 ? Math.round(rate * 8) : '',
        Number(l.slots || 0)
      ]);
    }
  }
  return {
    name: '线体工时设定',
    widths: [20, 10, 14, 24, 15, 13, 9, 15, 13, 13, 12, 15, 11],
    rows: [head, ...rows]
  };
}

/** 允许类型写成「图片≥1；PDF≥1」—— 一列看完，比拆成六列好读，导回时也认得 */
function reqText(reqs) {
  if (!reqs || !reqs.length) return '不限';
  return KINDS
    .map((k) => reqs.find((r) => r.kind === k))
    .filter(Boolean)
    .map((r) => `${KIND_CN[r.kind] || r.kind}≥${Number(r.min_count) || 0}`)
    .join('；');
}

function sizeText(reqs) {
  const img = (reqs || []).find((r) => r.kind === 'image');
  if (!img) return '';
  const w = Number(img.min_width) || 0;
  const h = Number(img.min_height) || 0;
  if (!w && !h) return '';
  return w && h ? `${w}×${h}` : (w ? `宽≥${w}` : `高≥${h}`);
}

/**
 * 第 4 页：工序参数（可导回）。一道工序一行，全厂 1.6 万行。
 *
 * 这是"程序真正读的那张表"：终端拿到一道工序，读的就是
 * 播放方式、允许的类型与张数、图片最小尺寸、单文件上限、内容清单。
 * 工时占比用来一眼看出瓶颈在哪道工序（占比最高的那道就是）。
 */
function sheetProcess(snap) {
  const head = ['机种编号', '产品名称', '工序码', '名称', '做什么', '播放方式', '播放内容',
    '单文件上限(MB)', '允许类型', '图片最小尺寸', '播放项数', '工序工时(秒/件)', '工时占比(%)'];
  const rows = [];
  for (const m of snap.models) {
    const list = snap.byModel.get(m.id) || [];
    const sum = (snap.times.get(m.id) || {}).sum || 0;
    for (const p of list) {
      const reqs = snap.reqsOf.get(p.id) || [];
      const sec = Number(p.cycle_sec) || 0;
      rows.push([
        m.code, m.name, p.code, p.name || '',
        p.note || '',
        PLAY_TEXT[p.play_mode] || PLAY_TEXT.loop,
        playKindsText(p.play_kinds),
        Number(p.max_mb) || 0,
        reqText(reqs),
        sizeText(reqs),
        snap.itemsOf.get(p.id) || 0,
        sec ? round1(sec) : '',
        sec && sum ? round1((sec / sum) * 100) : ''
      ]);
    }
  }
  return {
    name: '工序参数',
    widths: [14, 24, 10, 18, 46, 11, 14, 14, 22, 13, 9, 15, 11],
    rows: [head, ...rows]
  };
}

/**
 * 第 5 页：字段说明。列名 ↔ 数据库字段 ↔ 能不能导回。
 *
 * 这张表是给"以后要拿它重建一套系统"的人看的：看到「瓶颈工位(秒)」得能立刻
 * 知道它是 process.cycle_sec 里最大的那个，而不是某个叫 bottleneck 的字段。
 */
function sheetFieldDoc() {
  const head = ['页签', '列名', '数据库字段', '含义 / 算法', '可导回'];
  const R = [
    ['线体清单', '线体名称', 'line.name', '现场叫法，全厂唯一。改名不影响终端（终端认编码）', '是'],
    ['线体清单', '编码', 'line.code', '终端 config.json 里的寻址标识，字母数字点下划线横线，1~16 位', '是（改了终端要跟着改）'],
    ['线体清单', '工位数', 'line.slots', '这条线有几块屏，1~200。只做展示参考，不卡校验', '是'],
    ['线体清单', '状态', 'line.status', '运行/停线/维修/保养（running/stopped/maintain/care）', '否（实时状态，导回会被冲掉）'],

    ['线体配置', '启用', 'line.enabled', '由状态派生：running ⇒ 1。老代码和终端还在读它', '否'],
    ['线体配置', '排序', 'line.sort', '左侧导航与线体列表的顺序，步长 10', '否'],
    ['线体配置', '可生产机种数', 'model_line', '这个机种挂了这条线。数量 = COUNT(model_line)', '否'],
    ['线体配置', '当前机种', 'line_state.current_model_id', '这条线现在在做什么（存机种 id，表里给编码）', '否'],
    ['线体配置', '排产下一机种', 'line_state.next_model_id', '换型排到下一个做谁，可为空', '否'],
    ['线体配置', '切换中', 'line_state.pending_model_id', '正在切、切完清空。有值表示还在换型等举手', '否'],

    ['线体工时设定', '标准产能(件/时)', 'model.std_rate', '机种属性，在「机种设置 → 改编号/名称/产能」里填', '否（在第 1 页之外，改去界面）'],
    ['线体工时设定', '节拍(秒/件)', '换算值', '3600 ÷ 标准产能。只在导出时算，库里不存', '否'],
    ['线体工时设定', '工序数', 'COUNT(process)', '这个机种有几道工序', '否'],
    ['线体工时设定', '已填工时工序数', 'COUNT(process.cycle_sec>0)', '工时填了 0 或有值的那几道', '否'],
    ['线体工时设定', '工时合计(秒)', 'SUM(process.cycle_sec)', '各工位工时相加，一道工序 = 一个工位', '否'],
    ['线体工时设定', '瓶颈工位(秒)', 'MAX(process.cycle_sec)', '最长的那道工序，线卡在它身上', '否'],
    ['线体工时设定', '线平衡率(%)', '换算值', '工时合计 ÷（已填工时工序数 × 瓶颈工时）×100。只统计填了工时的工序', '否'],
    ['线体工时设定', '理论班产(件/8时)', '换算值', '标准产能 × 8。8 小时是这里写死的口径，不是现场班次', '否'],
    ['线体工时设定', '产线工位数', 'line.slots', '同第 1 页，放在这儿是为了和瓶颈工时对着看够不够屏', '否'],

    ['工序参数', '机种编号', 'model.code', '产品型号的编号（X200）。导入时填名称也认', '是'],
    ['工序参数', '产品名称', 'model.name', '只做展示；导入不写它（改名去机种设置）', '否'],
    ['工序参数', '工序码', 'process.code', '终端上的 op 参数，同一个机种内唯一', '是'],
    ['工序参数', '名称', 'process.name', '工序名称，留空用工序码顶上', '是'],
    ['工序参数', '做什么', 'process.note', '作业要点，显示在终端顶栏', '是'],
    ['工序参数', '播放方式', 'process.play_mode', '循环播放(loop) / 播一遍停(once)', '是'],
    ['工序参数', '播放内容', 'process.play_kinds', '终端只放这几类：图片 / PDF / 视频。写「全部」= 不限；空 = 全放', '是'],
    ['工序参数', '单文件上限(MB)', 'process.max_mb', '0 = 不限', '是'],
    ['工序参数', '允许类型', 'process_req(kind,min_count)', '写成「图片≥1；PDF≥1」。空表 = 不限类型', '是'],
    ['工序参数', '图片最小尺寸', 'process_req(min_width,min_height)', '写成「1280×720」，空 = 不限制分辨率', '是'],
    ['工序参数', '播放项数', 'COUNT(item)', '这道工序当前配了几条内容。只读，导入不动内容', '否'],
    ['工序参数', '工序工时(秒/件)', 'process.cycle_sec', '这一工位做一件要几秒。0 或空 = 还没测', '是'],
    ['工序参数', '工时占比(%)', '换算值', '本工序工时 ÷ 该机种工时合计 ×100', '否'],

    ['', '', '', '', ''],
    ['说明', '生产台账不在这张表里', 'prod_input', '计划开机/计划产量/实际每小时/累计/停机是按天录的运行数据，不是配置，天天在变，导出成快照没意义', '—'],
    ['说明', '媒体文件不在这张表里', 'media / item', '表里只给"配了几项"，文件本身在 data\\media\\ 下，拷过去就带走了', '—'],
    ['说明', '标准产能与工序工时是两个口径', 'model.std_rate / process.cycle_sec', '生产概况的「效率」按标准产能算；工序工时用来算瓶颈和线平衡。两者并列，不互相推导', '—'],
    ['说明', '本表由「线体设置 → 导出 Excel」生成', '', '第 1 页可整份导回；第 4 页也能导回（先删掉不要的页签或行）', '—']
  ];
  return { name: '字段说明', widths: [14, 20, 30, 62, 22], freeze: false, rows: [head, ...R] };
}

/** 导出的全部五页。顺序固定：第 1 页必须还是「线体清单」，导入只认它 */
function fullSheets() {
  const snap = snapshot();
  return [
    { name: '线体清单', widths: WIDTHS, rows: [TITLE, ...collect()] },
    sheetLineConfig(snap),
    sheetLineRate(snap),
    sheetProcess(snap),
    sheetFieldDoc()
  ];
}

function templateSheets() {
  return [
    {
      name: '线体清单',
      widths: WIDTHS,
      rows: [
        TITLE,
        ['一线', 'L1', 5, '运行'],
        ['二线', 'L2', 8, '停线']
      ]
    },
    {
      name: '填写说明',
      widths: [104],
      freeze: false,
      rows: [
        ['线体清单导入模板 · 填写说明'],
        [''],
        ['1. 只读「线体清单」这一页。这一页是说明，不会被导入。'],
        ['2. 第一行是标题行，从第二行开始，一条线体填一行。'],
        ['3. 四列：线体名称 / 编码 / 工位数 / 状态。'],
        ['   · 线体名称必填，全厂不能重名（例如「一线」「总装二线」）。'],
        ['   · 编码是终端 config.json 里填的寻址标识，只能用字母、数字、点、下划线、横线，'],
        ['     最长 16 个字符，例如 L1、L2、WM、XB。留空会按 L1、L2… 自动补一个没被占用的。'],
        ['   · 工位数 = 这条线有几块屏，只做展示参考，填 1~200，留空按 5 算。'],
        ['   · 状态填「运行 / 停线 / 维修 / 保养」—— 这一列**导出供查看，导入不生效**，'],
        ['     导入不会改任何一条线的状态。新导入的线一律是「停线」，需要时在界面上点「运行」。'],
        ['4. 认列认的是**表头名**，不是列号。在前面插一列「序号」、或把列换个顺序，都不影响导入。'],
        ['   但表头名别改，认不出会退回按前三列位置读（名称 / 编码 / 工位数）。'],
        ['5. 第五列以后随便加自己的列（序号、责任人、备注），导入不读。'],
        ['6. 已存在的线体按**编码**认，编码空着就按名称认。三种处理方式：'],
        ['   只加新的（跳过已有）/ 加新的+更新已有 / 只更新不新建。'],
        ['7. 改编码要想清楚：现场那台终端的 config.json 里填的就是旧编码，'],
        ['   改了编码，终端会连不上，得在同一台机器上把配置一起改。'],
        ['8. 「可生产机种」不在这张表里：一个机种能在哪几条线上做，去「机种设置」里勾。'],
        ['9. 老版 .xls 请先在 Excel 里「另存为」.xlsx 或 .csv，导入不了 .xls。'],
        ['10. 示例那两行（一线 / 二线）导入前请删掉，不然会真的建出这两条线。'],
        ['11. 导入路径：线体设置 → 右上角「导入 Excel」。'],
        ['    会先弹预览：读到几行、哪些新增、哪些有变化、哪些不合要求，确认了才写库。']
      ]
    }
  ];
}

// ============================================================
// 「线体工时设定」页：标准产能导回
// ============================================================
//
// 这一页是 一条线 × 一个机种 一行，但**标准产能是机种的属性**（model.std_rate），
// 不是线的属性。所以同一个机种在多条线上出现多行时，写的都是同一个字段 ——
// 几行填得不一样就是表自己写错了，宁可报错也不猜哪行对。
//
// 只认「机种编号」和「标准产能」两列，其余（节拍、工时合计、瓶颈、平衡率）
// 都是导出时算出来的，导回来没有意义，也不该由人改。

const STD_NAME = '线体工时设定';

const STD_ALIAS = {
  code: ['机种编号', '机种编码', '机种', '型号', '产品编号'],
  name: ['产品名称', '机种名称', '名称'],
  rate: ['标准产能', '标准产能件时', '产能', '标准节拍产量', 'stdrate']
};

function stdFieldOf(head) {
  const map = {};
  for (const [f, list] of Object.entries(STD_ALIAS)) {
    for (let i = 0; i < head.length; i += 1) {
      if (list.includes(normHeader(head[i]))) { map[f] = i; break; }
    }
  }
  return map;
}

/**
 * 解析「线体工时设定」页。回 { rows, counts }：
 *   same  = 和库里一样
 *   diff  = 要改
 *   bad   = 机种没建档 / 数字不合法 / 同一机种填了两个值
 * 空行（两列都没填）直接忽略。
 */
function parseStdRate(rows) {
  if (!rows.length) return { rows: [], counts: { same: 0, diff: 0, bad: 0 } };
  const map = stdFieldOf(rows[0]);
  if (map.code === undefined || map.rate === undefined) {
    return {
      rows: [],
      counts: { same: 0, diff: 0, bad: 0 },
      error: `「${STD_NAME}」页没认出「机种编号」或「标准产能」列，这一页跳过`
    };
  }

  const models = q.all('SELECT * FROM model');
  const byCode = new Map();
  const byName = new Map();
  for (const m of models) {
    const c = String(m.code || '').toLowerCase();
    const n = String(m.name || '').toLowerCase();
    if (c) byCode.set(c, byCode.has(c) ? null : m);
    if (n) byName.set(n, byName.has(n) ? null : m);
  }

  const out = [];
  const firstSeen = new Map();   // 机种 → {row, rate}

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const code = cellAt(r, map.code);
    const rateRaw = cellAt(r, map.rate);
    const nameRaw = cellAt(r, map.name);
    if (!code && !rateRaw) return;

    const rec = { row: rowNo, code, name: nameRaw, rate: null, status: 'same', reason: '', detail: '' };

    if (!code) { rec.status = 'bad'; rec.reason = '没有填机种编号'; out.push(rec); return; }
    const m = byCode.get(code.toLowerCase()) || byName.get(code.toLowerCase());
    if (!m) { rec.status = 'bad'; rec.reason = `机种「${code}」还没建档`; out.push(rec); return; }
    rec.code = m.code;   // 统一成真编码，界面上就不必猜填的是编码还是名称

    // 标准产能留空 = 这条不改（不把 0 写进去）
    if (rateRaw === '') { rec.detail = '标准产能留空，保持不变'; out.push(rec); return; }
    const v = Number(String(rateRaw).replace(/[，,]/g, '.'));
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      rec.status = 'bad';
      rec.reason = '标准产能要填一个数（件/小时），留空表示不改';
      out.push(rec);
      return;
    }

    const prev = firstSeen.get(m.id);
    if (prev && prev.rate !== v) {
      rec.status = 'bad';
      rec.reason = `同一个机种在第 ${prev.row} 行填的是 ${prev.rate}，这里又是 ${v} —— 标准产能是机种属性，只能有一个值`;
      out.push(rec);
      return;
    }
    firstSeen.set(m.id, { row: prev ? prev.row : rowNo, rate: v });

    rec.modelId = m.id;
    rec.modelCode = m.code;
    rec.oldRate = Number(m.std_rate) || 0;
    rec.rate = Math.round(v * 100) / 100;
    if (rec.oldRate === rec.rate) {
      rec.status = 'same';
    } else {
      rec.status = 'diff';
      rec.detail = `标准产能 ${rec.oldRate || '未设'} → ${rec.rate} 件/时`;
    }
    out.push(rec);
  });

  const counts = { same: 0, diff: 0, bad: 0 };
  for (const r of out) counts[r.status] += 1;
  return { rows: out, counts };
}

export function register(router) {
  // ---------- 导出 ----------
  //
  // 全量五页。以前只导四列，拿着它没法重建一套系统；现在工时、节拍、
  // 工序参数都在里面（见文件头）。
  // 走 `?sheet=line` 还能只导第 1 页 —— 现场只要一张能改能导回的线体表时用，
  // 文件小、打开快，也让「导入」这条链有个最小可用的输入。
  router.get('/api/export/lines.xlsx', (req, res, ctx) => {
    const all = fullSheets();
    if (all[0].rows.length <= 1) throw badRequest('还没有线体，先建一条再来导出');
    const only = String((ctx && ctx.query && ctx.query.sheet) || '').trim();
    const sheets = only === 'line' ? [all[0]] : all;
    const suffix = only === 'line' ? '线体清单' : `线体全量参数-${sheets[3].rows.length - 1}道工序`;
    sendXlsx(res, buildWorkbook(sheets), `${suffix}-${stamp()}.xlsx`);
  });

  // 导入模板：和导出的表逐列同构，多两行示例 + 一页说明
  router.get('/api/export/lines-template.xlsx', (req, res) => {
    sendXlsx(res, buildWorkbook(templateSheets()), '线体清单导入模板.xlsx');
  });

  // ---------- 导入第一步：只解析、只判定，不落库 ----------
  router.post('/api/import/lines/parse', async (req, res, ctx) => {
    let filename = 'lines.xlsx';
    try { filename = decodeURIComponent(String(ctx.query.filename || filename)); } catch { /* 明文就用原样 */ }

    const buf = await readBuf(req);
    if (!buf.length) throw badRequest('文件是空的');

    let all;
    let sheets = [];
    try {
      sheets = parseSheets(buf);
      // 认页名，不认第几页：用户可能在 Excel 里调整过页签顺序。
      // 找不到「线体清单」就退回第一页（老的四列单页文件、CSV 都走这条）。
      const named = sheets.find((x) => x.name === '线体清单' && x.rows.length);
      all = (named || sheets.find((x) => x.rows.length) || sheets[0]).rows;
    } catch (e) {
      throw badRequest(e.message || '读不出这个文件，请确认是 .xlsx 或 .csv');
    }
    if (!all.length) throw badRequest('这张表里没有读到任何内容');

    // 同一个文件里如果还带着「线体工时设定」页，顺带把标准产能也解析出来一起导。
    // 这一页不进线体表那套判定（它是机种属性），单独回一段。
    let std = null;
    const stdSheet = sheets.find((x) => x.name === STD_NAME && x.rows.length);
    if (stdSheet) std = parseStdRate(stdSheet.rows);

    const head = findHeader(all);
    // 认不出表头就按位置读：0 名称 / 1 编码 / 2 工位数
    const map = head ? head.map : { name: 0, code: 1, slots: 2 };
    const body = head ? all.slice(head.index + 1) : all;
    if (!body.length) throw badRequest('只有标题行，没有线体数据');

    // 全库索引：编码和名称都是唯一键，两个都要能认
    const exist = lines();
    const byCode = new Map(exist.map((l) => [String(l.code).toLowerCase(), l]));
    const byName = new Map(exist.map((l) => [String(l.name).toLowerCase(), l]));

    const seenKey = new Map();   // 身份键 → 首次出现的行号（行内查重）
    const out = [];

    body.forEach((r, i) => {
      const rowNo = (head ? head.index + 1 : 0) + i + 1;  // 回到 Excel 里的真实行号
      const name = cellAt(r, map.name);
      const code = cellAt(r, map.code);
      const rawSlots = cellAt(r, map.slots);
      const slots = rawSlots === '' ? 5 : int(rawSlots, 0);

      const rec = {
        row: rowNo,
        name,
        code: code || '',
        slots: slots || 0,
        status: 'new',
        reason: '',
        detail: ''
      };

      // 整行空白：表格末尾常有空行，不算"不合要求"
      if (!name && !code && rawSlots === '') return;

      if (!name) { rec.status = 'bad'; rec.reason = '没有填线体名称'; out.push(rec); return; }
      if (code && !CODE_RE.test(code)) {
        rec.status = 'bad';
        rec.reason = '编码只能用字母、数字、点、下划线、横线，最长 16 个字符';
        out.push(rec);
        return;
      }
      if (rawSlots !== '' && (!Number.isFinite(slots) || slots < 1 || slots > 200)) {
        rec.status = 'bad';
        rec.reason = '工位数要填 1~200 的整数（这条线有几块屏）';
        out.push(rec);
        return;
      }
      rec.slots = Math.min(200, Math.max(1, slots || 5));

      // 认已有：先按编码，再按名称。两边指向不同的线，就是表本身写错了。
      let old = code ? (byCode.get(code.toLowerCase()) || null) : null;
      if (!old && name) {
        const sameName = byName.get(name.toLowerCase()) || null;
        if (sameName) {
          const otherCode = code ? (byCode.get(code.toLowerCase()) || null) : null;
          if (!code || !otherCode) old = sameName;
          else if (otherCode.id === sameName.id) old = sameName;
          else {
            rec.status = 'bad';
            rec.reason = `名称「${name}」和编码 ${code}（属于「${otherCode.name}」）对不上，请只留一个当依据`;
            out.push(rec);
            return;
          }
        }
      }
      if (old && name && old.name.toLowerCase() !== name.toLowerCase() && byName.has(name.toLowerCase())) {
        const clash = byName.get(name.toLowerCase());
        if (clash.id !== old.id) {
          rec.status = 'bad';
          rec.reason = `名称「${name}」已经被「${clash.code}」占用`;
          out.push(rec);
          return;
        }
      }

      const key = old ? `id:${old.id}` : `new:${(code || name).toLowerCase()}`;
      if (seenKey.has(key)) {
        rec.status = 'bad';
        rec.reason = `与第 ${seenKey.get(key)} 行是同一条线体`;
        out.push(rec);
        return;
      }
      seenKey.set(key, rowNo);

      if (!old) {
        rec.status = 'new';
        if (!code) rec.detail = '编码留空，导入时自动补一个';
        out.push(rec);
        return;
      }

      rec.lineId = old.id;
      rec.oldName = old.name;
      rec.oldCode = old.code;
      rec.oldSlots = old.slots || 0;

      const bits = [];
      if (old.code !== code && code) bits.push(`编码 ${old.code} → ${code}（现场终端要跟着改）`);
      if ((old.name || '') !== name) bits.push(`名称 ${old.name} → ${name}`);
      if (Number(old.slots || 0) !== rec.slots) bits.push(`工位数 ${old.slots || 0} → ${rec.slots}`);

      if (!bits.length) {
        rec.status = 'same';
        rec.code = old.code;   // 表里编码留空但名称命中，回填真编码给界面看
      } else {
        rec.status = 'diff';
        rec.detail = bits.join('；');
        if (!code) rec.code = old.code;
      }
      out.push(rec);
    });

    if (!out.length) throw badRequest('这张表里没有读到任何线体行');

    const counts = { new: 0, same: 0, diff: 0, bad: 0 };
    for (const r of out) counts[r.status] += 1;

    sendJson(res, 200, {
      filename,
      std,
      header: head ? (all[head.index] || []) : null,
      headerRow: head ? head.index + 1 : 0,
      mapping: map,
      positional: !head,
      total: out.length,
      counts,
      // 状态列认出来了但不会生效，界面上要说清，否则会有人以为能批量改状态
      statusIgnored: map.status !== undefined,
      rows: out
    });
  });

  // ---------- 导入第二步：按确认过的行批量建 / 更新 ----------
  //
  // mode：
  //   merge        只加库里没有的，已存在的一律跳过（重复导同一份表不会动任何东西）
  //   update       加新的 + 覆盖已存在的名称与工位数
  //   update-only  只改已存在的，不建新线体
  router.post('/api/lines/import', async (req, res) => {
    const body = await readJsonBody(req);
    const mode = ['merge', 'update', 'update-only'].includes(body.mode) ? body.mode : 'merge';
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const stdRowsIn = Array.isArray(body.stdRows) ? body.stdRows : [];
    // 只导标准产能时线体那一段可以是空的（用户只改了第 3 页就点导入）
    if (!rows.length && !stdRowsIn.length) throw badRequest('没有可导入的行');

    const stat = { created: 0, updated: 0, kept: 0, skipped: 0, bad: [], lines: [] };
    let sort = q.get('SELECT COALESCE(MAX(sort),0) s FROM line').s;
    const ts = now();

    // 标准产能：和线体那张表分开处理 —— 它写的是 model，不是 line。
    // 同一个机种在前面已经查重过（几行填不一样直接判 bad），这里按机种去重再写。
    const stdRows = stdRowsIn;
    const std = { updated: 0, kept: 0, bad: [] };

    tx(() => {
      const done = new Set();
      for (const r of stdRows) {
        const rowNo = Number(r && r.row) || 0;
        const modelId = String((r && r.modelId) || '').trim();
        const rate = Number(r && r.rate);
        if (!modelId) { std.bad.push({ row: rowNo, reason: '缺少机种' }); continue; }
        if (!Number.isFinite(rate) || rate < 0) {
          std.bad.push({ row: rowNo, reason: '标准产能不是有效数字' });
          continue;
        }
        if (done.has(modelId)) { std.kept += 1; continue; }
        done.add(modelId);
        // 落库前再查一次：预览和确认之间可能有人在界面上改过
        const m = q.get('SELECT * FROM model WHERE id = ?', modelId);
        if (!m) { std.bad.push({ row: rowNo, reason: '机种已不存在' }); continue; }
        if (Number(m.std_rate || 0) === rate) { std.kept += 1; continue; }
        q.run('UPDATE model SET std_rate = ? WHERE id = ?', rate, modelId);
        std.updated += 1;
      }

      rows.forEach((r, i) => {
        const rowNo = Number(r && r.row) || i + 1;
        const name = str(r && r.name, 40).trim();
        let code = str(r && r.code, 16).trim();
        const slots = Math.min(200, Math.max(1, int(r && r.slots, 5)));

        if (!name) { stat.bad.push({ row: rowNo, name: '', code, reason: '没有填线体名称' }); return; }
        if (code && !CODE_RE.test(code)) {
          stat.bad.push({ row: rowNo, name, code, reason: '编码只能用字母、数字、点、下划线、横线，最长 16 个字符' });
          return;
        }

        // 库里按编码/名称重新找一遍：预览和落库之间可能有人动过界面，以库为准
        let old = code ? q.get('SELECT * FROM line WHERE code = ?', code) : null;
        if (!old) old = q.get('SELECT * FROM line WHERE name = ?', name);

        if (!old) {
          if (mode === 'update-only') { stat.skipped += 1; return; }
          if (!code) code = nextLineCode();
          if (q.get('SELECT id FROM line WHERE code = ?', code)) {
            stat.bad.push({ row: rowNo, name, code, reason: `编码 ${code} 已被占用` });
            return;
          }
          sort += 10;
          const id = uid('ln');
          q.run(
            'INSERT INTO line(id,code,name,enabled,status,slots,sort,created_at) VALUES(?,?,?,?,?,?,?,?)',
            id, code, name, 0, 'stopped', slots, sort, ts
          );
          stat.created += 1;
          stat.lines.push({ name, code, kind: 'created' });
          return;
        }

        if (mode === 'merge') { stat.skipped += 1; return; }

        // 改名撞了别的线：明确报错，不做"自动加后缀"这种自作主张
        const nameTaken = q.get('SELECT id FROM line WHERE name = ?', name);
        if (nameTaken && nameTaken.id !== old.id) {
          stat.bad.push({ row: rowNo, name, code: code || old.code, reason: `名称「${name}」已被「${old.code}」占用` });
          return;
        }
        if (code && code !== old.code) {
          const codeTaken = q.get('SELECT id FROM line WHERE code = ?', code);
          if (codeTaken && codeTaken.id !== old.id) {
            stat.bad.push({ row: rowNo, name, code, reason: `编码 ${code} 已被「${codeTaken.name}」占用` });
            return;
          }
        }

        const nextCode = code || old.code;
        const nextSlots = Math.min(200, Math.max(1, int(r && r.slots, old.slots || 5)));
        if (old.name === name && old.code === nextCode && Number(old.slots || 0) === nextSlots) {
          stat.kept += 1;
          return;
        }
        // 只改这三样：状态、enabled、sort 是运行态与顺序，导入不碰
        q.run('UPDATE line SET name = ?, code = ?, slots = ? WHERE id = ?', name, nextCode, nextSlots, old.id);
        stat.updated += 1;
        // from 只在编码真改了时才给 —— 否则界面上会冒出「原编码 L1」，看着像编码变了
        stat.lines.push({ name, code: nextCode, from: nextCode !== old.code ? old.code : '', kind: 'updated' });
      });
    });

    sendJson(res, 200, { ...stat, mode, std });
  });
}

/** 和 POST /api/lines 同一套取号规则：L1、L2…，跳过已占用的 */
function nextLineCode() {
  const used = new Set(q.all('SELECT code FROM line').map((r) => String(r.code).toLowerCase()));
  for (let i = 1; i < 999; i += 1) {
    if (!used.has(`l${i}`)) return `L${i}`;
  }
  return `L${Date.now()}`;
}

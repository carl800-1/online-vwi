// 生产台账：按「产线 × 日 × 段」记 → 汇总成作业内容页顶上那条「生产概况」
//
// 数据来源只有一个：左侧「生产输入」录的 prod_input。
// 系统没有产量采集通道 —— 终端只是块只读的屏，不接 MES / PLC，也不数件。
// 所以这里不做任何"推算"：有录入才算，没录就显示「未录入」，绝不编数。
//
// 口径（改之前先读完，这几个定义会被车间当成"数"引用）：
//   v4.2.1 起按**产线**记账，不再按机种（同一个机种在两条线上做，两条线各是一笔账）。
//   v4.2.2 起一条线一天可以录**多段**：小批量切换时上午 A 做 30 分钟、下午 B 做
//           30 分钟是常态，一线一行填不下。seq 只是"第几段"，不是时间点。
//   有效工时 = 计划开机工时 − 停机分钟/60（按段算）
//   理论产量 = 有效工时 × 标准产能
//   生产效率 = 累计产能 ÷ 理论产量；理论为 0 时给 null，界面显示「—」。
//              绝不在分母为 0 时兜底成 100% —— 那是最容易被当成"满分"汇报的假数。
//   当前每小时产能 = 各产线「最近一小时产量」之和，现场整点抄一次计数器。
//   累计产能 = 各段「累计产量」之和，含已经换走的机种（今天做的都算今天的）。
//
// **标准产能不存进台账**：它是机种属性，在「机种设置」里维护。
// 台账只记"这条线今天做了什么、做了多少"。改了节拍，效率当场跟着变 ——
// 存副本的话，改完机种设置不动台账，效率还是老数，现场只会怀疑系统在乱算。
//
// **「不开线」是整线级的**（is_open=0，只认 seq=1 那行）。线体状态挂着 running
// 但今天根本没排产（待料、设备空着）时，作业内容页的生产概况里不该出现这条线，
// 更不该顶一条"未录入"的红字 —— 那是噪音，不是异常。
import { q, lines, tx } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { now } from '../util.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 计划开机工时没录过时给的默认值（一个常白班）。填在输入框里，可改，不是暗算 */
const DEFAULT_SHIFT = 8;

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayMs(day) {
  return new Date(`${day}T00:00:00`).getTime();
}

/** 日期校验要走两步：正则只管形状（`2026-13-99` 也是四位两位两位），再让 Date 判存在性 */
function mustDay(day) {
  const s = String(day || '');
  if (!DAY_RE.test(s)) throw badRequest('日期格式应为 2026-11-02');
  const ms = dayMs(s);
  if (Number.isNaN(ms)) throw badRequest(`日期不存在：${s}`);
  return s;
}

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const ZERO_DERIVED = {
  shiftHours: 0, downMin: 0, effHours: 0, planQty: 0, doneQty: 0, hourQty: 0,
  theory: 0, rate: null, avgPerHour: null, gap: null
};

/** 一行台账 → 算出来的派生值。所有除法都在这儿，界面不再算 */
function derive(row) {
  const stdRate = Math.max(0, Math.round(num(row.std_rate)));

  // 不开线的线：所有数按 0 算。留着可能残留的老数会让合计凭空多出产量，
  // 而它明明今天没开。标准产能照给（界面上还要显示"标准 xxx 件/时"）。
  if (Number(row.is_open) === 0) return { stdRate, ...ZERO_DERIVED, note: '' };

  const shiftHours = Math.max(0, num(row.shift_hours));
  const downMin = Math.max(0, Math.round(num(row.down_min)));
  const effHours = Math.max(0, shiftHours - downMin / 60);
  const doneQty = Math.max(0, Math.round(num(row.done_qty)));
  const theory = Math.round(effHours * stdRate);
  return {
    stdRate,
    shiftHours: +shiftHours.toFixed(2),
    downMin,
    effHours: +effHours.toFixed(2),
    planQty: Math.max(0, Math.round(num(row.plan_qty))),
    doneQty,
    hourQty: Math.max(0, Math.round(num(row.hour_qty))),
    theory,
    // 理论产量为 0 一律 null：没设节拍、或没填工时、或整天停机，
    // 都不该显示成一个百分比
    rate: theory > 0 ? +(doneQty / theory).toFixed(4) : null,
    // 均速（件/小时）：累计 ÷ 有效工时，和「最近一小时」并列给人对照看
    avgPerHour: effHours > 0 ? Math.round(doneQty / effHours) : null,
    gap: theory > 0 ? theory - doneQty : null,
    note: row.note || ''
  };
}

/** 这条线上次开线那天的合计工时 —— 给空白日期当默认值，不是硬编码 8 */
function lastShiftHours(lineId, day) {
  const r = q.get(
    `SELECT SUM(shift_hours) h FROM prod_input
      WHERE line_id = ? AND day = (
        SELECT MAX(day) FROM prod_input
         WHERE line_id = ? AND day < ? AND is_open = 1 AND shift_hours > 0
      )`,
    lineId, lineId, day
  );
  const h = r ? Number(r.h) : 0;
  return h > 0 ? +h.toFixed(2) : DEFAULT_SHIFT;
}

/** 台账段（含线体与机种的展示字段），按 线序 → 段序 排 */
function dayRows(day) {
  return q.all(
    `SELECT i.*, l.code AS line_code, l.name AS line_name, l.sort AS line_sort,
            l.status AS line_status,
            m.code AS model_code, m.name AS model_name,
            COALESCE(m.std_rate, 0) AS std_rate
       FROM prod_input i
       LEFT JOIN line  l ON l.id = i.line_id
       LEFT JOIN model m ON m.id = i.model_id
      WHERE i.day = ?
      ORDER BY l.sort, l.code, i.seq`,
    day
  );
}

/** 线上现在挂着哪个机种（实时，来自 line_state，不是台账） */
function currentModelOf(lineId) {
  const st = q.get('SELECT current_model_id FROM line_state WHERE line_id = ?', lineId) || {};
  const mid = st.current_model_id || '';
  if (!mid) return { modelId: '', modelCode: '', modelName: '', stdRate: 0 };
  const m = q.get('SELECT code, name, std_rate FROM model WHERE id = ?', mid);
  return {
    modelId: mid,
    modelCode: m ? m.code : '',
    modelName: m ? m.name : '',
    stdRate: m ? Math.max(0, Math.round(num(m.std_rate))) : 0
  };
}

/** 段行 → 界面/接口用的形状 */
function segOut(r) {
  return {
    lineId: r.line_id,
    lineCode: r.line_code || '',
    lineName: r.line_name || '(已删除的线体)',
    lineStatus: r.line_status || '',
    seq: Number(r.seq) || 1,
    isOpen: Number(r.is_open) !== 0,
    modelId: r.model_id || '',
    modelCode: r.model_code || '',
    modelName: r.model_name || '',
    ...derive(r)
  };
}

/** 把段按线归拢：一条线一天可以有好几段，汇总与展示都从这儿出 */
function groupByLine(segs) {
  const groups = [];
  const map = new Map();
  for (const s of segs) {
    let g = map.get(s.lineId);
    if (!g) {
      map.set(s.lineId, (g = {
        lineId: s.lineId,
        lineCode: s.lineCode,
        lineName: s.lineName,
        lineStatus: s.lineStatus,
        // 整线级：ORDER BY 里 seq 升序，所以第一次遇到的就是 seq=1 那行
        isOpen: s.isOpen,
        segs: 0, planQty: 0, doneQty: 0, hourQty: 0, downMin: 0,
        effHours: 0, shiftHours: 0, theory: 0, rate: null
      }));
      groups.push(g);
    }
    g.segs += 1;
    g.planQty += s.planQty;
    g.doneQty += s.doneQty;
    g.hourQty += s.hourQty;
    g.downMin += s.downMin;
    g.effHours = +(g.effHours + s.effHours).toFixed(2);
    g.shiftHours = +(g.shiftHours + s.shiftHours).toFixed(2);
    g.theory += s.theory;
  }
  for (const g of groups) {
    g.rate = g.theory > 0 ? +(g.doneQty / g.theory).toFixed(4) : null;
  }
  return groups;
}

export function register(router) {
  // ---------- 当天汇总：作业内容页顶上的「生产概况」 ----------
  router.get('/api/prod/day', (req, res, ctx) => {
    const day = mustDay(ctx.query.day || dayKey(now()));
    const isToday = dayKey(now()) === day;

    // 当天所有录过的段 —— 不筛「现在还在跑」，
    // 因为换型前做的那部分、以及中午就停了的线，都算今天的产量
    const rows = dayRows(day).map(segOut);
    const byLine = groupByLine(rows);
    const segOf = new Map();   // lineId → 这条线的段
    for (const r of rows) {
      if (!segOf.has(r.lineId)) segOf.set(r.lineId, []);
      segOf.get(r.lineId).push(r);
    }

    // 「不开线」的线整条从生产概况里拿掉 —— 线体状态还挂着 running，
    // 但今天没排产，不该在这里顶一条"未录入"
    const closed = byLine.filter((g) => !g.isOpen).map((g) => ({
      lineId: g.lineId, lineCode: g.lineCode, lineName: g.lineName
    }));
    const closedIds = new Set(closed.map((c) => c.lineId));

    // 现在每条运行中的线在做哪个机种
    const running = lines()
      .filter((l) => l.status === 'running' && !closedIds.has(l.id))
      .map((l) => {
        const cm = currentModelOf(l.id);
        const g = byLine.find((x) => x.lineId === l.id);
        return {
          lineId: l.id,
          lineCode: l.code,
          lineName: l.name,
          ...cm,
          hasInput: !!g,
          // 这条线今天干了多少 —— 多段时给合计，省得为看一个数还要往下翻
          segs: g ? g.segs : 0,
          hourQty: g ? g.hourQty : null,
          doneQty: g ? g.doneQty : null,
          rate: g ? g.rate : null
        };
      });

    // 同一个机种可能今天在两条线上做、甚至同一条线做两段 —— 合计层面按机种看一次
    const mm = new Map();
    for (const r of rows) {
      if (!r.isOpen) continue;   // 不开线的线不参与"按产品"
      const k = r.modelId || r.modelCode || r.lineId;
      let g = mm.get(k);
      if (!g) {
        mm.set(k, (g = {
          modelId: r.modelId, code: r.modelCode || '(未选产品)', name: r.modelName,
          doneQty: 0, theory: 0, planQty: 0, hourQty: 0, downMin: 0, effHours: 0,
          segs: 0, lineIds: new Set()
        }));
      }
      g.doneQty += r.doneQty;
      g.theory += r.theory;
      g.planQty += r.planQty;
      g.hourQty += r.hourQty;
      g.downMin += r.downMin;
      g.effHours = +(g.effHours + r.effHours).toFixed(2);
      g.segs += 1;
      g.lineIds.add(r.lineId);
    }
    const byModel = [...mm.values()].map((g) => ({
      ...g,
      lineIds: undefined,
      lineCount: g.lineIds.size,
      rate: g.theory > 0 ? +(g.doneQty / g.theory).toFixed(4) : null
    }));

    const open = rows.filter((r) => r.isOpen);
    const sum = (list, k) => list.reduce((s, m) => s + (m[k] || 0), 0);
    const theoryAll = sum(open, 'theory');
    const doneAll = sum(open, 'doneQty');
    // 有产量、却算不出理论产量的行（产品没设标准产能 / 没填计划开机）。
    // 这种行一旦混进合计，分母会缺一块、效率虚高到 200% 都有可能 ——
    // 与其给个"看着挺漂亮"的假数，不如合计直接给 null，界面显示「—」并说明原因。
    const noTheory = open.filter((r) => r.doneQty > 0 && r.theory === 0).length;

    sendJson(res, 200, {
      day,
      isToday,
      rows,          // 逐段（界面按线分组用 byLine）
      byLine,        // 逐线汇总
      running,
      closed,        // 今天标了「不开线」的线
      byModel,
      totals: {
        doneQty: doneAll,
        hourQty: sum(open, 'hourQty'),
        planQty: sum(open, 'planQty'),
        theory: theoryAll,
        downMin: sum(open, 'downMin'),
        effHours: +sum(open, 'effHours').toFixed(2),
        shiftHours: +sum(open, 'shiftHours').toFixed(2),
        rate: theoryAll > 0 && noTheory === 0 ? +(doneAll / theoryAll).toFixed(4) : null,
        gap: theoryAll > 0 && noTheory === 0 ? theoryAll - doneAll : null,
        noTheory,
        segCount: open.length,
        // 录入的线数（不含「不开线」的）—— 生产概况「录入产线」用的是它
        inputLines: byLine.filter((g) => g.isOpen).length,
        closedLines: closed.length,
        // 运行中、但当天还没录台账的产线数 —— 模块里用来提示"该去录了"
        missing: running.filter((r) => !r.hasInput).length,
        lineCount: running.length,
        modelCount: byModel.length
      }
    });
  });

  // ---------- 生产输入：读这一天的整张表（登录页 + 运行中的线一起给） ----------
  //
  // 返回的 groups 是"这天要填的线"：已录的照着填，运行中但还没录的给一段空，
  // 产品先按 line_state 里当前的机种预填 —— 现场最常做的事就是
  // "今天这几条线在做什么，我照着填数"，不该让他一条条从头选。
  router.get('/api/prod/input', (req, res, ctx) => {
    const day = mustDay(ctx.query.day || dayKey(now()));
    const groups = groupByLine(dayRows(day).map(segOut));
    const gmap = new Map(groups.map((g) => [g.lineId, g]));

    // 段明细挂回 group
    for (const g of groups) g.segments = [];
    for (const s of dayRows(day).map(segOut)) {
      const g = gmap.get(s.lineId);
      if (g) g.segments.push({ saved: true, ...s });
    }

    // 运行中但还没录的线：补一段空，产品按当前机种预填
    for (const l of lines()) {
      if (l.status !== 'running' || gmap.has(l.id)) continue;
      const cm = currentModelOf(l.id);
      const seg = {
        saved: false,
        lineId: l.id, lineCode: l.code, lineName: l.name, lineStatus: l.status,
        seq: 1, isOpen: true,
        modelId: cm.modelId, modelCode: cm.modelCode, modelName: cm.modelName,
        ...derive({
          std_rate: cm.stdRate,
          shift_hours: lastShiftHours(l.id, day),
          plan_qty: 0, done_qty: 0, hour_qty: 0, down_min: 0
        })
      };
      const g = {
        lineId: l.id, lineCode: l.code, lineName: l.name, lineStatus: l.status,
        isOpen: true, segs: 0, planQty: 0, doneQty: 0, hourQty: 0, downMin: 0,
        effHours: 0, shiftHours: 0, theory: 0, rate: null, segments: [seg]
      };
      groups.push(g);
      gmap.set(l.id, g);
    }

    // 扁平 rows 留着：老前端/脚本是这么读的，一段一行，字段完全一样
    const rows = [];
    for (const g of groups) {
      for (const s of g.segments) {
        rows.push({
          lineId: g.lineId, lineCode: g.lineCode, lineName: g.lineName,
          lineStatus: g.lineStatus, isOpen: g.isOpen, ...s
        });
      }
    }

    sendJson(res, 200, {
      day,
      groups,
      rows,
      // 「+ 添加产线」用：还给没列进来的线（停线 / 维修中也可能要补录）
      lines: lines()
        .filter((l) => !gmap.has(l.id))
        .map((l) => ({ id: l.id, code: l.code, name: l.name, status: l.status })),
      // 产品下拉的选项。只给启用的 —— 停用机种还往下选，选完效率是"—"更费解
      models: q.all('SELECT id, code, name, std_rate FROM model WHERE enabled = 1 ORDER BY sort, code')
        .map((m) => ({
          id: m.id, code: m.code, name: m.name,
          stdRate: Math.max(0, Math.round(num(m.std_rate)))
        })),
      defaultShift: DEFAULT_SHIFT
    });
  });

  // ---------- 生产输入：整张表一起保存 ----------
  //
  // body: { day, rows: [{ lineId, seq, isOpen, modelId, shiftHours, planQty, doneQty, hourQty, downMin }] }
  // 一次提交整天的表：所见即所存，不用逐行点保存（现场不会记得哪行改过）。
  //
  // **按线先删后插**：段的增删改一次覆盖干净，不必逐段对主键 upsert。
  // 只删提交里出现过的线 —— 前端某次只发一条线时，不会把别的线的台账带走。
  // 段序由服务端按提交顺序重排成 1..n，前端的 seq 只当排序提示，不当主键。
  router.post('/api/prod/input', async (req, res, ctx) => {
    const body = (await readJsonBody(req)) || {};
    const day = mustDay(body.day || dayKey(now()));
    const list = Array.isArray(body.rows) ? body.rows : [];
    if (!list.length) throw badRequest('没有要保存的产线');

    // 先整批校验，再落库：不能写到一半发现某行机种不存在
    const byLineIn = new Map();
    for (const r of list) {
      const lineId = String(r.lineId || '');
      if (!lineId) throw badRequest('有一行没带 lineId');
      if (!q.get('SELECT id FROM line WHERE id = ?', lineId)) {
        throw badRequest(`线体不存在：${lineId}`);
      }
      const modelId = String(r.modelId || '');
      if (modelId && !q.get('SELECT id FROM model WHERE id = ?', modelId)) {
        throw badRequest(`机种不存在：${modelId}`);
      }

      let g = byLineIn.get(lineId);
      if (!g) byLineIn.set(lineId, (g = { lineId, isOpen: true, segs: [] }));
      // 整线级：任一行说"不开线"，这条线就是不开
      if (r.isOpen === false || Number(r.isOpen) === 0) g.isOpen = false;

      // 负数一律按 0 存：现场手滑多打一个减号不该让合计变成负的
      const v = {
        model_id: modelId,
        shift_hours: Math.max(0, Math.round(num(r.shiftHours) * 100) / 100),
        plan_qty: Math.max(0, Math.round(num(r.planQty))),
        done_qty: Math.max(0, Math.round(num(r.doneQty))),
        hour_qty: Math.max(0, Math.round(num(r.hourQty))),
        down_min: Math.max(0, Math.round(num(r.downMin))),
        note: String(r.note || '').slice(0, 200)
      };
      g.segs.push(v);
    }

    const ts = now();
    let savedLines = 0;
    let savedSegs = 0;

    tx(() => {
      for (const g of byLineIn.values()) {
        q.run('DELETE FROM prod_input WHERE line_id = ? AND day = ?', g.lineId, day);

        // 不开线：只留一条占位（产品空、全 0），别的段一律不要 ——
        // 线都停了还挂着三个型号的产量，下次开线会莫名其妙多出数
        if (!g.isOpen) {
          q.run(
            `INSERT INTO prod_input(line_id, day, seq, is_open, model_id, shift_hours,
               plan_qty, done_qty, hour_qty, down_min, note, ts)
             VALUES(?,?,1,0,'',0,0,0,0,0,'',?)`,
            g.lineId, day, ts
          );
          savedLines += 1;
          continue;
        }

        let seq = 0;
        for (const v of g.segs) {
          // 一段都没填（没选产品、四个数全 0）就跳过，别在库里留一堆空行
          const empty = !v.model_id && !v.plan_qty && !v.done_qty && !v.hour_qty && !v.down_min;
          if (empty) continue;
          seq += 1;
          q.run(
            `INSERT INTO prod_input(line_id, day, seq, is_open, model_id, shift_hours,
               plan_qty, done_qty, hour_qty, down_min, note, ts)
             VALUES(?,?,?,1,?,?,?,?,?,?,?,?)`,
            g.lineId, day, seq, v.model_id, v.shift_hours, v.plan_qty,
            v.done_qty, v.hour_qty, v.down_min, v.note, ts
          );
          savedSegs += 1;
        }
        // 整条线的段全空 → 这条线当天就当没录（上面已经删过了）
        if (seq > 0) savedLines += 1;
      }
    });

    sendJson(res, 200, { ok: true, day, saved: savedLines, segs: savedSegs });
  });

  // ---------- 生产输入：删掉某条线某天（或某一段）的台账 ----------
  router.del('/api/prod/input', (req, res, ctx) => {
    const lineId = String(ctx.query.lineId || '');
    const day = mustDay(ctx.query.day || dayKey(now()));
    if (!lineId) throw badRequest('缺少 lineId');
    // 带 seq 只删这一段；不带就整条线删掉（老调用方式不变）
    const seq = ctx.query.seq == null ? null : Number(ctx.query.seq);
    if (seq == null || !Number.isFinite(seq)) {
      q.run('DELETE FROM prod_input WHERE line_id = ? AND day = ?', lineId, day);
    } else {
      q.run('DELETE FROM prod_input WHERE line_id = ? AND day = ? AND seq = ?', lineId, day, seq);
    }
    sendJson(res, 200, { ok: true });
  });
}

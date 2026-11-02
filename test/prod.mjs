// 生产概况 / 生产输入的回归测试。
//
// 自带一个干净数据目录起服务（端口 8097），跑完即焚，不碰开发库。
//   node test/prod.mjs
//
// 生产概况是"拿几个手填的数算出来的"，所以这里验的不是"能不能返回"，
// 而是**公式**：有效工时怎么减停机、理论产量怎么乘、效率分母为 0 时给什么、
// 多条线怎么合、同一个机种两条线同时做怎么算。
// 这些口径一旦写错，界面看不出来 —— 数字照样好看，只是不对。
//
// v4.2.1 起台账按「产线 × 日」记，标准产能挂在机种上（model.std_rate），
// 所以这里的 stdRate 一律先用 PUT /api/models/:id 设到机种上，不再随台账提交。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8097);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-prod-'));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${msg}${extra ? ` —— ${extra}` : ''}`); }
}

const json = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
};
const post = (p, body) => json(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});
const put = (p, body) => json(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
});
const del = (p) => json(p, { method: 'DELETE' });

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: DATA, VWI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (b) => process.stderr.write(b.toString()));
  return child;
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(BASE + '/api/status')).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务没起来');
}

const p2 = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const TODAY = dayOf(new Date());
const YESTERDAY = dayOf(new Date(Date.now() - 86400000));

/** 存一整天的表（一行也要用数组，接口就是这么约定的） */
const saveRows = (rows, day) => post('/api/prod/input', day ? { day, rows } : { rows });

async function run() {
  const server = startServer();
  try {
    await waitReady();

    const models = (await json('/api/models')).d.models || [];
    const x200 = models.find((m) => m.code === 'X200');
    const x210 = models.find((m) => m.code === 'X210');
    const x220 = models.find((m) => m.code === 'X220');
    const board = (await json('/api/board')).d;
    const line1 = board.lines[0];

    console.log(`\n基线：${models.length} 个机种，线体 ${board.lines.map((l) => l.code).join('、')}\n`);

    // 默认线体建出来是没指定机种的，先指定上 —— 「当前生产的机种」就是靠它给的
    await post('/api/board/current', { lineId: line1.id, modelCode: 'X200' });

    // ---------- 0. 标准产能挂在机种上 ----------
    console.log('[0] 标准产能是机种属性');
    ok(x200.stdRate === 0, '种子机种默认没有标准产能', String(x200.stdRate));
    const set1 = await put('/api/models/' + x200.id, { stdRate: 120 });
    const set2 = await put('/api/models/' + x210.id, { stdRate: 100 });
    ok(set1.status === 200 && set2.status === 200, '能给机种设标准产能');
    const after = (await json('/api/models')).d.models;
    ok(after.find((m) => m.id === x200.id).stdRate === 120, '/api/models 带出 stdRate', String(after.find((m) => m.id === x200.id).stdRate));
    ok(after.find((m) => m.id === x220.id).stdRate === 0, '没设过的机种是 0');

    // ---------- 1. 没录过时的形态 ----------
    console.log('\n[1] 还没录生产输入');
    let day = (await json('/api/prod/day')).d;
    ok(day.day === TODAY, '默认查今天', day.day);
    ok(day.rows.length === 0, '没录过 → rows 为空，不去编数');
    ok(day.totals.rate === null, '没录过时效率是 null（不是 0%，更不是 100%）', String(day.totals.rate));
    ok(day.totals.doneQty === 0 && day.totals.theory === 0, '各项合计都是 0');
    ok(day.running.length === 1 && day.running[0].hasInput === false, '运行中的线标成「未录入」');
    ok(day.totals.missing === 1, 'missing 数出「有运行但没录」的产线数', String(day.totals.missing));

    // 编辑用的表：运行中的线自动出现一行，产品按当前机种预填
    let ed = (await json('/api/prod/input')).d;
    ok(ed.rows.length === 1 && ed.rows[0].saved === false, '运行中的线自动列出一行空台账');
    ok(ed.rows[0].modelId === x200.id, '产品先按这条线现在的机种带出来', ed.rows[0].modelId);
    ok(ed.rows[0].shiftHours === 8, '计划开机默认 8 小时（可改，不是暗算）', String(ed.rows[0].shiftHours));
    // 工时和节拍都现成，产量是 0 → 理论上算出 0%。（界面把"一个字没填"的行显示成「—」，
    // 那是纯展示；接口给的是能算的数，不替现场编"没录"和"干砸了"的区别）
    ok(ed.rows[0].theory === 960 && ed.rows[0].rate === 0, '工时 8 × 节拍 120 = 理论 960，产量 0 → 0%',
      `${ed.rows[0].theory} / ${ed.rows[0].rate}`);
    ok(ed.models.some((m) => m.id === x200.id && m.stdRate === 120), '下发给界面的产品带着标准产能');

    // ---------- 2. 录一条，验公式 ----------
    console.log('\n[2] 录一条台账，验算式');
    // 8 小时班 − 停机 60 分钟 = 有效 7 小时；7 × 120 = 840 件理论
    let r = await saveRows([{
      lineId: line1.id, modelId: x200.id, shiftHours: 8, planQty: 900,
      doneQty: 760, hourQty: 98, downMin: 60
    }]);
    ok(r.status === 200 && r.d.saved === 1, '保存成功', String(r.status));

    day = (await json('/api/prod/day')).d;
    const row1 = day.rows[0];
    ok(row1.effHours === 7, '有效工时 = 8 − 60/60 = 7', String(row1.effHours));
    ok(row1.theory === 840, '理论产量 = 7 × 120 = 840（节拍取自机种）', String(row1.theory));
    ok(Math.abs(row1.rate - 760 / 840) < 1e-4, '效率 = 760 / 840', String(row1.rate));
    ok(row1.avgPerHour === 109, '平均节拍 = round(760 / 7) = 109', String(row1.avgPerHour));
    ok(row1.gap === 80, '缺口 = 840 − 760 = 80', String(row1.gap));
    ok(row1.lineName === line1.name, '台账行带着产线名', row1.lineName);
    ok(day.byModel.length === 1 && day.byModel[0].code === 'X200', '按产品汇总里出现 X200');
    ok(day.totals.hourQty === 98, '「当前每小时产能」直接取最近一小时产量', String(day.totals.hourQty));
    ok(day.totals.missing === 0, '录过之后 missing 归零');
    ok(day.running[0].hasInput === true, '运行中的线变成「已录入」');
    ok(day.running[0].hourQty === 98, '线上直接带着这条线的本小时产量', String(day.running[0].hourQty));

    // ---------- 3. 幂等 ----------
    console.log('\n[3] 重复保存同一条线同一天');
    await saveRows([{
      lineId: line1.id, modelId: x200.id, shiftHours: 8, planQty: 900,
      doneQty: 760, hourQty: 98, downMin: 60
    }]);
    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 1 && day.totals.doneQty === 760, '重复保存不会多出一条', String(day.rows.length));
    ok(day.totals.theory === 840, '理论产量没被叠加', String(day.totals.theory));

    // ---------- 4. 两条线各做一个机种 ----------
    console.log('\n[4] 两条线做两个机种');
    const line2 = (await json('/api/lines', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'T2', name: '二线', slots: 5, status: 'running' })
    })).d;
    ok(!!line2.id, '新建第二条线体');
    await post('/api/board/current', { lineId: line2.id, modelCode: 'X210' });
    // 6 小时班，停机 30 分钟 → 有效 5.5；5.5 × 100 = 550
    await saveRows([{
      lineId: line2.id, modelId: x210.id, shiftHours: 6, planQty: 600,
      doneQty: 440, hourQty: 88, downMin: 30
    }]);

    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 2, '两条线各一行', String(day.rows.length));
    ok(day.byModel.length === 2, '两个产品都在按产品汇总里', String(day.byModel.length));
    ok(day.running.length === 2, '两条运行中的线', String(day.running.length));
    ok(day.totals.doneQty === 1200, '累计产能 = 760 + 440', String(day.totals.doneQty));
    ok(day.totals.hourQty === 186, '当前每小时产能 = 98 + 88', String(day.totals.hourQty));
    ok(day.totals.theory === 1390, '理论产量 = 840 + 550', String(day.totals.theory));
    ok(day.totals.effHours === 12.5, '有效工时 = 7 + 5.5', String(day.totals.effHours));
    ok(day.totals.downMin === 90, '停机 = 60 + 30 分钟', String(day.totals.downMin));
    ok(Math.abs(day.totals.rate - 1200 / 1390) < 1e-4, '合计效率按合计算，不是两个百分比求平均',
      String(day.totals.rate));

    // ---------- 5. 同一个机种两条线同时做 ----------
    console.log('\n[5] 同一个机种两条线同时做，各记各的');
    await saveRows([{
      lineId: line2.id, modelId: x200.id, shiftHours: 6, planQty: 600,
      doneQty: 440, hourQty: 88, downMin: 30
    }]);
    day = (await json('/api/prod/day')).d;
    const g = day.byModel.find((m) => m.code === 'X200');
    ok(day.rows.length === 2, '还是两行（按线记，不按机种并）', String(day.rows.length));
    ok(day.byModel.length === 1, '两个产品是同一个 → 汇总里只有一条', String(day.byModel.length));
    ok(g.lineCount === 2, '按产品汇总标出「两条线都在做」', String(g.lineCount));
    ok(g.doneQty === 1200 && g.theory === 1500, '按产品合计 = (840+660) 理论、1200 产量', `${g.doneQty}/${g.theory}`);
    await saveRows([{ lineId: line2.id, modelId: x210.id, shiftHours: 6, planQty: 600, doneQty: 440, hourQty: 88, downMin: 30 }]);

    // ---------- 6. 换型不影响当天已经录下的产量 ----------
    console.log('\n[6] 一线换到别的机种，早上 X200 的产量不能消失');
    await post('/api/board/current', { lineId: line1.id, modelCode: 'X220' });
    day = (await json('/api/prod/day')).d;
    ok(day.totals.doneQty === 1200, '换型没让合计掉下来', String(day.totals.doneQty));
    ok(day.rows.some((x) => x.modelCode === 'X200'), '已经换走的 X200 台账仍在');
    ok(day.running.find((x) => x.lineId === line1.id).modelCode === 'X220', '实时机种跟着换了');
    ok(day.totals.missing === 0, '台账没删，missing 还是 0', String(day.totals.missing));
    await post('/api/board/current', { lineId: line1.id, modelCode: 'X200' });   // 还原

    // ---------- 7. 边界 ----------
    console.log('\n[7] 边界与拒绝');
    ok((await json('/api/prod/day?day=2026-13-99')).status === 400, '不存在的日期被拒（正则过得了，Date 过不了）');
    ok((await json('/api/prod/day?day=20261102')).status === 400, '日期格式不对被拒');
    ok((await post('/api/prod/input', { day: TODAY, rows: [] })).status === 400, '空表被拒');
    ok((await post('/api/prod/input', { rows: [{ modelId: x200.id }] })).status === 400, '缺 lineId 被拒');
    ok((await post('/api/prod/input', { rows: [{ lineId: 'ln_nope' }] })).status === 400, '线体不存在被拒');
    ok((await post('/api/prod/input', { rows: [{ lineId: line1.id, modelId: 'md_nope' }] })).status === 400,
      '机种不存在被拒');
    ok((await del('/api/prod/input?day=' + TODAY)).status === 400, '删除时缺 lineId 被拒');

    // 负数与脏值一律夹到 0，别让合计变负
    await saveRows([{
      lineId: line1.id, modelId: x200.id, shiftHours: -1, planQty: -9,
      doneQty: -3, hourQty: -7, downMin: -20
    }]);
    day = (await json('/api/prod/day')).d;
    const neg = day.rows.find((x) => x.lineId === line1.id);
    ok(neg.doneQty === 0 && neg.downMin === 0 && neg.shiftHours === 0 && neg.planQty === 0,
      '负数全部夹到 0', JSON.stringify(neg));

    // 停机超过工时 → 有效工时不能是负数
    await saveRows([{ lineId: line1.id, modelId: x200.id, shiftHours: 4, planQty: 100, doneQty: 50, hourQty: 10, downMin: 600 }]);
    day = (await json('/api/prod/day')).d;
    let cur = day.rows.find((x) => x.lineId === line1.id);
    ok(cur.effHours === 0, '停机 10 小时 > 工时 4 小时 → 有效工时夹到 0', String(cur.effHours));
    ok(cur.theory === 0 && cur.rate === null, '有效工时为 0 → 效率 null，不做 0/0 兜底', `${cur.theory} / ${cur.rate}`);

    // 机种没设标准产能 → 效率 null，但累计产量照记
    await saveRows([{ lineId: line1.id, modelId: x220.id, shiftHours: 8, planQty: 900, doneQty: 700, hourQty: 90, downMin: 0 }]);
    day = (await json('/api/prod/day')).d;
    cur = day.rows.find((x) => x.lineId === line1.id);
    ok(cur.stdRate === 0 && cur.theory === 0 && cur.rate === null, '机种没设标准产能 → 理论 0、效率 null',
      `${cur.stdRate} / ${cur.theory} / ${cur.rate}`);
    ok(cur.doneQty === 700, '但累计产量照样记（产量不依赖节拍）', String(cur.doneQty));

    // 改机种的标准产能，效率跟着变（不存副本，现算）
    await put('/api/models/' + x220.id, { stdRate: 100 });
    day = (await json('/api/prod/day')).d;
    cur = day.rows.find((x) => x.lineId === line1.id);
    ok(cur.theory === 800 && Math.abs(cur.rate - 0.875) < 1e-4, '补上标准产能后效率立刻能算（8×100=800，700/800）',
      `${cur.theory} / ${cur.rate}`);

    // 一条线有产量、另一条缺标准产能 → 合计效率必须是 null。
    // 否则分母少一块，合计能算出 200% 那种"看着漂亮"的假数。
    const x230 = models.find((m) => m.code === 'X230');
    await saveRows([
      { lineId: line1.id, modelId: x200.id, shiftHours: 8, planQty: 900, doneQty: 760, hourQty: 98, downMin: 60 },
      { lineId: line2.id, modelId: x230.id, shiftHours: 8, planQty: 900, doneQty: 300, hourQty: 40, downMin: 0 }
    ]);
    day = (await json('/api/prod/day')).d;
    ok(day.totals.noTheory === 1, '数出「有产量但算不出理论」的产线数', String(day.totals.noTheory));
    ok(day.totals.rate === null, '合计效率给 null，不算出虚高的百分比', String(day.totals.rate));
    ok(day.totals.doneQty === 1060, '累计产量照样合计（产量不依赖节拍）', String(day.totals.doneQty));

    // 全空的行直接删掉，别在库里留空壳
    await saveRows([{ lineId: line2.id, modelId: '', shiftHours: 0, planQty: 0, doneQty: 0, hourQty: 0, downMin: 0 }]);
    day = (await json('/api/prod/day')).d;
    ok(!day.rows.some((x) => x.lineId === line2.id), '没选产品也没填数的行被删掉', String(day.rows.length));
    await saveRows([{ lineId: line1.id, modelId: x200.id, shiftHours: 8, planQty: 900, doneQty: 760, hourQty: 98, downMin: 60 }]);

    // ---------- 8. 翻日期 ----------
    console.log('\n[8] 翻到前一天');
    const past = (await json('/api/prod/day?day=' + YESTERDAY)).d;
    ok(past.day === YESTERDAY && past.isToday === false, '能查前一天', past.day);
    ok(past.rows.length === 0, '昨天没录过 → 空，不会把今天的数搬过去');
    const pastEd = (await json('/api/prod/input?day=' + YESTERDAY)).d;
    ok(pastEd.rows.every((x) => x.saved === false && x.doneQty === 0), '昨天的表是空的，不会带出今天的值');
    // 补录昨天（计划开机该带出"上次填的工时"，不是硬编码 8）
    await saveRows([{
      lineId: line1.id, modelId: x200.id, shiftHours: 7.5,
      planQty: 850, doneQty: 850, hourQty: 0, downMin: 20
    }], YESTERDAY);
    ok((await json('/api/prod/day?day=' + YESTERDAY)).d.rows.length === 1, '补录昨天成功');

    ok((await json('/api/prod/day')).d.rows.find((x) => x.lineId === line1.id).doneQty === 760,
      '补录昨天不影响今天的数');

    // 空着的一天：计划开机沿用这条线**之前**填过的值（不是硬编码 8）
    await del(`/api/prod/input?lineId=${line1.id}&day=${TODAY}`);
    const refill = (await json('/api/prod/input')).d;
    ok(refill.rows[0].shiftHours === 7.5, '空日期带出这条线上次填的 7.5 小时', String(refill.rows[0].shiftHours));
    // 重新录回今天，后面还要用
    await saveRows([{ lineId: line1.id, modelId: x200.id, shiftHours: 8, planQty: 900, doneQty: 760, hourQty: 98, downMin: 60 }]);

    // ---------- 9. 删一行的台账 ----------
    console.log('\n[9] 删掉某条线某天的台账');
    ok((await del(`/api/prod/input?lineId=${line2.id}&day=${TODAY}`)).status === 200, '删除成功');
    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 1 && day.rows[0].lineId === line1.id, '只剩一线那一行', String(day.rows.length));
    ok((await del(`/api/prod/input?lineId=${line2.id}&day=${TODAY}`)).status === 200,
      '删一个本来就没有的也回 200（幂等）');

    // ---------- 10. 数据落在哪 ----------
    console.log('\n[10] 落库形态');
    const dbFile = path.join(DATA, 'vwi.db');
    ok(fs.existsSync(dbFile), '库文件在数据目录里', dbFile);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('SELECT line_id, day, model_id, done_qty FROM prod_input ORDER BY day').all();
    ok(rows.length === 2, '一共 2 条台账（今天一线 + 昨天补录的一线）', String(rows.length));
    ok(rows.every((x) => x.line_id && typeof x.done_qty === 'number'), '按 line_id 记，数值按数字存');
    const dup = db.prepare(
      'SELECT COUNT(*) c FROM (SELECT line_id, day FROM prod_input GROUP BY line_id, day HAVING COUNT(*) > 1)'
    ).get();
    ok(dup.c === 0, '同一条线同一天只有一条（主键生效）');
    const cols = db.prepare('PRAGMA table_info(prod_input)').all().map((c) => c.name);
    ok(!cols.includes('std_rate'), '台账里不再存标准产能（避免改机种后效率还是老数）', cols.join(','));
    const mrow = db.prepare('SELECT std_rate FROM model WHERE code = ?').get('X200');
    ok(mrow.std_rate === 120, '标准产能落在 model.std_rate 上', String(mrow.std_rate));
    db.close();

    // ---------- 11. 一条线一天做几个型号：分「段」 ----------
    console.log('\n[11] 一条线分几段做不同型号');
    await put('/api/models/' + x230.id, { stdRate: 60 });   // 上一节故意没设，这里要用

    // 三段：2h 停机 10 分（→ 1.833h × 120 = 220）、3h（× 100 = 300）、
    //      0.5h（× 60 = 30）。seq 全写 9 —— 服务端该按提交顺序重排，不能信前端
    const sr = await saveRows([
      { lineId: line1.id, seq: 9, modelId: x200.id, shiftHours: 2, planQty: 240, doneQty: 200, hourQty: 40, downMin: 10 },
      { lineId: line1.id, seq: 9, modelId: x210.id, shiftHours: 3, planQty: 320, doneQty: 300, hourQty: 50, downMin: 0 },
      { lineId: line1.id, seq: 9, modelId: x230.id, shiftHours: 0.5, planQty: 30, doneQty: 25, hourQty: 25, downMin: 0 }
    ]);
    ok(sr.status === 200 && sr.d.saved === 1 && sr.d.segs === 3, '一条线三段一起存',
      JSON.stringify(sr.d));

    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 3, '台账里三段', String(day.rows.length));
    ok(day.rows.map((x) => x.seq).join(',') === '1,2,3', '段序按提交顺序重排成 1..3（前端给的 9 不采信）',
      day.rows.map((x) => x.seq).join(','));
    ok(day.byLine.length === 1 && day.byLine[0].segs === 3, '按线汇总认得这三段',
      JSON.stringify(day.byLine[0]));
    ok(day.totals.doneQty === 525, '累计产能 = 200 + 300 + 25', String(day.totals.doneQty));
    ok(day.totals.theory === 550, '理论产量 = 220 + 300 + 30（每段各算各的）', String(day.totals.theory));
    ok(Math.abs(day.totals.rate - 525 / 550) < 1e-4, '合计效率按合计算', String(day.totals.rate));
    ok(day.byLine[0].rate != null && Math.abs(day.byLine[0].rate - 525 / 550) < 1e-4,
      '线级效率同样按段加总，不是三段百分比求平均', String(day.byLine[0].rate));
    ok(day.totals.segCount === 3 && day.totals.inputLines === 1, '数出 3 段 / 1 条线',
      `${day.totals.segCount}/${day.totals.inputLines}`);

    // 同一个型号在同一条线上做两段 —— 按产品要并起来，但要看得出是两段
    await saveRows([
      { lineId: line1.id, modelId: x200.id, shiftHours: 1, doneQty: 100, hourQty: 100 },
      { lineId: line1.id, modelId: x200.id, shiftHours: 1, doneQty: 90, hourQty: 90 }
    ]);
    day = (await json('/api/prod/day')).d;
    const same = day.byModel.find((m) => m.code === 'X200');
    ok(day.byModel.length === 1 && same.segs === 2 && same.lineCount === 1,
      '同一型号两段：按产品合成一条，标出「2 段 · 1 条线」',
      `${day.byModel.length} / ${same.segs} / ${same.lineCount}`);
    ok(same.doneQty === 190 && same.theory === 240, '按产品合计 = 190 件 / 240 理论', `${same.doneQty}/${same.theory}`);

    // 中间夹一段全空的：丢掉，别在库里留空壳，段序也不能留洞
    await saveRows([
      { lineId: line1.id, modelId: x200.id, shiftHours: 1, doneQty: 100, hourQty: 100 },
      { lineId: line1.id, modelId: '', shiftHours: 0, planQty: 0, doneQty: 0, hourQty: 0, downMin: 0 },
      { lineId: line1.id, modelId: x210.id, shiftHours: 1, doneQty: 90, hourQty: 90 }
    ]);
    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 2 && day.rows.map((x) => x.seq).join(',') === '1,2',
      '空段被丢掉，后面那段补上 seq=2', day.rows.map((x) => x.seq).join(','));

    // 按 seq 删掉其中一段
    ok((await del(`/api/prod/input?lineId=${line1.id}&day=${TODAY}&seq=2`)).status === 200, '按 seq 删掉某一段');
    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 1 && day.rows[0].modelCode === 'X200', '只剩第一段',
      day.rows.map((x) => x.modelCode).join(','));

    // ---------- 12. 选「不开线」 ----------
    console.log('\n[12] 选「不开线」的产线不进生产概况');
    // 一段产量都不填、只标不开线：线体状态还挂着 running，但今天没排产
    ok((await saveRows([{ lineId: line1.id, isOpen: false }])).status === 200, '存「不开线」不报错');
    day = (await json('/api/prod/day')).d;
    ok(day.rows.length === 1 && day.rows[0].isOpen === false, '库里只留一条占位行',
      JSON.stringify(day.rows.map((x) => x.isOpen)));
    ok(day.rows[0].doneQty === 0 && day.rows[0].theory === 0 && day.rows[0].rate === null,
      '不开线的行所有数按 0 算，不会留着停线前那段产量');
    ok(!day.running.some((r) => r.lineId === line1.id),
      '作业内容页的「运行产线」里不再出现它 —— 这就是需求要的效果');
    ok(day.closed.some((c) => c.lineId === line1.id), '另给一份 closed 名单，界面上能说明去向');
    ok(day.totals.closedLines === 1 && day.totals.inputLines === 0, '合计里也不算它',
      `${day.totals.closedLines}/${day.totals.inputLines}`);
    ok(day.totals.doneQty === 0 && day.totals.hourQty === 0, '产量、每小时的合计都是 0',
      `${day.totals.doneQty}/${day.totals.hourQty}`);

    // 编辑表里它仍然在（否则改不回来），而且带着不开线标记
    ed = (await json('/api/prod/input')).d;
    const offGroup = ed.groups.find((g) => g.lineId === line1.id);
    ok(!!offGroup && offGroup.isOpen === false, '生产输入里它还在，标着不开线（否则改不回来）');

    // 切回开线：重新录，数照收
    await saveRows([{ lineId: line1.id, modelId: x200.id, shiftHours: 8, doneQty: 760, hourQty: 98 }]);
    day = (await json('/api/prod/day')).d;
    ok(day.running.some((r) => r.lineId === line1.id) && day.totals.doneQty === 760,
      '切回开线后重新计入生产概况', String(day.totals.doneQty));
    ok(day.totals.closedLines === 0, '不开线的计数归零');
  } finally {
    server.kill();
  }

  console.log('\n────────────────────────────');
  console.log(`  通过 ${pass}　失败 ${fails.length}`);
  if (fails.length) {
    console.log('\n失败项：');
    for (const f of fails) console.log('  - ' + f);
  }
  console.log('────────────────────────────\n');
  process.exit(fails.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

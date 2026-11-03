// 全量参数 Excel 导出 / 导回的回归测试（4.3.0 起）。
//
// 自带一个干净数据目录起服务（端口 8099），跑完即焚。
//   node test/config-xlsx.mjs
//
// 验的是这件事：**导出去的每一个可编辑字段，改完导回来要落到原来那个字段上**。
// 所以不能只看"导入返回 200"，得导出 → 改 → 导回 → 再导一遍看值。
//
// 覆盖：
//   1) 导出的 5 页签齐不齐、表头对不对、行数对不对
//   2) 「工序参数」页：播放方式 / 单文件上限 / 允许类型 / 图片最小尺寸 / 工序工时
//   3) 「线体工时设定」页：标准产能（写的是 model.std_rate，不是 line）
//   4) 老的四列 CSV 还能导（不能被新列挤坏）
//   5) 什么都没改时再导一次，不能把上万行全标成"有变化"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheets, buildWorkbook } from '../src/xlsx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8099);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-cfg-'));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${msg}${extra ? ` —— ${extra}` : ''}`); }
}

const json = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  return { status: r.status, d: await r.json().catch(() => ({})) };
};
const post = (p, body, type = 'application/json') => json(p, {
  method: 'POST', headers: { 'Content-Type': type }, body
});
const getBuf = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
};

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
  return false;
}

/** 拿一份完整导出，回 { sheets, byName, buf } */
async function exportAll() {
  const r = await getBuf('/api/export/lines.xlsx');
  const sheets = parseSheets(r.buf);
  return { sheets, byName: new Map(sheets.map((s) => [s.name, s])), buf: r.buf };
}

/** 把改过的页拼回一个文件（模拟"在 Excel 里改完保存"） */
const rebuild = (sheets) => buildWorkbook(sheets.map((s) => ({ name: s.name, rows: s.rows })));

const colIdx = (head, prefix) => head.findIndex((h) => String(h).startsWith(prefix));

(async () => {
  console.log(`\n临时数据目录：${DATA}\n端口：${PORT}\n`);
  const server = startServer();
  try {
    if (!await waitReady()) { console.log('服务未能启动，测试中止'); process.exitCode = 1; return; }
    await run();
  } finally {
    server.kill();
    setTimeout(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 占用就交给系统 */ } }, 300);
  }
  console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
  if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exitCode = 1; }
})();

async function run() {
  const models = (await json('/api/models')).d.models || [];
  const m0 = models[0];
  const ps = (await json('/api/processes?modelId=' + m0.id)).d.processes || [];
  console.log(`种子里有 ${models.length} 个机种，${m0.code} 有 ${ps.length} 道工序`);

  // ---------- 1. 导出结构 ----------
  console.log('\n[1] 导出的五页签');
  const all = await exportAll();
  ok(all.sheets.map((s) => s.name).join(',') === '线体清单,线体配置,线体工时设定,工序参数,字段说明',
    '5 个页签、顺序固定（第 1 页必须是线体清单）', all.sheets.map((s) => s.name).join(','));
  ok(JSON.stringify(all.byName.get('线体清单').rows[0]) === JSON.stringify(['线体名称', '编码', '工位数', '状态']),
    '第 1 页还是四列（老导入链不用改）');
  const cfgHead = all.byName.get('线体配置').rows[0];
  ok(cfgHead.includes('启用') && cfgHead.includes('当前机种') && cfgHead.includes('排产下一机种'),
    '第 2 页带启用 / 当前机种 / 排产下一机种', JSON.stringify(cfgHead));
  const rateHead = all.byName.get('线体工时设定').rows[0];
  ok(['标准产能(件/时)', '节拍(秒/件)', '工时合计(秒)', '瓶颈工位(秒)', '线平衡率(%)', '理论班产(件/8时)']
    .every((h) => rateHead.includes(h)), '第 3 页有标准产能 / 节拍 / 工时合计 / 瓶颈 / 平衡率 / 班产');
  const procHead = all.byName.get('工序参数').rows[0];
  ok(['播放方式', '单文件上限(MB)', '允许类型', '图片最小尺寸', '播放项数', '工序工时(秒/件)', '工时占比(%)']
    .every((h) => procHead.includes(h)), '第 4 页有播放方式 / 上限 / 允许类型 / 尺寸 / 工时 / 占比');
  ok(all.byName.get('工序参数').rows.length - 1 === models.length * ps.length,
    `第 4 页行数 = 机种 × 工序（${models.length * ps.length}）`,
    String(all.byName.get('工序参数').rows.length - 1));
  ok(all.byName.get('字段说明').rows.length > 20, '第 5 页有字段说明');

  // ---------- 2. 工序参数：改 → 导 → 查 ----------
  console.log('\n[2] 工序参数页导回');
  const proc = all.byName.get('工序参数');
  const H = proc.rows[0];
  const iCode = colIdx(H, '机种编号');
  const iOp = colIdx(H, '工序码');
  const iPlay = colIdx(H, '播放方式');
  const iMb = colIdx(H, '单文件上限');
  const iKinds = colIdx(H, '允许类型');
  const iSize = colIdx(H, '图片最小尺寸');
  const iSec = colIdx(H, '工序工时');

  proc.rows[1][iSec] = '8.5';
  proc.rows[1][iPlay] = '播一遍停';
  proc.rows[1][iKinds] = '图片≥2；PDF≥1';
  proc.rows[1][iSize] = '1920×1080';
  proc.rows[1][iMb] = '35';
  const targetCode = proc.rows[1][iCode];
  const targetOp = proc.rows[1][iOp];
  proc.rows[2][iSec] = '11.2';
  proc.rows[2][iKinds] = '不限';
  const row3Code = proc.rows[2][iCode];
  const row3Op = proc.rows[2][iOp];
  proc.rows[3][iPlay] = '瞎写的';           // 认不出 → 这一行不该导入
  const badCode = proc.rows[3][iCode];
  const badOp = proc.rows[3][iOp];

  const edited = rebuild(all.sheets);
  const pre = await post('/api/import/parse?filename=full.xlsx', edited, 'application/octet-stream');
  ok(pre.status === 200, '全量表能读进来（不再是 8 MB 上限）', `HTTP ${pre.status} ${pre.d.error || ''}`);
  ok(pre.d.sheet === '工序参数', '按页名认出「工序参数」，不是读第 1 页', pre.d.sheet);
  ok(pre.d.mapping.play !== undefined && pre.d.mapping.cycleSec !== undefined
    && pre.d.mapping.kinds !== undefined && pre.d.mapping.minSize !== undefined,
    '播放方式 / 工时 / 允许类型 / 最小尺寸四列都认出来了', JSON.stringify(pre.d.mapping));

  const r2 = pre.d.rows.find((x) => x.code === targetOp && x.modelName);
  ok(r2 && r2.status === 'diff', '改了工时的那行判为「有变化」', r2 && r2.status);
  ok(r2 && r2.extra && r2.extra.cycleSec === 8.5 && r2.extra.playMode === 'once'
    && r2.extra.maxMb === 35, 'extra 里带着工时 / 播放方式 / 上限',
  r2 && JSON.stringify(r2.extra));
  ok(r2 && r2.extra.kinds && r2.extra.kinds.length === 2
    && r2.extra.kinds.find((k) => k.kind === 'image').minCount === 2
    && r2.extra.kinds.find((k) => k.kind === 'pdf').minCount === 1, '「图片≥2；PDF≥1」解析成两条');
  ok(r2 && r2.extra.minSize && r2.extra.minSize.w === 1920 && r2.extra.minSize.h === 1080,
    '「1920×1080」解析成宽高');

  const rBad = pre.d.rows.find((x) => x.code === badOp && x.status === 'bad');
  ok(!!rBad && /播放方式/.test(rBad.reason), '播放方式乱填的行被拦下', rBad && rBad.reason);

  const send = pre.d.rows.filter((x) => x.status !== 'bad')
    .map(({ row, modelId, code, name, note, extra }) => ({ row, modelId, code, name, note, extra }));
  const w = await post('/api/processes/import', JSON.stringify({ rows: send, mode: 'update' }));
  ok(w.status === 200 && w.d.updated === 2, '只有 2 行真的写库（其余「没变化」不白改）',
    JSON.stringify({ updated: w.d.updated, kept: w.d.kept }));

  const after = (await json('/api/processes?modelId=' + models.find((m) => m.code === targetCode).id)).d.processes;
  const p1 = after.find((x) => x.code === targetOp);
  ok(p1.cycleSec === 8.5, '工序工时落到 process.cycle_sec', String(p1.cycleSec));
  ok(p1.playMode === 'once', '播放方式落到 process.play_mode', p1.playMode);
  ok(p1.maxMb === 35, '单文件上限落到 process.max_mb', String(p1.maxMb));
  const img = (p1.reqs || []).find((r) => r.kind === 'image');
  const pdf = (p1.reqs || []).find((r) => r.kind === 'pdf');
  ok(img && img.minCount === 2 && img.minWidth === 1920 && img.minHeight === 1080,
    '允许类型与图片最小尺寸落到 process_req', JSON.stringify(p1.reqs));
  ok(pdf && pdf.minCount === 1, 'PDF 也被允许，最少 1 份');

  const p2 = (await json('/api/processes?modelId=' + models.find((m) => m.code === row3Code).id))
    .d.processes.find((x) => x.code === row3Op);
  ok(p2.cycleSec === 11.2 && (p2.reqs || []).length === 0, '「不限」把允许类型清空成空表',
    JSON.stringify({ sec: p2.cycleSec, reqs: p2.reqs }));

  // ---------- 3. 线体工时设定：标准产能导回 ----------
  console.log('\n[3] 标准产能导回');
  const all2 = await exportAll();
  const rate = all2.byName.get('线体工时设定');
  const RH = rate.rows[0];
  const rCode = colIdx(RH, '机种编号');
  const rRate = colIdx(RH, '标准产能');
  rate.rows[1][rRate] = '120';
  rate.rows[2][rRate] = '100';
  const sCode = rate.rows[1][rCode];
  rate.rows[3][rRate] = '一百二';            // 乱填 → 不该导入

  const pre2 = await post('/api/import/lines/parse?filename=full.xlsx',
    rebuild(all2.sheets), 'application/octet-stream');
  ok(pre2.status === 200 && pre2.d.std, '线体导入能读到「线体工时设定」页');
  ok(pre2.d.std.counts.diff === 2, '两个机种的标准产能有变化', JSON.stringify(pre2.d.std.counts));
  ok(pre2.d.std.counts.bad === 1, '乱填的那行判为不合要求');
  ok(pre2.d.rows.every((r) => r.status !== 'bad'), '线体清单那 11 行本身全部「没变化」');

  const stdSend = pre2.d.std.rows.filter((r) => r.status === 'diff')
    .map(({ row, modelId, rate: v }) => ({ row, modelId, rate: v }));
  const w2 = await post('/api/lines/import', JSON.stringify({ rows: [], mode: 'update', stdRows: stdSend }));
  ok(w2.status === 200 && w2.d.std.updated === 2, '标准产能写进两个机种', JSON.stringify(w2.d.std));

  const ms = (await json('/api/models')).d.models;
  ok(ms.find((m) => m.code === sCode).stdRate === 120, '落到 model.std_rate', String(ms.find((m) => m.code === sCode).stdRate));

  // ---------- 4. 再导一遍：值还在，节拍跟着算出来 ----------
  console.log('\n[4] 再导出核对');
  const all3 = await exportAll();
  const rate3 = all3.byName.get('线体工时设定');
  const row3 = rate3.rows.find((r) => r[rCode] === sCode);
  ok(Number(row3[rRate]) === 120, '标准产能还是 120', String(row3[rRate]));
  ok(Number(row3[colIdx(RH, '节拍')]) === 30, '节拍 = 3600 ÷ 120 = 30 秒', String(row3[colIdx(RH, '节拍')]));
  ok(Number(row3[colIdx(RH, '理论班产')]) === 960, '理论班产 = 120 × 8', String(row3[colIdx(RH, '理论班产')]));

  const proc3 = all3.byName.get('工序参数');
  const p3 = proc3.rows.find((r) => r[iCode] === targetCode && r[iOp] === targetOp);
  ok(p3[iPlay] === '播一遍停' && Number(p3[iSec]) === 8.5, '工序参数页回读也是改后的值',
    JSON.stringify([p3[iPlay], p3[iSec]]));
  ok(String(p3[iKinds]).includes('图片≥2') && String(p3[iKinds]).includes('PDF≥1'), '允许类型回读', p3[iKinds]);

  // ---------- 5. 没改就再导一遍：不能把上万行全标成有变化 ----------
  console.log('\n[5] 原样再导一遍');
  const again = await post('/api/import/parse?filename=same.xlsx', all3.buf, 'application/octet-stream');
  ok(again.d.counts.diff === 0, '一行都不算有变化', JSON.stringify(again.d.counts));
  const again2 = await post('/api/import/lines/parse?filename=same.xlsx', all3.buf, 'application/octet-stream');
  ok(again2.d.std.counts.diff === 0, '标准产能也一行都不算有变化', JSON.stringify(again2.d.std.counts));

  // ---------- 6. 老的四列 CSV 还能导 ----------
  console.log('\n[6] 老文件兼容');
  const csvOld = Buffer.from(`机种,工序码,名称,做什么\n${m0.name},OP9,老格式,照旧能导\n`, 'utf8');
  const old = await post('/api/import/parse?filename=old.csv', csvOld, 'text/csv');
  ok(old.status === 200 && old.d.counts.new === 1, '四列老 CSV 照样能导（没被新列挤坏）',
    JSON.stringify(old.d.counts));
  ok(old.d.rows[0].extra === undefined, '没有新列时 extra 是空的，行为回到 4.2.x');
}

// 线体清单 Excel 导入 / 导出的回归测试。
//
// 自带一个干净数据目录起服务（端口 8094），跑完即焚，不碰开发库。
//   node test/lines-xlsx.mjs
//
// 验的是闭环：导出的表 → 改一改 → 导回去，三件事都要成立：
//   1) 导出和模板都能被自己的 parseSheet 读回来（不是"看着像 xlsx"）；
//   2) 预览把 新增 / 有变化 / 没变化 / 不合要求 分对，且**不写库**；
//   3) 落库后状态不被导入冲掉（这是这张表最容易被误用的地方）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheet, buildWorkbook } from '../src/xlsx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8094);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-lines-'));
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

const postXlsx = async (p, buf) => {
  const r = await fetch(BASE + p, { method: 'POST', body: buf });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
};

const getBuf = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
};

const lines = async () => (await json('/api/lines')).d.lines || [];

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
  // 种子只建一条线。至少两条才测得出「没变化」和「有变化」的分流
  if ((await lines()).length < 2) {
    await json('/api/lines', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '测试二线', slots: 6, status: 'stopped' })
    });
  }
  const base = await lines();
  console.log(`基线：${base.length} 条线体（${base.map((l) => `${l.name}/${l.code}`).join('、')}）\n`);

  // ---------- 1. 导出能被自己读回来 ----------
  console.log('[1] 导出');
  const exp = await getBuf('/api/export/lines.xlsx');
  ok(exp.status === 200, '导出返回 200', `HTTP ${exp.status}`);
  ok(exp.type.includes('spreadsheetml'), 'Content-Type 是 xlsx', exp.type);
  const expRows = parseSheet(exp.buf);
  ok(expRows.length === base.length + 1, `导出 ${expRows.length - 1} 行 = 库里的 ${base.length} 条`,
    `实际 ${expRows.length - 1}`);
  ok(JSON.stringify(expRows[0]) === JSON.stringify(['线体名称', '编码', '工位数', '状态']),
    '表头是「线体名称 / 编码 / 工位数 / 状态」', JSON.stringify(expRows[0]));
  ok(expRows.slice(1).every((r) => r[1] === (base.find((l) => l.code === r[1]) || {}).code),
    '每行编码都能在库里对上');

  const tpl = await getBuf('/api/export/lines-template.xlsx');
  ok(tpl.status === 200, '模板返回 200', `HTTP ${tpl.status}`);
  const tplRows = parseSheet(tpl.buf);
  ok(tplRows.length >= 3, `模板第一页有表头 + 示例（${tplRows.length} 行）`);
  ok(JSON.stringify(tplRows[0]) === JSON.stringify(expRows[0]), '模板表头与导出表头逐列同构');

  // ---------- 2. 预览只判定、不写库 ----------
  console.log('\n[2] 导入预览（不落库）');
  const l0 = base[0];
  const l1 = base[1];
  const s0 = l0.slots || 5;
  const s1 = l1.slots || 5;
  const sheet = [
    ['线体名称', '编码', '工位数', '状态'],
    [`${l0.name}（改）`, l0.code, String(s0 + 1), '运行'],   // 有变化：名称 + 工位数
    [l1.name, l1.code, String(s1), '运行'],                  // 没变化（状态列不参与比较）
    ['九线', 'L9', 6, '运行'],                               // 新增
    ['十线', 'L 10', 4, ''],                                 // 编码不合法
    ['十一线', '', 3, ''],                                   // 编码留空 → 自动
    ['九线', 'L9', 6, '运行']                                // 与上面重复
  ];
  const buf = buildWorkbook([{ name: '线体清单', rows: sheet }]);
  const pre = await postXlsx('/api/import/lines/parse?filename=' + encodeURIComponent('测试线体.xlsx'), buf);
  ok(pre.status === 200, '预览接口 200', `HTTP ${pre.status} ${pre.d.status || ''}`);
  const c = pre.d.counts || {};
  ok(c.same === 1, '认出一条「没变化」', JSON.stringify(c));
  ok(c.diff === 1, '认出一条「有变化」', JSON.stringify(c));
  ok(c.new === 2, '认出两条「新增」', JSON.stringify(c));
  ok(c.bad === 2, '认出两条「不合要求」（编码带空格 / 行内重复）', JSON.stringify(c));
  ok(pre.d.rows.find((r) => r.status === 'diff').detail.includes('工位数'),
    '「有变化」里写清了改了什么', pre.d.rows.find((r) => r.status === 'diff').detail);
  ok(pre.d.statusIgnored === true, '明确标出「状态」列不导入');
  const afterPre = await lines();
  ok(afterPre.length === base.length, '预览没有写库', `${base.length} → ${afterPre.length}`);

  // ---------- 3. 落库：只更新，不新建 ----------
  console.log('\n[3] 落库 · update-only');
  const send = pre.d.rows.filter((r) => r.status !== 'bad')
    .map(({ row, name, code, slots }) => ({ row, name, code, slots }));
  const w1 = await json('/api/lines/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: send, mode: 'update-only' })
  });
  ok(w1.d.created === 0, 'update-only 不新建', JSON.stringify(w1.d));
  ok(w1.d.updated === 1, '更新一条', JSON.stringify(w1.d));
  const now1 = await lines();
  const changed = now1.find((l) => l.code === l0.code);
  ok(changed && changed.name === `${l0.name}（改）`, '名称已改', changed && changed.name);
  ok(changed && changed.slots === s0 + 1, '工位数已改', changed && String(changed.slots));
  ok(changed && changed.status === l0.status, '状态没被表里的「运行」冲掉', `${l0.status} → ${changed && changed.status}`);

  // ---------- 4. 落库：新建 ----------
  console.log('\n[4] 落库 · update（含新建）');
  const w2 = await json('/api/lines/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: send, mode: 'update' })
  });
  ok(w2.d.created === 2, '新建两条', JSON.stringify(w2.d));
  const l2 = await lines();
  ok(l2.length === base.length + 2, `线体数 ${base.length} → ${l2.length}`);
  const nine = l2.find((l) => l.name === '九线');
  ok(nine && nine.code === 'L9' && nine.slots === 6, '「九线」按表里的编码/工位数建好', JSON.stringify(nine || null));
  ok(nine && nine.status === 'stopped', '新线体一律是「停线」', nine && nine.status);
  const auto = l2.find((l) => l.name === '十一线');
  ok(auto && /^L\d+$/.test(auto.code), '编码留空时自动补了 L 号', auto && auto.code);

  // ---------- 5. 再导一次：全部「没变化」 ----------
  console.log('\n[5] 重复导入幂等');
  const exp2 = await getBuf('/api/export/lines.xlsx');
  const pre2 = await postXlsx('/api/import/lines/parse?filename=roundtrip.xlsx', exp2.buf);
  ok(pre2.d.counts.new === 0 && pre2.d.counts.diff === 0 && pre2.d.counts.bad === 0,
    '导出再导回，全部「没变化」', JSON.stringify(pre2.d.counts));
  const w3 = await json('/api/lines/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: pre2.d.rows.filter((r) => r.status !== 'bad').map(({ row, name, code, slots }) => ({ row, name, code, slots })),
      mode: 'update'
    })
  });
  ok(w3.d.created === 0 && w3.d.updated === 0, '重复导入不写库', JSON.stringify(w3.d));

  // ---------- 6. 没有表头的 CSV 也能导 ----------
  console.log('\n[6] 无表头 CSV');
  const csv = Buffer.from('十二线,L12,7\n十三线,L13,5\n', 'utf8');
  const pre3 = await postXlsx('/api/import/lines/parse?filename=plain.csv', csv);
  ok(pre3.status === 200, 'CSV 预览 200', `HTTP ${pre3.status}`);
  ok(pre3.d.positional === true, '认出「没有表头」并按前三列读');
  ok(pre3.d.counts.new === 2, '读出两条新增', JSON.stringify(pre3.d.counts));

  // ---------- 7. 非法文件要给人话 ----------
  console.log('\n[7] 错误路径');
  const junk = await postXlsx('/api/import/lines/parse?filename=x.xlsx', Buffer.from('not a zip at all, really not'));
  ok(junk.status === 400 || junk.d.rows, '乱文件不会 500', `HTTP ${junk.status} ${junk.d.error || ''}`);
  const xls = await postXlsx('/api/import/lines/parse?filename=old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0]));
  ok(xls.status === 400 && /另存为/.test(xls.d.error || ''), '.xls 被拦住并给出「另存为」提示', xls.d.error);
}

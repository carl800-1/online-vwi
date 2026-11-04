// 「播放内容」（process.play_kinds）的回归测试
//
//   node test/play-kinds.mjs      （自带干净数据目录，端口 8107，跑完即焚）
//
// 验七件事：
//   1) 默认（库里是空串）= 三类全放，接口回满三项；
//   2) 勾视频只放视频、勾 PDF 只放 PDF 页 —— PDF 页在库里 kind 是 image，
//      靠 src_sha 区分，这条最容易写错；
//   3) 被挡掉的内容仍留在 item 里（只是不下发），hiddenCount 报得出来；
//   4) 三类全勾写回空串（= 未配置），不会被存成 'image,pdf,video' 两种形态；
//   5) 一样都不勾直接 400，不落库；
//   6) 改播放内容会推 contentRev（否则终端要等重启才认）；
//   7) 五页导出带「播放内容」列，原样再导一行都不算改动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheets } from '../src/xlsx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8107);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-pk-'));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fails.push(msg + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${msg}${extra ? ` —— ${extra}` : ''}`); }
}

const json = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  let d = {};
  try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  return { status: r.status, d };
};
const putJson = (p, body) => json(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const postRaw = async (p, buf, type = 'application/octet-stream') =>
  json(p, { method: 'POST', headers: { 'Content-Type': type }, body: buf });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// 一个够用的假 mp4 头：服务端只按 mime 归类，不解析视频
const MP4 = Buffer.from('000000206674797069736F6D0000020069736F6D69736F32', 'hex');

/** 手搓最小 PDF（每页一个矩形），页数与 media-layout 一致 */
function makePdf(pageCount = 1) {
  const pageIds = []; const contentIds = [];
  let n = 3;
  for (let i = 0; i < pageCount; i += 1) pageIds.push(n++);
  for (let i = 0; i < pageCount; i += 1) contentIds.push(n++);
  const bodies = new Array(n).fill('');
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pageIds.forEach((id, i) => {
    bodies[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contentIds[i]} 0 R >>`;
    const s = `0 0 ${120 + i * 10} 140 re 0.2 0.6 0.9 rg f`;
    bodies[contentIds[i]] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i < n; i += 1) { off[i] = out.length; out += `${i} 0 obj\n${bodies[i]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i += 1) out += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

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

const upload = (name, buf, mime, qs = '') => json(
  '/api/media/upload?filename=' + encodeURIComponent(name) + qs,
  { method: 'POST', headers: { 'Content-Type': mime }, body: buf }
);

const ALL_REQS = [
  { kind: 'image', minCount: 1, minWidth: 0, minHeight: 0 },
  { kind: 'pdf', minCount: 1, minWidth: 0, minHeight: 0 },
  { kind: 'video', minCount: 1, minWidth: 0, minHeight: 0 }
];

(async () => {
  console.log(`\n临时数据目录：${DATA}\n端口：${PORT}\n`);
  const server = startServer();
  try {
    if (!await waitReady()) throw new Error('服务没起来');

    const models = (await json('/api/models')).d.models || [];
    const model = models[0];
    const procs = (await json('/api/processes?modelId=' + model.id)).d.processes || [];
    const p1 = procs[0];
    const p2 = procs[1];
    console.log(`机种 ${model.code} / 工序 ${p1.code}（${p1.name}）、${p2.code}\n`);

    // ── 1. 默认全放 ─────────────────────────────────────────
    console.log('1) 默认值');
    ok(Array.isArray(p1.playKinds) && p1.playKinds.join(',') === 'image,pdf,video',
      '没配过时回满三类（= 全放）', JSON.stringify(p1.playKinds));
    await putJson('/api/processes/' + p1.id, { reqs: ALL_REQS });

    // ── 2. 三种内容都传上去 ─────────────────────────────────
    console.log('\n2) 上传三类内容');
    const own = `&modelId=${model.id}&processId=${p1.id}`;
    const img = await upload('装配示意图.png', PNG, 'image/png', own);
    const pdf = await upload('作业指导书.pdf', makePdf(2), 'application/pdf', own);
    const vid = await upload('检验要点.mp4', MP4, 'video/mp4', own);
    ok(img.status === 200 && pdf.d.kind === 'pdf' && vid.status === 200,
      '图片 / PDF / 视频都传上了', `img ${img.status} pdf ${pdf.d.pageCount} vid ${vid.status}`);

    const page = pdf.d.pages[0];
    const bind = await putJson('/api/processes/' + p1.id, { items: [
      { mediaId: img.d.id, dwellSec: 10, fit: 'contain', zoom: 100 },
      { mediaId: page.id, dwellSec: 10, fit: 'contain', zoom: 100 },
      { mediaId: vid.d.id, dwellSec: 10, fit: 'contain', zoom: 100 }
    ] });
    ok(bind.status === 200 && bind.d.process.items.length === 3, '三项都绑上了',
      JSON.stringify(bind.d.process && bind.d.process.items.length));

    // 线上还没指定当前机种时 playlist 只回空壳，所以显式带 model（终端换型时也是这么带的）
    const list = async (p = p1) => (await json(
      '/display/playlist?op=' + p.code + '&model=' + encodeURIComponent(model.code))).d;
    let pl = await list();
    ok(pl.count === 3, '默认全放：终端拿到 3 项', String(pl.count));
    ok(pl.playKinds.join(',') === 'image,pdf,video', '下发里带着生效的播放内容', JSON.stringify(pl.playKinds));

    // ── 3. 只放视频 ─────────────────────────────────────────
    console.log('\n3) 只放视频');
    await putJson('/api/processes/' + p1.id, { playKinds: ['video'] });
    pl = await list();
    ok(pl.count === 1 && pl.items[0].kind === 'video', '只下发视频那 1 项', JSON.stringify(pl.items.map((x) => x.kind)));
    ok(pl.hiddenCount === 2, '另外 2 项被挡下（内容还在，只是不放）', String(pl.hiddenCount));
    ok(pl.message === '', '有东西可放时不报错', pl.message);

    // 内容本身没被动过
    const still = (await json('/api/processes?modelId=' + model.id)).d.processes.find((x) => x.id === p1.id);
    ok(still.items.length === 3, 'item 表没被删，取消勾选再勾回来还在', String(still.items.length));

    // ── 4. 只放 PDF：PDF 页靠 src_sha 认，不看 media.kind ────
    console.log('\n4) 只放 PDF');
    await putJson('/api/processes/' + p1.id, { playKinds: ['pdf'] });
    pl = await list();
    ok(pl.count === 1 && pl.items[0].mediaId === page.id,
      'PDF 页被认成 pdf（它在库里 kind 是 image）', JSON.stringify(pl.items.map((x) => x.name)));

    // ── 5. 图片 + PDF，不含视频 ─────────────────────────────
    console.log('\n5) 图片 + PDF');
    await putJson('/api/processes/' + p1.id, { playKinds: ['image', 'pdf'] });
    pl = await list();
    ok(pl.count === 2 && !pl.items.some((x) => x.kind === 'video'), '两项、不含视频',
      JSON.stringify(pl.items.map((x) => x.kind)));

    // ── 6. 三类全勾 → 存回空串 ──────────────────────────────
    console.log('\n6) 三类全勾');
    const all = await putJson('/api/processes/' + p1.id, { playKinds: ['image', 'pdf', 'video'] });
    ok(all.d.process.playKinds.join(',') === 'image,pdf,video', '接口回满三类',
      JSON.stringify(all.d.process.playKinds));
    const rawRow = await json('/api/processes?modelId=' + model.id);
    ok(rawRow.status === 200, '（接口可读）');
    ok((await list()).count === 3, '终端又拿到 3 项');

    // ── 7. 一样都不勾 → 400 ────────────────────────────────
    console.log('\n7) 空选择');
    const empty = await putJson('/api/processes/' + p1.id, { playKinds: [] });
    ok(empty.status === 400 && /至少/.test(empty.d.error || ''), '一样都不勾直接拒', empty.d.error);
    ok((await list()).count === 3, '拒了之后库里还是原来那样');

    // ── 8. contentRev 要跟着动 ─────────────────────────────
    console.log('\n8) 终端通知');
    const line = (await json('/api/lines')).d.lines.find((l) => l.status === 'running')
      || (await json('/api/lines')).d.lines[0];
    const rev0 = (await json('/api/state?line=' + line.code + '&op=' + p1.code + '&since=0')).d.contentRev;
    await putJson('/api/processes/' + p1.id, { playKinds: ['image'] });
    const rev1 = (await json('/api/state?line=' + line.code + '&op=' + p1.code + '&since=0')).d.contentRev;
    ok(rev1 > rev0, '改播放内容会推 contentRev（终端当场重新核对）', `${rev0} → ${rev1}`);
    await putJson('/api/processes/' + p1.id, { playKinds: ['image', 'pdf', 'video'] });

    // ── 9. 全挡掉时要说明白 ────────────────────────────────
    console.log('\n9) 全被挡掉');
    await putJson('/api/processes/' + p2.id, { reqs: [{ kind: 'video', minCount: 1, minWidth: 0, minHeight: 0 }] });
    const own2 = `&modelId=${model.id}&processId=${p2.id}`;
    const v2 = await upload('二工序.mp4', MP4, 'video/mp4', own2);
    const b2 = await putJson('/api/processes/' + p2.id, { items: [{ mediaId: v2.d.id, dwellSec: 10, fit: 'contain', zoom: 100 }] });
    ok(b2.status === 200, '另一道工序只允视频、也只放了视频', JSON.stringify(b2.d.error || ''));
    await putJson('/api/processes/' + p2.id, { playKinds: ['image'] });
    const pl2 = await list(p2);
    ok(pl2.count === 0 && pl2.empty === true, '全挡掉时清单为空', `${pl2.count}/${pl2.empty}`);
    ok(/播放内容/.test(pl2.message || ''), '提示写明是「播放内容」挡的，不是"没有内容"', pl2.message);

    // ── 10. 允许类型也按同一套分类（PDF 只勾 PDF 才让传）──
    console.log('\n10) 允许类型');
    const p3 = procs[2];
    await putJson('/api/processes/' + p3.id, { reqs: [{ kind: 'image', minCount: 1, minWidth: 0, minHeight: 0 }] });
    const bad = await putJson('/api/processes/' + p3.id, { items: [{ mediaId: page.id, dwellSec: 10 }] });
    ok(bad.status === 400 && /PDF/.test(bad.d.error || ''), '只勾了图片时，PDF 页会被拦（以前悄悄放行）',
      bad.d.error);

    // ── 11. 导出带这一列，改完能导回 ────────────────────────
    console.log('\n11) 导出与导回');
    const ex = await fetch(BASE + '/api/export/lines.xlsx');
    const buf = Buffer.from(await ex.arrayBuffer());
    const sheets = parseSheets(buf);
    const sheet = sheets.find((s) => s.name === '工序参数');
    const head = sheet.rows[0];
    const iPK = head.indexOf('播放内容');
    ok(iPK >= 0, '「工序参数」页有「播放内容」列', head.join('/'));
    const row1 = sheet.rows.slice(1).find((r) => r[2] === p1.code && r[0] === model.code);
    ok(row1 && row1[iPK] === '全部', '三类全放写「全部」', row1 && String(row1[iPK]));

    await putJson('/api/processes/' + p1.id, { playKinds: ['video'] });
    const ex2 = await fetch(BASE + '/api/export/lines.xlsx');
    const buf2 = Buffer.from(await ex2.arrayBuffer());
    const s2 = parseSheets(buf2).find((s) => s.name === '工序参数');
    const rowV = s2.rows.slice(1).find((r) => r[2] === p1.code && r[0] === model.code);
    ok(rowV && rowV[iPK] === '视频', '只放视频写「视频」', rowV && String(rowV[iPK]));

    const pre = await postRaw('/api/import/parse?filename=full.xlsx', buf2);
    ok(pre.status === 200 && pre.d.sheet === '工序参数', '全量表还能读（新列没把表头顶乱）',
      `${pre.status} ${pre.d.sheet || pre.d.error}`);
    ok(pre.d.counts.diff === 0, '原样再导：一行都不算有变化', JSON.stringify(pre.d.counts));
  } catch (e) {
    fails.push('未捕获异常：' + e.message);
    console.error(e);
  } finally {
    try { server.kill(); } catch { /* 可能已退出 */ }
  }

  console.log(`\n${pass} 项通过，${fails.length} 项失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ! ' + f));
    process.exitCode = 1;
  }
})();

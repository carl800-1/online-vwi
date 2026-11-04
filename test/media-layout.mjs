// 媒体落盘布局的回归测试（4.4.0 起：按机种/工序实存）
//
// 自带干净数据目录起服务（端口 8100），跑完即焚，不碰开发库。
//   node test/media-layout.mjs
//
// 验六件事：
//   1) 上传落到 media/<机种编号>/<工序码>/<原文件名>.<ext>，且 /m/<id> 能取回同样字节；
//   2) 同内容同名不重复占盘；同名不同内容自动 -2，不覆盖；
//   3) PDF 拆页 + 原件留档（kind='source'），原件可下载但不进播放清单；
//   4) 池子里的文件第一次绑定时搬进正式目录，已有归属的不搬；
//   5) 改机种编号 / 工序码，目录跟着改名，/m/<id> 不断链；
//   6) 解绑后 GC 删文件、清空目录；老结构的 media 行（rel_path 为空）仍能走 CAS 取到。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_TEST_PORT || 8100);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-media-'));
const BASE = `http://127.0.0.1:${PORT}`;
const MEDIA = path.join(DATA, 'media');

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

const putJson = (p, body) => json(p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

const getBuf = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' };
};

const upload = (name, buf, mime, qs = '') => json(
  '/api/media/upload?filename=' + encodeURIComponent(name) + qs,
  { method: 'POST', headers: { 'Content-Type': mime }, body: buf }
);

const onDisk = (rel) => fs.existsSync(path.join(MEDIA, ...rel.split('/')));
const listDir = (rel) => {
  try { return fs.readdirSync(path.join(MEDIA, ...rel.split('/'))).sort(); } catch { return []; }
};

// 两个 1×1 的 PNG：只用来验落盘与回传字节，不要求画面正确
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** 手搓一个合法的最小 PDF：每页一个实心矩形，页数可指定 */
function makePdf(pageCount = 2) {
  const pageIds = [];
  const contentIds = [];
  let n = 3;
  for (let i = 0; i < pageCount; i += 1) pageIds.push(n++);
  for (let i = 0; i < pageCount; i += 1) contentIds.push(n++);

  const bodies = new Array(n).fill('');
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pageIds.forEach((id, i) => {
    bodies[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contentIds[i]} 0 R >>`;
    // 每页矩形大小不同，保证拆出来的 PNG 不是同一张（避免被内容哈希合并）
    const s = `0 0 ${120 + i * 20} ${140 + i * 10} re 0.2 0.6 0.9 rg f`;
    bodies[contentIds[i]] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < n; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function startServer(dataDir = DATA, port = PORT) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: dataDir, VWI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (b) => process.stderr.write(b.toString()));
  return child;
}

async function waitReady(port = PORT, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  console.log(`\n临时数据目录：${DATA}\n端口：${PORT}\n`);
  const server = startServer();
  try {
    if (!await waitReady()) throw new Error('服务没起来');

    const models = (await json('/api/models')).d.models || [];
    const model = models[0];
    const procs = (await json('/api/processes?modelId=' + model.id)).d.processes || [];
    const proc = procs[0];
    const modelDir = model.code;                    // 机种层用编号
    const dirRel = `${modelDir}/${proc.code}`;      // 工序层用工序码原样（OP1 就是 OP1）
    console.log(`机种 ${model.code}（${model.name}）/ 工序 ${proc.code} → media/${dirRel}/\n`);
    ok(dirRel.split('/')[0] === model.code, '机种目录是编号本身', dirRel);
    ok(!dirRel.endsWith(proc.code.toLowerCase()) || proc.code === proc.code.toLowerCase(),
      '工序目录保持原样，不转小写', dirRel);

    // ── 1. 上传落到机种/工序目录 ─────────────────────────────
    console.log('1) 上传落盘');
    const up1 = await upload('装配示意图.png', PNG_A, 'image/png',
      `&modelId=${model.id}&processId=${proc.id}`);
    ok(up1.status === 200, '上传返回 200', JSON.stringify(up1.d).slice(0, 120));
    ok(up1.d.path === `${dirRel}/装配示意图.png`, '返回的 path 是机种/工序/原名', up1.d.path);
    ok(onDisk(`${dirRel}/装配示意图.png`), '盘上文件在 media/<机种>/<工序>/ 下');
    ok(fs.readFileSync(path.join(MEDIA, dirRel, '装配示意图.png')).equals(PNG_A), '盘上字节与上传一致');
    const got = await getBuf('/m/' + up1.d.id);
    ok(got.status === 200 && got.buf.equals(PNG_A), '/m/<id> 取回同样字节');
    ok(got.type === 'image/png', 'Content-Type 按库里 mime 给', got.type);

    const list1 = (await json('/api/media')).d.media;
    const row1 = list1.find((m) => m.id === up1.d.id);
    ok(!!row1 && row1.modelId === model.id && row1.processId === proc.id, 'media 行记下了归属');
    ok(row1.width === 1 && row1.height === 1, '图片宽高解析到了', `${row1.width}×${row1.height}`);

    // ── 2. 同内容不重复 / 同名不同内容 -2 ───────────────────
    console.log('\n2) 去重与重名');
    const up2 = await upload('装配示意图.png', PNG_A, 'image/png',
      `&modelId=${model.id}&processId=${proc.id}`);
    ok(up2.d.duplicated === true, '同内容再传标记为复用');
    ok(listDir(dirRel).filter((f) => f.startsWith('装配示意图')).length === 1, '盘上没有多出副本');

    fs.writeFileSync(path.join(DATA, 'other.png'), PNG_B);
    const up3 = await upload('装配示意图.png', PNG_B, 'image/png',
      `&modelId=${model.id}&processId=${proc.id}`);
    ok(up3.d.path === `${dirRel}/装配示意图-2.png`, '同名不同内容自动加 -2', up3.d.path);
    ok(onDisk(`${dirRel}/装配示意图-2.png`) && onDisk(`${dirRel}/装配示意图.png`), '旧文件没被覆盖');

    // ── 3. PDF 拆页 + 原件留档 ──────────────────────────────
    console.log('\n3) PDF');
    const pdf = makePdf(2);
    const up4 = await upload('装配作业指导书.pdf', pdf, 'application/pdf',
      `&modelId=${model.id}&processId=${proc.id}`);
    ok(up4.status === 200 && up4.d.kind === 'pdf', 'PDF 上传成功', JSON.stringify(up4.d).slice(0, 120));
    ok(up4.d.pageCount === 2 && up4.d.pages.length === 2, '拆成 2 页');
    ok(onDisk(`${dirRel}/装配作业指导书.pdf`), '原件留档在同一目录');
    ok(onDisk(`${dirRel}/装配作业指导书_p01.png`) && onDisk(`${dirRel}/装配作业指导书_p02.png`), '页面按 _p01/_p02 命名');
    ok(!!up4.d.source && up4.d.source.id, '响应带回原件记录');
    const srcDl = await getBuf('/m/' + up4.d.source.id);
    ok(srcDl.status === 200 && srcDl.type === 'application/pdf', '原件可下载', String(srcDl.status));

    const all = (await json('/api/media')).d.media;
    const kinds = all.filter((m) => m.path && m.path.startsWith(dirRel + '/'))
      .map((m) => m.kind).sort();
    ok(kinds.includes('source') && kinds.filter((k) => k === 'image').length >= 3, '库里既有页也有原件', kinds.join(','));

    const again = await upload('装配作业指导书.pdf', pdf, 'application/pdf',
      `&modelId=${model.id}&processId=${proc.id}`);
    ok(again.d.duplicated === true && again.d.pageCount === 2, '同一份 PDF 再传不重复拆页');
    ok(listDir(dirRel).filter((f) => f.startsWith('装配作业指导书_p')).length === 2, '页文件仍是 2 个');

    // ── 4. 池子文件绑定时搬进工序目录 ────────────────────────
    console.log('\n4) 认领');
    const pool = await upload('标准图.png', PNG_A, 'image/png', `&modelId=${model.id}`);
    ok(pool.d.path === `${modelDir}/_未分配/标准图.png`, '只带机种时进 _未分配', pool.d.path);
    await putJson('/api/processes/' + proc.id, { items: [
      { mediaId: pool.d.id, dwellSec: 10, fit: 'contain', zoom: 100 }
    ] });
    const afterAdopt = (await json('/api/media')).d.media.find((m) => m.id === pool.d.id);
    ok(afterAdopt.path === `${dirRel}/标准图.png`, '绑定后搬进工序目录', afterAdopt.path);
    ok(!onDisk(`${modelDir}/_未分配/标准图.png`), '旧位置的文件不残留');

    // ── 5. 改名搬目录 ────────────────────────────────────────
    console.log('\n5) 改名');
    await putJson('/api/processes/' + proc.id, { code: 'OP9' });
    ok(onDisk(`${modelDir}/OP9/装配示意图.png`), '工序码改了，目录跟着改（码原样，不转大小写）');
    ok(!onDisk(`${dirRel}/装配示意图.png`), '旧工序目录不残留');
    ok((await getBuf('/m/' + up1.d.id)).status === 200, '改名后 /m/<id> 仍可取');

    // 名称不进路径：改产品名称（连非法字符一起），目录一点不动
    await putJson('/api/models/' + model.id, { name: 'MX/1:型' });
    ok(onDisk(`${modelDir}/OP9/装配示意图.png`), '改产品名称不搬目录（名称不进路径）');

    // 编号进路径：改编号，整层目录跟着改
    await putJson('/api/models/' + model.id, { code: 'MX-TEST' });
    ok(onDisk('MX-TEST/OP9/装配示意图.png'), '机种编号改了，整层目录跟着改');
    ok(!onDisk(`${modelDir}/OP9/装配示意图.png`), '旧编号目录不残留');
    const afterRename = (await json('/api/media')).d.media.find((m) => m.id === up1.d.id);
    ok(afterRename.path === 'MX-TEST/OP9/装配示意图.png', 'rel_path 同步更新', afterRename.path);
    ok((await getBuf('/m/' + up1.d.id)).status === 200, '改名后老 id 不断链');

    // ── 6. 解绑 → GC 删文件 + 清空目录 ───────────────────────
    console.log('\n6) 回收');
    await putJson('/api/processes/' + proc.id, { items: [] });
    const dry = await json('/api/media/gc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true })
    });
    ok(dry.d.total > 0, 'dryRun 报告有孤儿', String(dry.d.total));
    ok(onDisk('MX-TEST/OP9/装配示意图.png'), 'dryRun 不动文件');

    const real = await json('/api/media/gc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: false })
    });
    ok(real.d.total === dry.d.total, '真删数量与预览一致');
    ok(!onDisk('MX-TEST/OP9/装配示意图.png'), '文件已删');
    ok(listDir('MX-TEST').length === 0 && listDir('').length === 0, '空目录被清掉', listDir('').join(','));

    // ── 7. 老结构（rel_path 为空）仍走 CAS ───────────────────
    console.log('\n7) 老库兼容');
    const legacyId = 'deadbeefdeadbeef';
    const legacySha = 'deadbeef'.repeat(8);
    const casDir = path.join(MEDIA, legacySha.slice(0, 2));
    fs.mkdirSync(casDir, { recursive: true });
    fs.writeFileSync(path.join(casDir, `${legacySha}.png`), PNG_A);
    // 直接写库（服务还在跑，用同一个库文件；WAL 允许串行写）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'vwi.db'));
    db.prepare(`INSERT OR REPLACE INTO media
      (id,sha256,model_id,process_id,rel_path,kind,ext,mime,bytes,width,height,duration_ms,name,src_sha,page_no,created_at)
      VALUES(?,?,'','','',?,?,?,?,0,0,0,?,'',0,?)`)
      .run(legacyId, legacySha, 'image', 'png', 'image/png', PNG_A.length, '老文件.png', Date.now());
    db.close();
    const legacyDl = await getBuf('/m/' + legacyId);
    ok(legacyDl.status === 200 && legacyDl.buf.equals(PNG_A), 'rel_path 为空时回落到 media/xx/<sha>.<ext>');

    // 重启一次，确认迁移幂等（不会每次开库都重建表）
    server.kill();
    await new Promise((r) => setTimeout(r, 800));
    const s2 = startServer();
    try {
      ok(await waitReady(), '重启后服务正常起来');
      const after = (await json('/api/media')).d.media;
      ok(after.some((m) => m.id === legacyId), '重启后老记录还在');
    } finally { s2.kill(); }
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

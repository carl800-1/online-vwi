// 4.2.1 → 4.2.2 的生产台账迁移：现场库里的产量不能因为升级就消失。
//
// 老表主键是 (line_id, day)，一天一条线只能填一个型号；新表是 (line_id, day, seq)。
// 迁移必须把每一行原样搬成「第一段」，段序 1、开线状态 1。
//   node test/prod-migrate.mjs
//
// 做法：先正常起一次服务把库建出来，停掉，手工把 prod_input 换回 4.2.1 的形状并塞两行，
// 再起一次 —— 这一趟就会真的走迁移分支。用真库文件，不是模拟。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VWI_MIGRATE_PORT || 8098);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vwi-mig-'));
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

function start() {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, VWI_DATA: DATA, VWI_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(BASE + '/api/status')).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务没起来');
}

function stop(child) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    child.once('exit', fin);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } fin(); }, 4000).unref();
  });
}

const p2 = (n) => String(n).padStart(2, '0');
const d0 = new Date();
const TODAY = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}`;

async function run() {
  let server = start();
  try {
    await waitReady();
    const board = (await json('/api/board')).d;
    let ls = board.lines || [];
    if (!ls.length) {
      await json('/api/lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'M1', name: '迁移测试线', slots: 5, status: 'running' })
      });
      ls = (await json('/api/board')).d.lines || [];
    }
    const models = (await json('/api/models')).d.models || [];
    const m1 = models[0];
    const m2 = models[1] || models[0];
    // 种子机种默认没有标准产能 —— 先设上，否则效率一列永远是「—」，验不出东西
    const putJson = (p, body) => json(p, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await putJson('/api/models/' + m1.id, { stdRate: 120 });
    await putJson('/api/models/' + m2.id, { stdRate: m2.id === m1.id ? 120 : 100 });

    // 老库里的数：一线 8h−60min → 7h、二线 6h−30min → 5.5h
    const th1 = Math.round(7 * 120);
    const th2 = Math.round(5.5 * (m2.id === m1.id ? 120 : 100));
    await stop(server);

    // ---- 把库伪装成 4.2.1：主键 (line_id, day)，一天一线一行 ----
    const dbFile = path.join(DATA, 'vwi.db');
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('DROP TABLE IF EXISTS prod_input');
    db.exec(`CREATE TABLE prod_input (
      line_id     TEXT NOT NULL,
      day         TEXT NOT NULL,
      model_id    TEXT NOT NULL DEFAULT '',
      shift_hours REAL    NOT NULL DEFAULT 0,
      plan_qty    INTEGER NOT NULL DEFAULT 0,
      done_qty    INTEGER NOT NULL DEFAULT 0,
      hour_qty    INTEGER NOT NULL DEFAULT 0,
      down_min    INTEGER NOT NULL DEFAULT 0,
      note        TEXT    NOT NULL DEFAULT '',
      ts          INTEGER NOT NULL,
      PRIMARY KEY(line_id, day)
    )`);
    const ins = db.prepare(`INSERT INTO prod_input
      (line_id, day, model_id, shift_hours, plan_qty, done_qty, hour_qty, down_min, note, ts)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    ins.run(ls[0].id, TODAY, m1.id, 8, 900, 760, 98, 60, '老库里的数', 1700000000000);
    if (ls[1]) ins.run(ls[1].id, TODAY, m2.id, 6, 600, 440, 88, 30, '', 1700000000000);
    db.close();

    console.log(`\n伪装成 4.2.1 的库：${ls.length > 1 ? 2 : 1} 行台账\n`);

    // ---- 再起一次：这一趟走迁移 ----
    server = start();
    await waitReady();

    const day = (await json('/api/prod/day')).d;
    ok(day.rows.length === (ls[1] ? 2 : 1), '老台账一条不少地搬过来了',
      `${day.rows.length} 行`);
    ok(day.rows.every((r) => r.seq === 1), '每一行都成了这条线的「第一段」',
      day.rows.map((r) => r.seq).join(','));
    ok(day.rows.every((r) => r.isOpen === true), '默认是开线，不会被误标成不开线');
    ok(day.totals.doneQty === (ls[1] ? 1200 : 760), '累计产量没丢', String(day.totals.doneQty));
    ok(day.totals.downMin === (ls[1] ? 90 : 60), '停机分钟没丢', String(day.totals.downMin));
    const thAll = th1 + (ls[1] ? th2 : 0);
    const doneAll = ls[1] ? 1200 : 760;
    ok(day.totals.theory === thAll, '理论产量按机种节拍现算', `${day.totals.theory}/${thAll}`);
    ok(Math.abs(day.totals.rate - doneAll / thAll) < 1e-4,
      '效率还是按老数算出来的那个值', String(day.totals.rate));

    const ed = (await json('/api/prod/input')).d;
    const g0 = ed.groups.find((g) => g.lineId === ls[0].id);
    ok(!!g0 && g0.segments.length === 1 && g0.segments[0].saved === true,
      '编辑表里是一段、标着已录（能直接在后面「+ 型号」接着加）');

    // 迁移完应该能正常接着用：再给它加一段
    const r2 = await json('/api/prod/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: TODAY,
        rows: [
          { lineId: ls[0].id, modelId: m1.id, shiftHours: 8, planQty: 900, doneQty: 760, hourQty: 98, downMin: 60 },
          { lineId: ls[0].id, modelId: m2.id, shiftHours: 1, planQty: 100, doneQty: 95, hourQty: 95, downMin: 0 }
        ]
      })
    });
    ok(r2.status === 200 && r2.d.segs === 2, '迁移后的线能直接加成两段', JSON.stringify(r2.d));

    // ---- 库结构 ----
    const db2 = new DatabaseSync(dbFile, { readOnly: true });
    const cols = db2.prepare('PRAGMA table_info(prod_input)').all().map((c) => c.name);
    ok(cols.includes('seq') && cols.includes('is_open'), '新表带 seq / is_open', cols.join(','));
    const bak = db2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='prod_input_421_byline_bak'").get();
    ok(bak.c === 1, '老表改名留档，没直接删（真要回退还能把数据捞回来）');
    const bakRows = db2.prepare('SELECT COUNT(*) c FROM prod_input_421_byline_bak').get();
    ok(bakRows.c === (ls[1] ? 2 : 1), '备份里有原来的行数', String(bakRows.c));
    // 第二次开库不该再迁移一次（幂等）
    // 上面把 ls[0] 从 1 段改成了 2 段，所以总数 = 原有 + 1
    const want = (ls[1] ? 2 : 1) + 1;
    ok(db2.prepare('SELECT COUNT(*) c FROM prod_input').get().c === want,
      '搬家只有一次，没有重复插入',
      `${db2.prepare('SELECT COUNT(*) c FROM prod_input').get().c}/${want}`);
    db2.close();
  } finally {
    await stop(server);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 清不掉也无所谓 */ }
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

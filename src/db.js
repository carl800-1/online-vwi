// 数据层：内置 node:sqlite，零第三方依赖
// 八张表：line / model / process / media / item / setting + line_state + profile / profile_step / profile_req
// 设计依据：docs/03-技术方案.md 第 2 节（线体维度 v1.7.0，配置库 v1.8.0）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { now, uid, int, str } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 线体：一条物理产线。每天的活不一定在同一条线上，所以线体要能启停。
--   enabled = 1  表示"今天这条线在跑"，终端和内容矩阵都以它为基准。
--   同一时刻只允许一条线 enabled（服务端保证），这样不带 line 的老终端永远知道该找谁。
CREATE TABLE IF NOT EXISTS line (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- L1
  name        TEXT NOT NULL,            -- 一线
  enabled     INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 产品型号（全厂共用：一个型号可能在多条线上做）
CREATE TABLE IF NOT EXISTS model (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- X200
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 工序：属于某条线体，也是终端身份的一半（另一 half 是线体）。
-- code 只在同一条线体内唯一：一线有 OP10，二线也可以有 OP10，两者是两份内容。
CREATE TABLE IF NOT EXISTS process (
  id          TEXT PRIMARY KEY,
  line_id     TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL,            -- OP10
  name        TEXT NOT NULL,            -- 可改，默认名
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(line_id, code)
);

-- 媒体：内容寻址，同一文件只存一份（多型号共用同一张标准图时不会重复占盘）
CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,         -- sha256 前 16 位
  sha256      TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,            -- image | video
  ext         TEXT NOT NULL DEFAULT 'bin',
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes       INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL DEFAULT '',
  src_sha     TEXT NOT NULL DEFAULT '',  -- PDF 拆出来的页：记住来自哪个 PDF 的 sha
  page_no     INTEGER NOT NULL DEFAULT 0, -- 第几页（从 1 起）；普通图片是 0
  created_at  INTEGER NOT NULL
);

-- 播放清单项：(型号 × 工序) 下的一条
CREATE TABLE IF NOT EXISTS item (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  process_id  TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,            -- image | video，冗余存一份便于直接查
  media_id    TEXT NOT NULL REFERENCES media(id),
  dwell_sec   INTEGER NOT NULL DEFAULT 10,
  fit         TEXT NOT NULL DEFAULT 'contain', -- contain | cover
  zoom        INTEGER NOT NULL DEFAULT 100,    -- 百分比，50–200
  UNIQUE(model_id, process_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_item_mp ON item(model_id, process_id, ord);
CREATE INDEX IF NOT EXISTS idx_item_media ON item(media_id);

-- 全局状态：KV
--   rev          单调递增的通信序号（任何"该看一眼了"的变化都 +1）
--   content_rev  内容版本（清单/媒体改动时 +1）
-- 注意：换型状态不再放这里 —— 它已经是**每条线各一份**，见 line_state。
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 每条线体自己的换型状态。
-- 为什么不是继续塞 setting：一线在跑 X200、二线在跑 X300 是常态，
-- 用全局 KV 会让两条线互相打架（一条换型把另一条的当前型号也改了）。
CREATE TABLE IF NOT EXISTS line_state (
  line_id           TEXT PRIMARY KEY,
  current_model_id  TEXT NOT NULL DEFAULT '',
  pending_model_id  TEXT NOT NULL DEFAULT '',
  pending_deadline  INTEGER NOT NULL DEFAULT 0,
  seq               INTEGER NOT NULL DEFAULT 0
);

-- ============ 配置库（v1.8.0） ============
-- 一份配置档案 = "这个产品怎么做"：在哪几条线上做、要做几道工序、每道工序要交什么。
-- 它是**模板**，不是内容的副本：内容仍然存在 item 表里，
-- 档案只规定"应该有什么"，用来检查实际内容缺不缺、规格够不够。
CREATE TABLE IF NOT EXISTS profile (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,      -- P-X200
  name        TEXT NOT NULL,             -- X200 工艺配置
  model_id    TEXT NOT NULL DEFAULT '',  -- 关联型号（可空：型号还没建也能先配）
  line_codes  TEXT NOT NULL DEFAULT '',  -- 适用线体编码，逗号分隔；空 = 全部线体
  note        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 档案里的一道工序（只是要求，不是线上的真工序）
CREATE TABLE IF NOT EXISTS profile_step (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 0, -- 顺序，也是 OP10/OP20 的来源
  code        TEXT NOT NULL,              -- OP10
  name        TEXT NOT NULL,              -- 上料
  max_mb      INTEGER NOT NULL DEFAULT 0, -- 单文件体积上限（MB），0 = 不限
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE(profile_id, code)
);
CREATE INDEX IF NOT EXISTS idx_pstep_profile ON profile_step(profile_id, seq);

-- 一道工序对某类文件的要求。
-- 「有行 = 允许这类文件」是这里的核心约定：
--   有 image 行 → 允许图片，min_count 是至少几张（0 表示可以没有）
--   没有 video 行 → 这道工序不允许放视频（上传时会被拒）
-- 这样"允许什么"和"要多少"用同一张表表达，不会出现两处配置打架。
CREATE TABLE IF NOT EXISTS profile_req (
  id          TEXT PRIMARY KEY,
  step_id     TEXT NOT NULL REFERENCES profile_step(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- image | video | pdf
  min_count   INTEGER NOT NULL DEFAULT 0, -- 至少几份
  min_width   INTEGER NOT NULL DEFAULT 0, -- 仅图片：最小宽
  min_height  INTEGER NOT NULL DEFAULT 0, -- 仅图片：最小高
  UNIQUE(step_id, kind)
);
`;

let db = null;
let dataDir = '';

export function openDb(dir) {
  dataDir = dir;
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  db = new DatabaseSync(path.join(dir, 'vwi.db'));
  db.exec(SCHEMA);
  migrate();
  ensureSettings();
  return db;
}

/**
 * 增量迁移：给老库补新列。
 *
 * 为什么不靠 SCHEMA 里那句 CREATE TABLE IF NOT EXISTS —— 它只在表不存在时建表，
 * 已经在跑的现场库里表是旧的，新列永远加不上，报到"no such column"就直接白屏。
 * 所以每个新列都要在这里补一次，用 PRAGMA table_info 判断，幂等，跑多少遍都一样。
 */
function migrate() {
  const colsOf = (table) => new Set(q.all(`PRAGMA table_info(${table})`).map((r) => r.name));

  const media = colsOf('media');
  if (!media.has('src_sha')) db.exec("ALTER TABLE media ADD COLUMN src_sha TEXT NOT NULL DEFAULT ''");
  if (!media.has('page_no')) db.exec('ALTER TABLE media ADD COLUMN page_no INTEGER NOT NULL DEFAULT 0');

  const item = colsOf('item');
  if (!item.has('fit')) db.exec("ALTER TABLE item ADD COLUMN fit TEXT NOT NULL DEFAULT 'contain'");
  if (!item.has('zoom')) db.exec('ALTER TABLE item ADD COLUMN zoom INTEGER NOT NULL DEFAULT 100');

  // ---- 线体（v1.7.0）：老库里的工序全部归到默认线体，行为和升级前完全一致 ----
  const dft = ensureDefaultLine();
  const proc = colsOf('process');
  if (!proc.has('line_id')) rebuildProcessWithLine(dft.id);
  else q.run("UPDATE process SET line_id = ? WHERE line_id IS NULL OR line_id = ''", dft.id);

  migrateLineState(dft.id);
}

/**
 * 默认线体：老现场升级上来时，原来那套工序必须继续能跑，
 * 所以无条件把它的 enabled 打开（只在这一条都没有的时候建，之后不再动）。
 */
function ensureDefaultLine() {
  const hit = q.get('SELECT * FROM line ORDER BY sort, code LIMIT 1');
  if (hit) return hit;
  const id = uid('ln');
  q.run(
    'INSERT INTO line(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
    id, 'L1', '一线', 1, 10, now()
  );
  return q.get('SELECT * FROM line WHERE id = ?', id);
}

/**
 * process 表重建：把 UNIQUE(code) 换成 UNIQUE(line_id, code)。
 * SQLite 的 ALTER TABLE 改不了约束，只能建新表搬过去。
 * 搬之前必须关外键——item 引用了 process(id)，而 id 是原样保留的，所以关掉再开是安全的。
 */
function rebuildProcessWithLine(lineId) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE process_new (
      id          TEXT PRIMARY KEY,
      line_id     TEXT NOT NULL DEFAULT '',
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      UNIQUE(line_id, code)
    )`);
    db.exec(`INSERT INTO process_new(id, line_id, code, name, sort, created_at)
             SELECT id, '${lineId}', code, name, sort, created_at FROM process`);
    db.exec('DROP TABLE process');
    db.exec('ALTER TABLE process_new RENAME TO process');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[db] process 表已重建：工序归属线体');
}

/** 老的全局换型状态（setting 里的 current_model_id / seq / pending_*）搬进默认线体。 */
function migrateLineState(defaultLineId) {
  const cur = getSetting('current_model_id', '');
  const seq = Number(getSetting('seq', '0')) || 0;
  const pend = getSetting('pending_model_id', '');
  const deadline = Number(getSetting('pending_deadline', '0')) || 0;

  const has = q.get('SELECT line_id FROM line_state WHERE line_id = ?', defaultLineId);
  if (!has) {
    q.run(
      `INSERT INTO line_state(line_id, current_model_id, pending_model_id, pending_deadline, seq)
       VALUES(?,?,?,?,?)`,
      defaultLineId, cur, pend, deadline, seq
    );
    if (cur || pend) console.log(`[db] 换型状态已迁入默认线体（当前型号 ${cur || '未指定'}）`);
  }
  delSetting('current_model_id', 'seq', 'pending_model_id', 'pending_deadline');
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

export function mediaDir() {
  return path.join(dataDir, 'media');
}

// ---------- 查询快捷方式 ----------
export const q = {
  all(sql, ...args) {
    return getDb().prepare(sql).all(...args);
  },
  get(sql, ...args) {
    return getDb().prepare(sql).get(...args);
  },
  run(sql, ...args) {
    return getDb().prepare(sql).run(...args);
  },
  exec(sql) {
    return getDb().exec(sql);
  }
};

// ---------- 事务 ----------
// node:sqlite 没有内置事务包装，手写一个；回调里抛错就回滚
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
    throw e;
  }
}

// ---------- setting ----------
export function getSetting(key, def = '') {
  const row = q.get('SELECT value FROM setting WHERE key = ?', key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  q.run(
    'INSERT INTO setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value)
  );
}

export function delSetting(...keys) {
  for (const k of keys) q.run('DELETE FROM setting WHERE key = ?', k);
}

function ensureSettings() {
  const init = [
    ['rev', '0'],
    ['content_rev', '0']
  ];
  for (const [k, v] of init) {
    q.run('INSERT OR IGNORE INTO setting(key, value) VALUES(?, ?)', k, v);
  }
}

// ---------- 线体 ----------
export function lines() {
  return q.all('SELECT * FROM line ORDER BY sort, code');
}

/** 当前启用的线体。正常情况下只有一条；一条都没有时返回 null。 */
export function activeLine() {
  return q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1') || null;
}

export function lineById(id) {
  return q.get('SELECT * FROM line WHERE id = ?', String(id || '')) || null;
}

export function lineByCode(code) {
  return q.get('SELECT * FROM line WHERE code = ?', String(code || '').trim()) || null;
}

/** 启用某条线体：同时把别的线体停用（否则终端不知道该听谁的）。 */
export function enableOnlyLine(lineId) {
  tx(() => {
    q.run('UPDATE line SET enabled = 0');
    if (lineId) q.run('UPDATE line SET enabled = 1 WHERE id = ?', lineId);
  });
}

export function processesOf(lineId) {
  return q.all('SELECT * FROM process WHERE line_id = ? ORDER BY sort, code', String(lineId || ''));
}

// ---------- 种子数据 ----------
// 10 个型号、5 道工序，全部为空清单 —— 完成度从 0/50 开始，等工程部填。
// 型号与工序名都是占位：型号可在界面改名/停用，工序名可改。
export const SEED_MODELS = [
  ['X200', 'X200 型'], ['X210', 'X210 型'], ['X220', 'X220 型'], ['X230', 'X230 型'],
  ['X240', 'X240 型'], ['X250', 'X250 型'], ['X260', 'X260 型'], ['X270', 'X270 型'],
  ['X280', 'X280 型'], ['X290', 'X290 型']
];

export const SEED_PROCESSES = [
  ['OP10', '上料'],
  ['OP20', '装配'],
  ['OP30', '调试'],
  ['OP40', '检验'],
  ['OP50', '包装']
];

/**
 * 新建线体时照着标准 5 道工序复制一份。
 * 为什么要复制而不是共用：一线和二线的 OP30 是两块屏、两份内容，
 * 共用一套就变成"改了二线，一线也跟着变"，正是这次要避免的事。
 */
export function cloneStandardProcesses(lineId) {
  const t = now();
  SEED_PROCESSES.forEach(([code, name], i) => {
    q.run('INSERT INTO process(id,line_id,code,name,sort,created_at) VALUES(?,?,?,?,?,?)',
      uid('pr'), lineId, code, name, i * 10 + 10, t);
  });
  return SEED_PROCESSES.length;
}

export function seed() {
  const dft = q.get('SELECT * FROM line ORDER BY sort, code LIMIT 1');
  if (!dft) return { created: false };

  const hasProc = q.get('SELECT id FROM process LIMIT 1');
  const hasModel = q.get('SELECT id FROM model LIMIT 1');
  if (hasProc && hasModel) return { created: false };

  const t = now();
  tx(() => {
    if (!hasProc) {
      SEED_PROCESSES.forEach(([code, name], i) => {
        q.run('INSERT INTO process(id,line_id,code,name,sort,created_at) VALUES(?,?,?,?,?,?)',
          uid('pr'), dft.id, code, name, i * 10 + 10, t);
      });
    }
    if (!hasModel) {
      SEED_MODELS.forEach(([code, name], i) => {
        q.run('INSERT INTO model(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
          uid('md'), code, name, 1, i, t);
      });
    }
  });

  return { created: true, models: hasModel ? 0 : SEED_MODELS.length, processes: hasProc ? 0 : SEED_PROCESSES.length };
}

// ---------- 完成度 ----------
// 一套 = (型号 × 线体工序) 有至少一条清单项。
// 返回 { total, done, byModel: {modelId: {done, total}}, byCell: {"modelId:processId": count} }
export function coverage(lineId) {
  const models = q.all('SELECT * FROM model ORDER BY sort, code');
  const processes = processesOf(lineId);
  const ids = processes.map((p) => p.id);

  // 只统计这条线的工序，别把别的线体的项算进来
  const rows = ids.length
    ? q.all(
        `SELECT model_id, process_id, COUNT(*) n FROM item
          WHERE process_id IN (${ids.map(() => '?').join(',')})
          GROUP BY model_id, process_id`,
        ...ids
      )
    : [];

  const cell = new Map();
  for (const r of rows) cell.set(`${r.model_id}:${r.process_id}`, r.n);

  const byModel = {};
  let done = 0;
  for (const m of models) {
    let d = 0;
    for (const p of processes) {
      if ((cell.get(`${m.id}:${p.id}`) || 0) > 0) { d++; done++; }
    }
    byModel[m.id] = { done: d, total: processes.length };
  }

  return {
    total: models.length * processes.length,
    done,
    byModel,
    cells: Object.fromEntries(cell)
  };
}

// ---------- 配置库 ----------
export const KINDS = ['image', 'video', 'pdf'];

/** 全部配置档案（含工序与要求），一次取完——档案数量是十几份量级，不值得分页 */
export function profiles() {
  const rows = q.all('SELECT * FROM profile ORDER BY sort, code');
  const steps = q.all('SELECT * FROM profile_step ORDER BY profile_id, seq, code');
  const reqs = q.all('SELECT * FROM profile_req');

  const reqByStep = new Map();
  for (const r of reqs) {
    if (!reqByStep.has(r.step_id)) reqByStep.set(r.step_id, []);
    reqByStep.get(r.step_id).push({
      kind: r.kind,
      minCount: r.min_count,
      minWidth: r.min_width,
      minHeight: r.min_height
    });
  }
  const stepsByProfile = new Map();
  for (const s of steps) {
    if (!stepsByProfile.has(s.profile_id)) stepsByProfile.set(s.profile_id, []);
    stepsByProfile.get(s.profile_id).push({
      id: s.id,
      seq: s.seq,
      code: s.code,
      name: s.name,
      maxMb: s.max_mb,
      note: s.note,
      reqs: (reqByStep.get(s.id) || []).sort(
        (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
      )
    });
  }

  return rows.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    modelId: p.model_id,
    lineCodes: p.line_codes ? p.line_codes.split(',').filter(Boolean) : [],
    note: p.note,
    enabled: !!p.enabled,
    sort: p.sort,
    steps: stepsByProfile.get(p.id) || []
  }));
}

export function profileById(id) {
  return profiles().find((p) => p.id === id) || null;
}

/** 整份替换某档案的工序要求。前端一次提交整棵树，比逐个增删改少一半出错路径。 */
export function saveProfileSteps(profileId, steps) {
  tx(() => {
    const old = q.all('SELECT id FROM profile_step WHERE profile_id = ?', profileId);
    for (const r of old) q.run('DELETE FROM profile_req WHERE step_id = ?', r.id);
    q.run('DELETE FROM profile_step WHERE profile_id = ?', profileId);

    steps.forEach((s, i) => {
      const sid = uid('ps');
      q.run(
        'INSERT INTO profile_step(id,profile_id,seq,code,name,max_mb,note) VALUES(?,?,?,?,?,?,?)',
        sid, profileId, int(s.seq, i * 10 + 10), str(s.code, 16).toUpperCase(),
        str(s.name, 40), int(s.maxMb, 0), str(s.note, 200)
      );
      for (const r of (s.reqs || [])) {
        if (!KINDS.includes(r.kind)) continue;
        q.run(
          'INSERT OR IGNORE INTO profile_req(id,step_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('pr'), sid, r.kind, int(r.minCount, 0), int(r.minWidth, 0), int(r.minHeight, 0)
        );
      }
    });
  });
}

/**
 * 首次启动给一份能直接用的模板。
 * 不建的话配置库一进去是空白，工程部得从头想"该填什么"；
 * 而现场本来就有 5 道标准工序，照它起一份最贴近实际。
 */
export function ensureDefaultProfile() {
  if (q.get('SELECT id FROM profile LIMIT 1')) return false;
  const id = uid('pf');
  tx(() => {
    q.run(
      'INSERT INTO profile(id,code,name,model_id,line_codes,note,enabled,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, 'STD', '标准 ESOP 工艺模板', '', '',
      '照现场 5 道标准工序起的模板：每道工序至少 1 张图，图片不小于 1280×720。可按实际产品改。',
      1, 10, now()
    );
    SEED_PROCESSES.forEach(([code, name], i) => {
      const sid = uid('ps');
      q.run(
        'INSERT INTO profile_step(id,profile_id,seq,code,name,max_mb,note) VALUES(?,?,?,?,?,?,?)',
        sid, id, (i + 1) * 10, code, name, 20, ''
      );
      q.run(
        'INSERT INTO profile_req(id,step_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
        uid('pr'), sid, 'image', 1, 1280, 720
      );
    });
  });
  return true;
}

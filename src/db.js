// 数据层：内置 node:sqlite，零第三方依赖
// 五张表：model / process / media / item / setting
// 设计依据：docs/03-技术方案.md 第 2 节
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { now, uid } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 产品型号
CREATE TABLE IF NOT EXISTS model (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- X200
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 工序：5 条固定记录，也是终端唯一的身份（屏上配的 op 就是这里的 code）
CREATE TABLE IF NOT EXISTS process (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- OP10
  name        TEXT NOT NULL,            -- 可改，默认名
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
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
--   current_model_id   现在该播哪个型号
--   seq                单调递增，只在 activate 时 +1
--   pending_model_id   准备中的目标型号（仅在切换过程中存在）
--   pending_deadline   这次切换的超时时刻（毫秒时间戳）
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
    ['current_model_id', ''],
    ['seq', '0']
  ];
  for (const [k, v] of init) {
    q.run('INSERT OR IGNORE INTO setting(key, value) VALUES(?, ?)', k, v);
  }
}

// ---------- 种子数据 ----------
// 10 个型号、5 道工序，全部为空清单 —— 完成度从 0/50 开始，等工程部填。
// 型号与工序名都是占位：型号可在界面改名/停用，工序名可改。
const SEED_MODELS = [
  ['X200', 'X200 型'], ['X210', 'X210 型'], ['X220', 'X220 型'], ['X230', 'X230 型'],
  ['X240', 'X240 型'], ['X250', 'X250 型'], ['X260', 'X260 型'], ['X270', 'X270 型'],
  ['X280', 'X280 型'], ['X290', 'X290 型']
];

const SEED_PROCESSES = [
  ['OP10', '上料'],
  ['OP20', '装配'],
  ['OP30', '调试'],
  ['OP40', '检验'],
  ['OP50', '包装']
];

export function seed() {
  if (q.get('SELECT id FROM process LIMIT 1')) return { created: false };
  const t = now();

  tx(() => {
    SEED_PROCESSES.forEach(([code, name], i) => {
      q.run('INSERT INTO process(id, code, name, sort, created_at) VALUES(?,?,?,?,?)',
        uid('pr'), code, name, i * 10 + 10, t);
    });
    SEED_MODELS.forEach(([code, name], i) => {
      q.run('INSERT INTO model(id, code, name, enabled, sort, created_at) VALUES(?,?,?,?,?,?)',
        uid('md'), code, name, 1, i, t);
    });
  });

  return { created: true, models: SEED_MODELS.length, processes: SEED_PROCESSES.length };
}

// ---------- 完成度 ----------
// 一套 = (型号 × 工序) 有至少一条清单项。
// 返回 { total, done, byModel: {modelId: {done, total}}, byCell: {"modelId:processId": count} }
export function coverage() {
  const models = q.all('SELECT * FROM model ORDER BY sort, code');
  const processes = q.all('SELECT * FROM process ORDER BY sort, code');
  const rows = q.all('SELECT model_id, process_id, COUNT(*) n FROM item GROUP BY model_id, process_id');

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

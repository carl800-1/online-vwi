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

-- 工位：属于某个机种，是「这个机种的这块屏该看什么」。
-- v2.0.0 起内容按「机种 × 工位」存，全厂一份 —— 同一机种同一工位，
-- 一线和二线看的是同一份 SOP，换线不用重传，改一次全线生效。
-- code 与线体的工序码（process.code）对位：线体的 OP30 播的就是机种里 code=OP30 的工位。
CREATE TABLE IF NOT EXISTS station (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,            -- OP10
  name        TEXT NOT NULL,            -- 上料
  sort        INTEGER NOT NULL DEFAULT 0,
  max_mb      INTEGER NOT NULL DEFAULT 0, -- 单文件体积上限（MB），0 = 不限
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE(model_id, code)
);
CREATE INDEX IF NOT EXISTS idx_station_model ON station(model_id, sort, code);

-- 工位对某类文件的要求。核心约定同配置库：**有行 = 允许这类文件**。
--   有 image 行 → 这个工位可以传图片，min_count 是至少几张（0 = 可以没有）
--   没有 video 行 → 这个工位不接受视频（上传时会被拒）
CREATE TABLE IF NOT EXISTS station_req (
  id          TEXT PRIMARY KEY,
  station_id  TEXT NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,            -- image | video | pdf
  min_count   INTEGER NOT NULL DEFAULT 0,
  min_width   INTEGER NOT NULL DEFAULT 0, -- 仅图片
  min_height  INTEGER NOT NULL DEFAULT 0, -- 仅图片
  UNIQUE(station_id, kind)
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

-- 播放清单项：(机种 × 工位) 下的一条。
-- v2.0.0 之前这里挂的是 process_id（线体工序），同机种在不同线体要各存一份，
-- 一个 SOP 改两次、传两遍，还容易一边新一边旧。现在统一到机种工位。
CREATE TABLE IF NOT EXISTS item (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  station_id  TEXT NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,            -- image | video，冗余存一份便于直接查
  media_id    TEXT NOT NULL REFERENCES media(id),
  dwell_sec   INTEGER NOT NULL DEFAULT 10,
  fit         TEXT NOT NULL DEFAULT 'contain', -- contain | cover
  zoom        INTEGER NOT NULL DEFAULT 100,    -- 百分比，50–200
  UNIQUE(model_id, station_id, media_id)
);
-- 注：item 的索引不写在这里。老库的 item 表还没有 station_id 列，
-- SCHEMA 里写 CREATE INDEX 会立刻报 "no such column"，直接开不了库。
-- 统一放到 migrate() 末尾建（那时表结构一定已经就位）。

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
  migrateToStations();

  // 索引放在所有结构迁移之后：老库在这一步之前 item 还没有 station_id，
  // 提前建会直接抛 "no such column"，库都打不开。
  db.exec('CREATE INDEX IF NOT EXISTS idx_item_ms ON item(model_id, station_id, ord)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_item_media ON item(media_id)');
}

/**
 * v2.0.0 迁移：播放内容从「线体工序」搬到「机种工位」。
 *
 * 为什么必须搬：原来 item 挂 process_id，而 process 属于线体，于是同一机种
 * 在一线和二线是两份内容 —— 一份 SOP 要传两遍、改两次，还容易一边新一边旧。
 * 现在机种自己的工位就是内容的宿主，线体的工序只决定"这条线上有几块屏"。
 *
 * 判定是否迁过：看 item 有没有 station_id 列。SQLite 改不了列和约束，只能重建表；
 * 搬的时候关外键（item/station 的 id 都原样保留，关掉再开是安全的）。
 */
function migrateToStations() {
  const cols = new Set(q.all('PRAGMA table_info(item)').map((r) => r.name));
  if (cols.has('station_id')) return;

  const t = now();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');

    // 1) 配置库里绑了机种的档案，其工序要求原样变成工位要求
    for (const pf of q.all("SELECT * FROM profile WHERE model_id <> ''")) {
      const steps = q.all('SELECT * FROM profile_step WHERE profile_id = ? ORDER BY seq, code', pf.id);
      for (const s of steps) {
        const st = ensureStation(pf.model_id, s.code, s.name, s.seq, s.max_mb, s.note, t);
        for (const r of q.all('SELECT * FROM profile_req WHERE step_id = ?', s.id)) {
          q.run(
            'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
            uid('sr'), st.id, r.kind, r.min_count, r.min_width, r.min_height
          );
        }
      }
    }

    // 2) 老内容按 (机种, 工序码) 归并。两条线的同机种同工序会合成一个工位，
    //    用 INSERT OR IGNORE 去重（同一份文件本来就是同一份，合并不会丢东西）。
    db.exec(`CREATE TABLE item_new (
      id          TEXT PRIMARY KEY,
      model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
      station_id  TEXT NOT NULL REFERENCES station(id) ON DELETE CASCADE,
      ord         INTEGER NOT NULL DEFAULT 0,
      kind        TEXT NOT NULL,
      media_id    TEXT NOT NULL REFERENCES media(id),
      dwell_sec   INTEGER NOT NULL DEFAULT 10,
      fit         TEXT NOT NULL DEFAULT 'contain',
      zoom        INTEGER NOT NULL DEFAULT 100,
      UNIQUE(model_id, station_id, media_id)
    )`);

    const rows = q.all(
      `SELECT i.*, p.code pcode, p.name pname FROM item i JOIN process p ON p.id = i.process_id`
    );
    let moved = 0;
    for (const r of rows) {
      const st = ensureStation(r.model_id, r.pcode, r.pname, 0, 0, '', t);
      // 已经有内容 = 这个工位本来就允许这类文件。补一条 min_count=0 的要求，
      // 不写成 1，否则升级完老内容立刻满屏"未达标"，现场会以为数据坏了。
      if (!q.get('SELECT id FROM station_req WHERE station_id = ? AND kind = ?', st.id, r.kind)) {
        q.run(
          'INSERT INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), st.id, r.kind, 0, 0, 0
        );
      }
      q.run(
        `INSERT OR IGNORE INTO item_new(id,model_id,station_id,ord,kind,media_id,dwell_sec,fit,zoom)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        r.id, r.model_id, st.id, r.ord, r.kind, r.media_id,
        r.dwell_sec, r.fit || 'contain', r.zoom || 100
      );
      moved++;
    }

    db.exec('DROP TABLE item');
    db.exec('ALTER TABLE item_new RENAME TO item');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_ms ON item(model_id, station_id, ord)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_media ON item(media_id)');

    // 工位是按"内容第一次出现的顺序"建出来的，OP40 可能先于 OP10 落库。
    // 迁完按工序码重排一遍，界面上的顺序才跟产线一致。
    for (const m of q.all('SELECT id FROM model')) {
      const list = q.all('SELECT id FROM station WHERE model_id = ? ORDER BY code', m.id);
      list.forEach((s, i) => q.run('UPDATE station SET sort = ? WHERE id = ?', (i + 1) * 10, s.id));
    }

    db.exec('COMMIT');
    if (moved) console.log(`[db] ${moved} 条播放内容已从「线体工序」迁到「机种工位」`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** 找工位，没有就建一个。迁移和种子都用它，保证 (model, code) 只存在一份。 */
function ensureStation(modelId, code, name, sort, maxMb, note, ts) {
  const c = String(code || '').trim().toUpperCase();
  const hit = q.get('SELECT * FROM station WHERE model_id = ? AND code = ?', modelId, c);
  if (hit) return hit;
  const maxSort = q.get('SELECT COALESCE(MAX(sort),0) s FROM station WHERE model_id = ?', modelId).s;
  const useSort = Number(sort) > 0 ? Number(sort) : maxSort + 10;
  const id = uid('st');
  q.run(
    'INSERT INTO station(id,model_id,code,name,sort,max_mb,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, modelId, c, (String(name || '').trim() || c), useSort, int(maxMb, 0), str(note, 200), ts || now()
  );
  return q.get('SELECT * FROM station WHERE id = ?', id);
}

/**
 * 每个机种都要有一套工位。
 * 不补的话「机种设置」进去是空的，工程部不知道该配几道 —— 现场本来就有 5 道标准工序，
 * 照它起一份最贴近实际，之后可以改名、增删。幂等，每次启动跑一遍。
 */
export function ensureAllModelStations() {
  let added = 0;
  for (const m of q.all('SELECT * FROM model')) {
    if (q.get('SELECT COUNT(*) n FROM station WHERE model_id = ?', m.id).n) continue;
    const t = now();
    tx(() => {
      SEED_PROCESSES.forEach(([code, name], i) => {
        const st = ensureStation(m.id, code, name, (i + 1) * 10, 20, '', t);
        q.run(
          'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), st.id, 'image', 1, 1280, 720
        );
      });
    });
    added++;
  }
  if (added) console.log(`[db] 已为 ${added} 个机种补上标准工位（OP10…OP50）`);
  return added;
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
// 一套 = (机种 × 线体工序) 在机种工位里有至少一条内容。
// 注意这里是「按线体工序数」算分母：线体有几块屏，这套机种就缺几块。
// 同机种别的线体多出来的工位不算进来 —— 那属于别的线的活。
//
// 返回 { total, done, byModel: {modelId: {done, total}}, byCell: {"modelId:processId": count} }
export function coverage(lineId) {
  const models = q.all('SELECT * FROM model ORDER BY sort, code');
  const processes = processesOf(lineId);

  // 一次取全「机种 × 工位码」的项数，避免每个格子查一次库
  const counts = new Map(
    q.all(`
      SELECT s.model_id, s.code, COUNT(i.id) n
        FROM station s LEFT JOIN item i ON i.station_id = s.id
       GROUP BY s.model_id, s.code
    `).map((r) => [`${r.model_id}|${r.code}`, r.n])
  );

  const byModel = {};
  const cells = {};
  let done = 0;
  for (const m of models) {
    let d = 0;
    for (const p of processes) {
      const n = counts.get(`${m.id}|${p.code}`) || 0;
      cells[`${m.id}:${p.id}`] = n;
      if (n > 0) { d++; done++; }
    }
    byModel[m.id] = { done: d, total: processes.length };
  }

  return {
    total: models.length * processes.length,
    done,
    byModel,
    cells: Object.fromEntries(Object.entries(cells))
  };
}

// ---------- 工位 ----------
const KINDS_ORDER = ['image', 'video', 'pdf'];

/**
 * 一个机种的全部工位（含要求与内容），一次取完。
 * 机种数量是几十个量级、工位数是几个，逐个查库反而更慢。
 */
export function stationsOf(modelId) {
  const mid = String(modelId || '');
  const rows = q.all('SELECT * FROM station WHERE model_id = ? ORDER BY sort, code', mid);
  if (!rows.length) return [];

  const byStation = new Map(rows.map((s) => [s.id, { reqs: [], items: [] }]));

  for (const r of q.all(
    `SELECT r.* FROM station_req r JOIN station s ON s.id = r.station_id WHERE s.model_id = ?`, mid
  )) {
    const box = byStation.get(r.station_id);
    if (box) box.reqs.push({
      kind: r.kind, minCount: r.min_count, minWidth: r.min_width, minHeight: r.min_height
    });
  }

  for (const i of q.all(
    `SELECT i.*, m.name mname, m.bytes, m.width, m.height, m.duration_ms, m.ext, m.mime
       FROM item i
       JOIN media m ON m.id = i.media_id
       JOIN station s ON s.id = i.station_id
      WHERE s.model_id = ?
      ORDER BY i.ord, i.id`, mid
  )) {
    const box = byStation.get(i.station_id);
    if (!box) continue;
    box.items.push({
      id: i.id,
      mediaId: i.media_id,
      kind: i.kind,
      name: i.mname,
      bytes: i.bytes,
      width: i.width,
      height: i.height,
      durationMs: i.duration_ms,
      ext: i.ext,
      mime: i.mime,
      dwellSec: i.dwell_sec,
      fit: i.fit || 'contain',
      zoom: i.zoom || 100,
      url: `/m/${i.media_id}`
    });
  }

  return rows.map((s) => ({
    id: s.id,
    modelId: s.model_id,
    code: s.code,
    name: s.name,
    sort: s.sort,
    maxMb: s.max_mb,
    note: s.note,
    reqs: byStation.get(s.id).reqs.sort(
      (a, b) => KINDS_ORDER.indexOf(a.kind) - KINDS_ORDER.indexOf(b.kind)
    ),
    items: byStation.get(s.id).items
  }));
}

export function stationById(id) {
  return q.get('SELECT * FROM station WHERE id = ?', String(id || '')) || null;
}

/**
 * 整份替换某个工位的要求与内容。
 * 和播放清单一样走"整批覆盖"：逐条增删会留下"删了第 3 条、第 4 条序号要不要重排"
 * 的中间态，整批覆盖没有中间态，也不会出现半套内容被终端读到。
 */
export function saveStation(modelId, stationId, { name, maxMb, note, reqs, items }) {
  tx(() => {
    const st = q.get('SELECT * FROM station WHERE id = ? AND model_id = ?', stationId, modelId);
    if (!st) throw Object.assign(new Error('工位不存在'), { status: 400 });

    if (name !== undefined) q.run('UPDATE station SET name = ? WHERE id = ?', str(name, 40) || st.name, st.id);
    if (maxMb !== undefined) q.run('UPDATE station SET max_mb = ? WHERE id = ?', int(maxMb, 0), st.id);
    if (note !== undefined) q.run('UPDATE station SET note = ? WHERE id = ?', str(note, 200), st.id);

    if (Array.isArray(reqs)) {
      q.run('DELETE FROM station_req WHERE station_id = ?', st.id);
      for (const r of reqs) {
        if (!KINDS.includes(r.kind)) continue;
        q.run(
          'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), st.id, r.kind, int(r.minCount, 0), int(r.minWidth, 0), int(r.minHeight, 0)
        );
      }
    }

    if (Array.isArray(items)) {
      // 两道闸都在这里，两个入口（/api/stations/:id 和兼容的 /api/playlist）都受同一套约束：
      // 没有要求行 = 这个工位不接受这类文件；超过单文件上限也拒。
      // 空 reqs 表示"还没配要求"，此时不锁类型，否则升级上来的老工位会传不进东西。
      const allowed = q.all('SELECT kind FROM station_req WHERE station_id = ?', st.id).map((r) => r.kind);
      const limit = st.max_mb;

      q.run('DELETE FROM item WHERE model_id = ? AND station_id = ?', modelId, st.id);
      items.forEach((it, i) => {
        const mediaId = String(it.mediaId || '');
        const m = q.get('SELECT * FROM media WHERE id = ?', mediaId);
        if (!m) throw Object.assign(new Error(`内容里有不存在的文件（${mediaId}）`), { status: 400 });
        if (allowed.length && !allowed.includes(m.kind)) {
          const cn = m.kind === 'video' ? '视频' : m.kind === 'pdf' ? ' PDF' : '图片';
          throw Object.assign(new Error(`这个工位不允许放${cn}：${m.name}`), { status: 400 });
        }
        if (limit > 0 && m.bytes > limit * 1024 * 1024) {
          throw Object.assign(new Error(`文件超过 ${limit} MB：${m.name}`), { status: 400 });
        }
        q.run(
          `INSERT OR IGNORE INTO item(id,model_id,station_id,ord,kind,media_id,dwell_sec,fit,zoom)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          uid('it'), modelId, st.id, i, m.kind, mediaId,
          Math.min(120, Math.max(1, int(it.dwellSec, 10))),
          it.fit === 'cover' ? 'cover' : 'contain',
          Math.min(200, Math.max(50, int(it.zoom, 100)))
        );
      });
    }
  });
}

// ---------- 通用 ----------
export const KINDS = ['image', 'video', 'pdf'];

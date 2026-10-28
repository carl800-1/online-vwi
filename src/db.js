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

-- 工位：属于「某个机种在某条线体上」的一块屏，回答"这块屏该看什么"。
--
-- v3.0.0 起线体进了工位的主键。原因很实际：同一个机种在一线和二线的
-- 工艺路线可以完全不同 —— 一线 OP30 是压装，二线 OP30 可能是检测，
-- 甚至二线压根没有 OP40。所以 **不能靠工序码跨线对位**，
-- 每个「机种 × 线体」有自己独立的一套工位，内容各存各的。
-- 两条线大部分相同时用 POST /api/stations/copy 整套复制过来再改。
CREATE TABLE IF NOT EXISTS station (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,            -- OP10
  name        TEXT NOT NULL,            -- 上料
  sort        INTEGER NOT NULL DEFAULT 0,
  max_mb      INTEGER NOT NULL DEFAULT 0, -- 单文件体积上限（MB），0 = 不限
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE(model_id, line_id, code)
);
CREATE INDEX IF NOT EXISTS idx_station_model ON station(model_id, line_id, sort, code);

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
  migrateStationsToLines();

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

  // 配置库的档案是「绑机种」的，没有线体概念；工位现在必须有线体，
  // 就归到默认（启用）线体上。真正的线体归属由下面第 2 步按 process.line_id 决定。
  const dftLine = (q.get('SELECT id FROM line WHERE enabled = 1 ORDER BY sort LIMIT 1')
    || q.get('SELECT id FROM line ORDER BY sort, id'))?.id || '';

  const t = now();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');

    // 1) 配置库里绑了机种的档案，其工序要求原样变成工位要求
    for (const pf of q.all("SELECT * FROM profile WHERE model_id <> ''")) {
      const steps = q.all('SELECT * FROM profile_step WHERE profile_id = ? ORDER BY seq, code', pf.id);
      for (const s of steps) {
        const st = ensureStation(pf.model_id, dftLine, s.code, s.name, s.seq, s.max_mb, s.note, t);
        for (const r of q.all('SELECT * FROM profile_req WHERE step_id = ?', s.id)) {
          q.run(
            'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
            uid('sr'), st.id, r.kind, r.min_count, r.min_width, r.min_height
          );
        }
      }
    }

    // 2) 老内容按 (机种, 线体, 工序码) 归位 —— 注意这里**保留线体维度**：
    //    1.x 里一线 OP30 和二线 OP30 本来就是两份内容，各回各家，不做合并。
    //    只有同一个工位上重复引用了同一份文件时才去重（UNIQUE 兜着）。
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
      `SELECT i.*, p.code pcode, p.name pname, p.line_id pline
         FROM item i JOIN process p ON p.id = i.process_id`
    );
    let moved = 0;
    for (const r of rows) {
      const st = ensureStation(r.model_id, r.pline || dftLine, r.pcode, r.pname, 0, 0, '', t);
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
    for (const scope of q.all('SELECT model_id, line_id FROM station GROUP BY model_id, line_id')) {
      const list = q.all(
        'SELECT id FROM station WHERE model_id = ? AND line_id = ? ORDER BY code',
        scope.model_id, scope.line_id
      );
      list.forEach((s, i) => q.run('UPDATE station SET sort = ? WHERE id = ?', (i + 1) * 10, s.id));
    }

    db.exec('COMMIT');
    if (moved) console.log(`[db] ${moved} 条播放内容已从「线体工序」迁到「机种 × 线体 × 工位」`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * v3.0.0 迁移：工位长出线体维度。
 *
 * 2.0.0 那一版把内容压成「机种 × 工序码」，全厂一份；但现场同一个机种在一线和
 * 二线的工艺路线可以完全不同（甚至同一串 OP 号含义都不一样），靠码对位会串台。
 * 所以工位必须带上线体，`UNIQUE(model_id, line_id, code)`。
 *
 * 老库（2.0.0）没有 line_id，无法知道某份内容原本属于哪条线 —— 那信息在当时就被合并掉了。
 * 处理原则是**一条都不能丢**：把每个工位连同要求与内容复制到所有"有同名工序码"的线体上。
 * 复制出来的是一模一样的起点，之后各线各自改；也可以用「从其它线复制」重新覆盖。
 */
function migrateStationsToLines() {
  const cols = new Set(q.all('PRAGMA table_info(station)').map((r) => r.name));
  if (cols.has('line_id')) return;

  const allLines = q.all('SELECT id, code, enabled FROM line ORDER BY sort, id');
  const stationRows = q.all('SELECT * FROM station ORDER BY model_id, sort, code');
  if (!stationRows.length) {
    // 没有工位数据，直接重建表结构即可（少见：空库升级）
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      rebuildStationTable([]);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    return;
  }

  // 每条线有哪些工序码 —— 决定那份内容该复制到哪几条线
  const codesByLine = new Map(allLines.map((l) => [l.id, new Set()]));
  for (const p of q.all('SELECT line_id, code FROM process')) {
    if (codesByLine.has(p.line_id)) codesByLine.get(p.line_id).add(p.code);
  }
  const dftLine = (allLines.find((l) => l.enabled) || allLines[0])?.id || '';

  const reqsByStation = new Map();
  for (const r of q.all('SELECT * FROM station_req')) {
    if (!reqsByStation.has(r.station_id)) reqsByStation.set(r.station_id, []);
    reqsByStation.get(r.station_id).push(r);
  }
  const itemsByStation = new Map();
  for (const i of q.all('SELECT * FROM item ORDER BY ord, id')) {
    if (!itemsByStation.has(i.station_id)) itemsByStation.set(i.station_id, []);
    itemsByStation.get(i.station_id).push(i);
  }

  // 每个老工位 → 目标线体列表（有同名工序的线；一条都没有就落到默认线）
  const plan = [];
  for (const s of stationRows) {
    let targets = allLines.filter((l) => codesByLine.get(l.id)?.has(s.code)).map((l) => l.id);
    if (!targets.length) targets = dftLine ? [dftLine] : [];
    if (!targets.length) continue; // 一条线都没有，等于没地方挂，跳过（正常不会发生）
    plan.push({ st: s, targets });
  }

  const t = now();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');

    db.exec(`CREATE TABLE station_new (
      id          TEXT PRIMARY KEY,
      model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
      line_id     TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      sort        INTEGER NOT NULL DEFAULT 0,
      max_mb      INTEGER NOT NULL DEFAULT 0,
      note        TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      UNIQUE(model_id, line_id, code)
    )`);
    db.exec(`CREATE TABLE station_req_new (
      id          TEXT PRIMARY KEY,
      station_id  TEXT NOT NULL REFERENCES station(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      min_count   INTEGER NOT NULL DEFAULT 0,
      min_width   INTEGER NOT NULL DEFAULT 0,
      min_height  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(station_id, kind)
    )`);
    db.exec(`CREATE TABLE item_new2 (
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

    let madeStations = 0;
    let madeItems = 0;
    for (const { st, targets } of plan) {
      for (const lineId of targets) {
        const nid = uid('st');
        q.run(
          `INSERT INTO station_new(id,model_id,line_id,code,name,sort,max_mb,note,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          nid, st.model_id, lineId, st.code, st.name, st.sort, st.max_mb, st.note, st.created_at || t
        );
        madeStations++;
        for (const r of reqsByStation.get(st.id) || []) {
          q.run(
            `INSERT OR IGNORE INTO station_req_new(id,station_id,kind,min_count,min_width,min_height)
             VALUES(?,?,?,?,?,?)`,
            uid('sr'), nid, r.kind, r.min_count, r.min_width, r.min_height
          );
        }
        for (const i of itemsByStation.get(st.id) || []) {
          q.run(
            `INSERT OR IGNORE INTO item_new2(id,model_id,station_id,ord,kind,media_id,dwell_sec,fit,zoom)
             VALUES(?,?,?,?,?,?,?,?,?)`,
            uid('it'), i.model_id, nid, i.ord, i.kind, i.media_id, i.dwell_sec, i.fit || 'contain', i.zoom || 100
          );
          madeItems++;
        }
      }
    }

    db.exec('DROP TABLE item');
    db.exec('DROP TABLE station_req');
    db.exec('DROP TABLE station');
    db.exec('ALTER TABLE station_new RENAME TO station');
    db.exec('ALTER TABLE station_req_new RENAME TO station_req');
    db.exec('ALTER TABLE item_new2 RENAME TO item');
    db.exec('CREATE INDEX IF NOT EXISTS idx_station_model ON station(model_id, line_id, sort, code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_ms ON item(model_id, station_id, ord)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_media ON item(media_id)');

    db.exec('COMMIT');
    console.log(
      `[db] 工位已按线体拆开：${stationRows.length} 个工位 → ${madeStations} 个，` +
      `内容 ${madeItems} 条已复制到各线（原先合并过的无法还原，按各线各一份起步）`
    );
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也没别的办法 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** 空库升级用：老的 station 里没数据，只把表结构换成带 line_id 的。 */
function rebuildStationTable() {
  db.exec('DROP TABLE IF EXISTS station');
  db.exec(`CREATE TABLE station (
    id          TEXT PRIMARY KEY,
    model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    line_id     TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    max_mb      INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    UNIQUE(model_id, line_id, code)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_station_model ON station(model_id, line_id, sort, code)');
}

/** 找工位，没有就建一个。迁移和种子都用它，保证 (model, line, code) 只存在一份。 */
export function ensureStation(modelId, lineId, code, name, sort, maxMb, note, ts) {
  const c = String(code || '').trim().toUpperCase();
  const lid = String(lineId || '');
  const hit = q.get('SELECT * FROM station WHERE model_id = ? AND line_id = ? AND code = ?', modelId, lid, c);
  if (hit) return hit;
  const maxSort = q.get(
    'SELECT COALESCE(MAX(sort),0) s FROM station WHERE model_id = ? AND line_id = ?', modelId, lid
  ).s;
  const useSort = Number(sort) > 0 ? Number(sort) : maxSort + 10;
  const id = uid('st');
  q.run(
    'INSERT INTO station(id,model_id,line_id,code,name,sort,max_mb,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, modelId, lid, c, (String(name || '').trim() || c), useSort, int(maxMb, 0), str(note, 200), ts || now()
  );
  return q.get('SELECT * FROM station WHERE id = ?', id);
}

/**
 * 给一条线上的**所有机种**按该线工序补齐工位，返回补了几个。
 * 新建线体后立刻调它，否则新线上的每块屏都要人逐个机种点一次"补齐"才能配内容。
 */
export function ensureStationsForLine(lineId) {
  const procs = processesOf(lineId);
  if (!procs.length) return 0;

  let added = 0;
  for (const m of q.all('SELECT id FROM model')) {
    const have = new Set(
      q.all('SELECT code FROM station WHERE model_id = ? AND line_id = ?', m.id, lineId).map((r) => r.code)
    );
    const miss = procs.filter((p) => !have.has(p.code));
    if (!miss.length) continue;
    const t = now();
    tx(() => {
      miss.forEach((p) => {
        const st = ensureStation(m.id, lineId, p.code, p.name, p.sort, 20, '', t);
        q.run(
          'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), st.id, 'image', 1, 1280, 720
        );
      });
    });
    added += miss.length;
  }
  return added;
}

/**
 * 每个「机种 × 线体」都要有一套工位，工位码照抄该线体自己的工序。
 *
 * 这一条正是「同一机种在不同线体工序不同」的落地点：工位不是凭空生成的，
 * 而是按**这条线自己的工序清单**长出来的 —— 一线有 OP10–OP50 就长 5 个，
 * 二线只有 OP10–OP30 就长 3 个，两边互不影响。幂等，每次启动跑一遍。
 */
export function ensureAllModelStations() {
  const allLines = q.all('SELECT id FROM line ORDER BY sort, id');
  if (!q.get('SELECT id FROM model LIMIT 1') || !allLines.length) return 0;

  let added = 0;
  for (const l of allLines) added += ensureStationsForLine(l.id);
  if (added) console.log(`[db] 已按线体工序补上 ${added} 个机种工位`);
  return added;
}

/**
 * 把某个机种在 A 线的一套工位（要求 + 内容）复制到 B 线。
 *
 * 用途：两条线的工艺大同小异，没必要从空白开始一张张传。复制出来是完全独立的一份，
 * 之后改 B 线不影响 A 线。
 *
 * 目标线的同名工位通常**已经存在**（按线体工序自动建好的空壳），所以判据不是
 * "有没有这个工位"，而是"这个工位有没有内容"：
 *   不存在          → 建出来并填内容          记 created
 *   存在但空着      → 直接把内容填进去        记 filled
 *   存在且有内容    → 默认跳过；overwrite 才覆盖 记 skipped / replaced
 */
export function copyStations(modelId, fromLineId, toLineId, opts = {}) {
  const overwrite = !!opts.overwrite;
  const want = Array.isArray(opts.codes) && opts.codes.length
    ? new Set(opts.codes.map((c) => String(c).trim().toUpperCase()))
    : null;

  const src = q.all(
    'SELECT * FROM station WHERE model_id = ? AND line_id = ? ORDER BY sort, code',
    modelId, fromLineId
  ).filter((s) => !want || want.has(s.code));

  const t = now();
  const created = [];
  const filled = [];
  const skipped = [];
  const replaced = [];
  const empty = [];   // 源工位本身就没内容：没什么可复制，不算失败

  tx(() => {
    for (const s of src) {
      const srcItems = q.all('SELECT * FROM item WHERE station_id = ? ORDER BY ord, id', s.id);
      if (!srcItems.length) { empty.push(s.code); continue; }

      const hit = q.get(
        'SELECT * FROM station WHERE model_id = ? AND line_id = ? AND code = ?', modelId, toLineId, s.code
      );
      let nid = hit?.id;

      if (hit) {
        const had = q.get('SELECT COUNT(*) n FROM item WHERE station_id = ?', hit.id).n;
        if (had > 0 && !overwrite) { skipped.push(s.code); continue; }
        if (had > 0) { replaced.push(s.code); q.run('DELETE FROM item WHERE station_id = ?', hit.id); }
        else filled.push(s.code);
        q.run('UPDATE station SET name = ?, sort = ?, max_mb = ?, note = ? WHERE id = ?',
          s.name, s.sort, s.max_mb, s.note, hit.id);
      } else {
        nid = uid('st');
        q.run(
          `INSERT INTO station(id,model_id,line_id,code,name,sort,max_mb,note,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          nid, modelId, toLineId, s.code, s.name, s.sort, s.max_mb, s.note, t
        );
        created.push(s.code);
      }

      // 要求整份替换成来源工位的（"允许哪些类型"本来就该跟着内容走）
      q.run('DELETE FROM station_req WHERE station_id = ?', nid);
      for (const r of q.all('SELECT * FROM station_req WHERE station_id = ?', s.id)) {
        q.run(
          'INSERT OR IGNORE INTO station_req(id,station_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), nid, r.kind, r.min_count, r.min_width, r.min_height
        );
      }
      // 内容按原顺序复制一份（新 id，两条线各存各的，改一边不影响另一边）
      for (const i of srcItems) {
        q.run(
          `INSERT OR IGNORE INTO item(id,model_id,station_id,ord,kind,media_id,dwell_sec,fit,zoom)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          uid('it'), modelId, nid, i.ord, i.kind, i.media_id, i.dwell_sec, i.fit || 'contain', i.zoom || 100
        );
      }
    }
  });

  return { created, filled, skipped, replaced, empty };
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

  // 一次取全「机种 × 工位码」的项数，避免每个格子查一次库。
  // v3.0.0 起必须带 line_id：同一个机种在不同线体是两套工位，混着数会串台。
  const counts = new Map(
    q.all(`
      SELECT s.model_id, s.code, COUNT(i.id) n
        FROM station s LEFT JOIN item i ON i.station_id = s.id
       WHERE s.line_id = ?
       GROUP BY s.model_id, s.code
    `, lineId).map((r) => [`${r.model_id}|${r.code}`, r.n])
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
 * 某个机种在某条线体上的全部工位（含要求与内容），一次取完。
 * 机种数量是几十个量级、工位数是几个，逐个查库反而更慢。
 *
 * `lineId` 省略时返回该机种**所有线体**的工位（每条都带 lineId），
 * 只给"要不要跨线看"的场景用；界面上一律按线取。
 */
export function stationsOf(modelId, lineId) {
  const mid = String(modelId || '');
  const lid = String(lineId || '');
  const rows = lid
    ? q.all('SELECT * FROM station WHERE model_id = ? AND line_id = ? ORDER BY sort, code', mid, lid)
    : q.all('SELECT * FROM station WHERE model_id = ? ORDER BY line_id, sort, code', mid);
  if (!rows.length) return [];

  const byStation = new Map(rows.map((s) => [s.id, { reqs: [], items: [] }]));

  const reqRows = lid
    ? q.all(`SELECT r.* FROM station_req r JOIN station s ON s.id = r.station_id
              WHERE s.model_id = ? AND s.line_id = ?`, mid, lid)
    : q.all(`SELECT r.* FROM station_req r JOIN station s ON s.id = r.station_id
              WHERE s.model_id = ?`, mid);
  for (const r of reqRows) {
    const box = byStation.get(r.station_id);
    if (box) box.reqs.push({
      kind: r.kind, minCount: r.min_count, minWidth: r.min_width, minHeight: r.min_height
    });
  }

  const itemRows = lid
    ? q.all(`SELECT i.*, m.name mname, m.bytes, m.width, m.height, m.duration_ms, m.ext, m.mime
               FROM item i JOIN media m ON m.id = i.media_id
               JOIN station s ON s.id = i.station_id
              WHERE s.model_id = ? AND s.line_id = ?
              ORDER BY i.ord, i.id`, mid, lid)
    : q.all(`SELECT i.*, m.name mname, m.bytes, m.width, m.height, m.duration_ms, m.ext, m.mime
               FROM item i JOIN media m ON m.id = i.media_id
               JOIN station s ON s.id = i.station_id
              WHERE s.model_id = ?
              ORDER BY i.ord, i.id`, mid);
  for (const i of itemRows) {
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
    lineId: s.line_id,
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

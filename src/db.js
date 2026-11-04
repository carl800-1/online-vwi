// 数据层：内置 node:sqlite，零第三方依赖
// 八张表：line / model / process / media / item / setting + line_state + profile / profile_step / profile_req
// 设计依据：docs/03-技术方案.md 第 2 节（线体维度 v1.7.0，配置库 v1.8.0）
//
// ⚠️ 下面的 SCHEMA 仍是 **3.x 的形状**（含 station / station_req、process 带 line_id）。
// 4.0.0 的工序表由 migrateToModelProcess() 在**每次开库时**重建，全新库也一样走这条路。
// 故意不把新结构写进 SCHEMA：老库的搬家逻辑（1.x → 2.x → 3.x → 4.0）只有一条路径，
// 少一份"新库直接建、老库慢慢搬"的分叉，就不会出现两边结构对不齐的坑。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { now, uid, int, str } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 线体：一条物理产线。每天的活不一定在同一条线上，所以线体要能启停。
--   status  是给人看的状态：running 运行中 / stopped 停用 / maintain 维修中 / care 保养中
--   enabled 是给机器看的开关：只有 status = running 时才为 1，终端和内容矩阵都认它。
--   两者冗余是故意的 —— 迁移、老版本、终端协议全都继续读 enabled，不用改一行。
--
-- v3.5.0 起**允许多条线同时运行**（现场每条线有自己的终端，各带 ?line=）。
-- 只有一种情况仍然要求"唯一"：不带 line 参数的老终端按 sort 取第一条启用的线。
CREATE TABLE IF NOT EXISTS line (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- L1，自动生成，界面不显示但终端靠它寻址
  name        TEXT NOT NULL,            -- 一线
  enabled     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'stopped',  -- running | stopped | maintain | care
  slots       INTEGER NOT NULL DEFAULT 5,       -- 这条线有几块屏（工位数），只做展示不卡校验
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 可生产机种（v4.0.0）：机种勾了哪些线，界面上的「可生产机种」就是这个的反查。
-- 以前靠 station 的 DISTINCT(model,line) 隐式表达，现在工序归机种，
-- 这个关系必须单独存 —— 否则"这个机种能在哪几条线做"就没人知道了。
CREATE TABLE IF NOT EXISTS model_line (
  model_id  TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  line_id   TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  sort      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, line_id)
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
  import_batch TEXT NOT NULL DEFAULT '', -- 导入批次号，空 = 手工建的；撤销本次导入按它精确回滚
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
  -- v3.5.0：下一个要生产的机种（排产）。和 pending 不是一回事 ——
  --   next    = 排好了、还没开始切，可能放在这儿过夜；
  --   pending = 正在切、切完就清空（切换失败的兜底也靠它）。
  next_model_id     TEXT NOT NULL DEFAULT '',
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

-- ============ 生产输入（v4.2.2：按「产线 × 日 × 段」） ============
-- 生产概况里显示的每一项都由这张表算出来，没有别的数据源。
--
-- 为什么是产线而不是机种：产量本来就是"这条线今天做出来的"。
-- 同一个机种同时在两条线上做（换型过渡、赶货），按机种记只能填一个数，
-- 两条线各做多少就没了。所以一案一线，机种挂在行上。
--
-- 为什么又加了 seq（段）：一条线一天不止做一个型号。小批量切换时
-- 上午 A 做 30 分钟、下午 B 做 30 分钟是常态，一线一行就填不下了。
-- seq 只负责"这条线这天的第几段"和排序，没有别的含义 ——
-- **不要把它当时间**：具体几点做的系统不知道，现场也没人记。
--
-- is_open：这条线这天开不开。只认 seq=1 那行（整线级），其余行冗余同值。
-- 选「不开线」的线不进作业内容页的生产概况 —— 线体状态是 running
-- 但今天没排产（待料、设备空闲）时，那一栏不该顶着一条"未录入"的红字。
--
-- **标准产能不在这张表里**：它是机种属性，在「机种设置」里维护。
-- 台账只记"这条线今天做了什么、做了多少"；效率的分母由 prod_api 现算。
--
-- 为什么全是手填而不是自动采：终端只做只读展示、不上报产量，
-- 管理端也没有谁一件件点。现场实际是下班前抄一次计数器，
-- 那就老老实实给一张台账，比编一套「推算」出来好看的数字有用。
CREATE TABLE IF NOT EXISTS prod_input (
  line_id     TEXT    NOT NULL,
  day         TEXT    NOT NULL,             -- 2026-11-02，本地日
  seq         INTEGER NOT NULL DEFAULT 1,   -- 这条线这天的第几段（1 起，只用于排序）
  is_open     INTEGER NOT NULL DEFAULT 1,   -- 1=开线 0=不开线（整线，读 seq=1 那行）
  model_id    TEXT    NOT NULL DEFAULT '',  -- 这一段做的产品
  shift_hours REAL    NOT NULL DEFAULT 0,   -- 这一段的计划开机工时（小时，可带小数）
  plan_qty    INTEGER NOT NULL DEFAULT 0,   -- 计划产量（件）
  done_qty    INTEGER NOT NULL DEFAULT 0,   -- 累计产量（件，这一段到目前为止）
  hour_qty    INTEGER NOT NULL DEFAULT 0,   -- 最近一小时产量（件），现场整点抄一次
  down_min    INTEGER NOT NULL DEFAULT 0,   -- 停机时长（分钟）
  note        TEXT    NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,
  PRIMARY KEY(line_id, day, seq)
);
CREATE INDEX IF NOT EXISTS idx_prodinput_day ON prod_input(day);

-- ============ 客户端（屏）与工序绑定（4.4.0） ============
-- 为什么要有这两张表：4.0.0 之后服务端只知道"L1 的 OP10 有人在"（在线表的键是
-- lineId|op），**机器本身是匿名的**。于是"哪台屏该放哪道工序"只能跑到那台屏前面
-- 去设 —— 三条线 × 二三十道工序，逐台点必然点错。
--
-- 现在把"设备"单独记一份：谁连上来了（ip / 计算机名 / 自报的线体工序 / 最后心跳），
-- 再记一条绑定（某条线的某道工序 ↔ 某台屏）。绑定**不参与播放**：屏上还是按自己
-- 填的线号工序号拉内容，绑定的用处是"知道这道工序该是哪台屏"和"发现它被改了号"。
--
-- id 现在就是 IP：终端 1.7.1 一行不改就能进这张表。等终端下次出包上报
-- 计算机名后再按 name 显示，id 仍是 IP（换 IP 等于换一台，绑定要重做，说清楚了）。
CREATE TABLE IF NOT EXISTS client (
  id          TEXT PRIMARY KEY,           -- = ip
  ip          TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',   -- 计算机名；终端 1.8 之前一直是空
  line_code   TEXT NOT NULL DEFAULT '',   -- 它自己填的线号（已按服务端回落后解析）
  op_code     TEXT NOT NULL DEFAULT '',   -- 它自己填的工序号
  ver         TEXT NOT NULL DEFAULT '',
  res         TEXT NOT NULL DEFAULT '',
  first_seen  INTEGER NOT NULL DEFAULT 0,
  last_seen   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_client_seen ON client(last_seen);

-- 一道工序只绑一台屏：主键 (line_id, process_code)。
-- process_code 而不是 process_id —— 工序码跨机种通用，换型时工位上的屏不该变，
-- 绑定要跟着"这道工序"而不是"这个机种的这道工序"。
CREATE TABLE IF NOT EXISTS client_bind (
  line_id      TEXT NOT NULL,
  process_code TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  bound_at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_id, process_code)
);
-- 反过来也成立：一台屏只能占一个工位，否则"这台屏到底播哪道工序"说不清
CREATE UNIQUE INDEX IF NOT EXISTS ux_bind_client ON client_bind(client_id);
`;

let db = null;
let dataDir = '';

export function openDb(dir) {
  dataDir = dir;
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const dbPath = path.join(dir, 'vwi.db');

  // 4.0.0 是**结构重建**（工位层整个消失），不可逆。升级前先整库复制一份，
  // 现场发现不对就把 vwi.db.pre4.bak 改名回 vwi.db、配上 3.x 的 exe 即可回滚。
  // 只备份一次：已经有了说明这台机器已经升过，不要再覆盖掉最初那份。
  backupBeforeV4(dbPath);

  db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate();
  migrateProd();     // 4.2.1 的增量：不放在 migrate() 里，因为它对新库和老库都要跑
  migrateMedia();    // 4.4.0 的增量：media 换成「按机种/工序实存」，同样两头都要跑
  ensureSettings();
  return db;
}

/**
 * 4.4.0：媒体从「全局内容寻址池」改成「按机种/工序实存」。
 *
 * 为什么要重建整张表：老 schema 里 `sha256 UNIQUE`，一个内容全库只能有一条记录。
 * 实存之后同一张标准图在两个机种下各有一份文件，必须是两条记录 —— 而 SQLite
 * 不能 DROP CONSTRAINT，只能建新表搬过去。搬家时 rel_path 一律留空：
 * 空 = 这条还是老结构、文件仍在 media/xx/<sha>.<ext>，取文件时自动回落，
 * 所以老库不需要搬文件，打开就能用。
 *
 * item 表有 `REFERENCES media(id)`，DROP 前必须关外键（PRAGMA 只能在事务外设）。
 */
function migrateMedia() {
  const cols = new Set(q.all('PRAGMA table_info(media)').map((r) => r.name));
  if (cols.has('rel_path')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE media_v2 (
      id          TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      model_id    TEXT NOT NULL DEFAULT '',
      process_id  TEXT NOT NULL DEFAULT '',
      rel_path    TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL,
      ext         TEXT NOT NULL DEFAULT 'bin',
      mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes       INTEGER NOT NULL DEFAULT 0,
      width       INTEGER NOT NULL DEFAULT 0,
      height      INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      name        TEXT NOT NULL DEFAULT '',
      src_sha     TEXT NOT NULL DEFAULT '',
      page_no     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    )`);
    // 归属能从 item 反推的就先填上（仅供界面显示；取文件仍按 rel_path 为空回落 CAS）
    db.exec(`INSERT INTO media_v2
      (id,sha256,model_id,process_id,rel_path,kind,ext,mime,bytes,width,height,duration_ms,name,src_sha,page_no,created_at)
      SELECT id, sha256,
             COALESCE((SELECT i.model_id   FROM item i WHERE i.media_id = media.id LIMIT 1), ''),
             COALESCE((SELECT i.process_id FROM item i WHERE i.media_id = media.id LIMIT 1), ''),
             '', kind, ext, mime, bytes, width, height, duration_ms, name, src_sha, page_no, created_at
        FROM media`);
    db.exec('DROP TABLE media');
    db.exec('ALTER TABLE media_v2 RENAME TO media');
    // sha256 从唯一键降级成普通索引：同内容允许多份（每个机种一份），校验和 ETag 仍靠它
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_sha ON media(sha256)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_owner ON media(model_id, process_id)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚过就算了 */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[db] media 表已升级：按机种/工序实存（新增 model_id / process_id / rel_path）');
}

function backupBeforeV4(dbPath) {
  const bak = dbPath + '.pre4.bak';
  if (fs.existsSync(bak) || !fs.existsSync(dbPath)) return;
  try {
    // 判断是不是老结构：有 station 表、process 表还没有 model_id 列
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    let needs = false;
    try {
      const cols = probe.prepare('PRAGMA table_info(process)').all().map((r) => r.name);
      const hasStation = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='station'").get();
      needs = !!hasStation && cols.length > 0 && !cols.includes('model_id');
    } finally {
      probe.close();
    }
    if (!needs) return;
    // WAL 模式下直接复制主文件可能丢掉未落盘的页，先 checkpoint 再说。
    // 打不开（比如文件被锁）就不备份，迁移照跑 —— 不能因为备份失败让人开不了机。
    fs.copyFileSync(dbPath, bak);
    console.log(`[db] 升级 4.0.0 前已备份：${bak}`);
  } catch (e) {
    console.warn('[db] 升级前备份失败，继续迁移：', e.message);
  }
}

/**
 * 4.2.1 的增量：标准产能挂到机种上 + 生产台账改成按产线记。
 *
 * 单独一个函数而不是塞进 migrate()：migrate() 对 4.x 的库是**提前 return** 的
 * （见里面那句 colsOf('process').has('model_id')），而新装的库 process 表还是
 * 3.x 形状，要走完整条链才重建 —— 两头都落不到 4.x 那个分支里。所以这段
 * 无条件跑，靠 PRAGMA 判存在性，幂等。
 */
function migrateProd() {
  const colsOf = (t) => new Set(q.all(`PRAGMA table_info(${t})`).map((r) => r.name));

  // 标准产能挪到机种上：效率的分母是"这个产品该跑多快"，跟着产品走才对；
  // 放台账里等于每天重填一遍同样的数，改一次节拍还得回头改每一天。
  if (!colsOf('model').has('std_rate')) {
    db.exec('ALTER TABLE model ADD COLUMN std_rate INTEGER NOT NULL DEFAULT 0');
  }

  // 生产台账换过两次主键：
  //   4.2.0 及更早  「机种 × 日」     —— 没有线，搬不过来（本来也只有本机几条试数据）
  //   4.2.1        「产线 × 日」     —— 一天一条线只能填一个型号，要搬成"第一段"
  //   4.2.2 起     「产线 × 日 × 段」 —— 一条线一天可以做好几个型号
  // 主键变了 ALTER 改不动，只能重建。老表**改名留档**而不是删：真要回退到老 exe，
  // 把备份表改回 prod_input 就能接上。
  const pi = colsOf('prod_input');
  if (pi.size && !pi.has('line_id')) {
    db.exec('DROP TABLE IF EXISTS prod_input_420_bak');
    db.exec('ALTER TABLE prod_input RENAME TO prod_input_420_bak');
  } else if (pi.size && !pi.has('seq')) {
    db.exec('DROP TABLE IF EXISTS prod_input_421_byline_bak');
    db.exec('ALTER TABLE prod_input RENAME TO prod_input_421_byline_bak');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS prod_input (
    line_id     TEXT    NOT NULL,
    day         TEXT    NOT NULL,
    seq         INTEGER NOT NULL DEFAULT 1,
    is_open     INTEGER NOT NULL DEFAULT 1,
    model_id    TEXT    NOT NULL DEFAULT '',
    shift_hours REAL    NOT NULL DEFAULT 0,
    plan_qty    INTEGER NOT NULL DEFAULT 0,
    done_qty    INTEGER NOT NULL DEFAULT 0,
    hour_qty    INTEGER NOT NULL DEFAULT 0,
    down_min    INTEGER NOT NULL DEFAULT 0,
    note        TEXT    NOT NULL DEFAULT '',
    ts          INTEGER NOT NULL,
    PRIMARY KEY(line_id, day, seq)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prodinput_day ON prod_input(day)');

  // 4.2.1 录的台账原样搬成「第一段」——现场已经录过的产量不能因为升级就消失。
  // INSERT OR IGNORE：重复跑迁移不会把手工改过的数覆盖回去。
  if (colsOf('prod_input_421_byline_bak').size) {
    db.exec(`INSERT OR IGNORE INTO prod_input
      (line_id, day, seq, is_open, model_id, shift_hours, plan_qty, done_qty, hour_qty, down_min, note, ts)
      SELECT line_id, day, 1, 1, model_id, shift_hours, plan_qty, done_qty, hour_qty, down_min, note, ts
        FROM prod_input_421_byline_bak`);
  }

  // 兜底：万一表是"有 seq 没 is_open"的中间态
  if (colsOf('prod_input').size && !colsOf('prod_input').has('is_open')) {
    db.exec('ALTER TABLE prod_input ADD COLUMN is_open INTEGER NOT NULL DEFAULT 1');
  }
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

  // v4.0.0 及以后的库：结构已经换过一轮，下面那些「1.x→2.x→3.x」的搬家逻辑
  // 再跑一次会把 process 表按 line_id 重建回去。所以先认版本，认出来就只补增量列。
  if (colsOf('process').has('model_id')) {
    if (!colsOf('line').has('slots')) {
      db.exec('ALTER TABLE line ADD COLUMN slots INTEGER NOT NULL DEFAULT 5');
    }
    // 4.3.0：工序工时（秒/件）。一道工序 = 一个工位，所以它同时就是「工位工时分配」。
    // 放在这个提前 return 的支里 + 上面 process_v4 的建表语句里 —— 两个入口各补一次，
    // 老库走这里，新库/3.x 库走 migrateToModelProcess 重建时直接带上。
    if (!colsOf('process').has('cycle_sec')) {
      db.exec('ALTER TABLE process ADD COLUMN cycle_sec REAL NOT NULL DEFAULT 0');
    }
    // 4.5.0：播放内容。空串 = 三类都放（默认，等于没限），和 process_req「整表为空=不锁」
    // 是同一个套路：不写库 ≠ 全关掉，升级上来的老工序不会因为加了这个字段突然什么都不播。
    if (!colsOf('process').has('play_kinds')) {
      db.exec("ALTER TABLE process ADD COLUMN play_kinds TEXT NOT NULL DEFAULT ''");
    }

    return;
  }

  const media = colsOf('media');
  if (!media.has('src_sha')) db.exec("ALTER TABLE media ADD COLUMN src_sha TEXT NOT NULL DEFAULT ''");
  if (!media.has('page_no')) db.exec('ALTER TABLE media ADD COLUMN page_no INTEGER NOT NULL DEFAULT 0');

  const item = colsOf('item');
  if (!item.has('fit')) db.exec("ALTER TABLE item ADD COLUMN fit TEXT NOT NULL DEFAULT 'contain'");
  if (!item.has('zoom')) db.exec('ALTER TABLE item ADD COLUMN zoom INTEGER NOT NULL DEFAULT 100');

  // v3.4.0：导入批次号。加列而不是加表 —— 只是给 station 挂一个标记，
  // 没这一列时撤销导入只能"凭时间猜"，删错了收不回来。
  const station = colsOf('station');
  if (!station.has('import_batch')) db.exec("ALTER TABLE station ADD COLUMN import_batch TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_station_batch ON station(import_batch)');

  // ---- 线体（v1.7.0）：老库里的工序全部归到默认线体，行为和升级前完全一致 ----
  const dft = ensureDefaultLine();

  // v3.5.0：线体状态。老库只有 enabled 两态，**只在第一次加列时**按它回填。
  // 回填语句必须待在这个 if 里面 —— 放外面每次启动都会把"维修中"刷回"运行中"。
  // 两列各判各的。原来写成 if / else-if，3.x 的老库这两列**都没有**，
  // 只补了 status 就跳过 slots，接着 migrateToModelProcess() 里
  // `UPDATE line SET slots = ...` 直接报 no such column、整个库打不开。
  const lineCols = colsOf('line');
  if (!lineCols.has('status')) {
    db.exec("ALTER TABLE line ADD COLUMN status TEXT NOT NULL DEFAULT 'stopped'");
    db.exec("UPDATE line SET status = CASE WHEN enabled = 1 THEN 'running' ELSE 'stopped' END");
  }
  if (!lineCols.has('slots')) {
    db.exec('ALTER TABLE line ADD COLUMN slots INTEGER NOT NULL DEFAULT 5');
  }

  // v3.5.0：下一个要生产的机种（排产）。pending_model_id 是"正在切"，这个是"排好了还没切"。
  const lsCols = colsOf('line_state');
  if (!lsCols.has('next_model_id')) {
    db.exec("ALTER TABLE line_state ADD COLUMN next_model_id TEXT NOT NULL DEFAULT ''");
  }

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

  // 最后一步：3.x → 4.0.0，工位层整个消失，工序归到机种。
  migrateToModelProcess();
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
export function ensureStation(modelId, lineId, code, name, sort, maxMb, note, ts, batch) {
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
    'INSERT INTO station(id,model_id,line_id,code,name,sort,max_mb,note,created_at,import_batch) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, modelId, lid, c, (String(name || '').trim() || c), useSort, int(maxMb, 0), str(note, 200), ts || now(),
    String(batch || '')
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
    'INSERT INTO line(id,code,name,enabled,status,slots,sort,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, 'L1', '一线', 1, 'running', 5, 10, now()
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
/**
 * v4.0.0 迁移：工位层整个消失，工序（= 一块屏的内容槽位）直接归机种。
 *
 * 为什么砍掉工位表：工位原本是「机种 × 线体 × 工序码」的三元组，存在的理由是
 * 同一机种在一线和二线的工艺可以不同。现场实际不是这样 —— 工艺是跟着产品走的，
 * 一条机种就一套工序，多条线做同一个产品时工艺相同。于是"每线一套工位"变成
 * 纯粹的管理负担：新建线体要长出 N×M 个空壳，改一道工序要改所有线的同码工位。
 *
 * 新的关系：
 *   model  --(model_line)--  line        这个机种能在哪几条线做
 *   model  --(process)----   工序 OP1/OP2…  这个机种有几道工序、各叫什么
 *   process --(item)------   每道工序播什么
 * 终端要内容时按：线 → 当前机种 → 该机种的工序（按 op 码）→ 清单。
 *
 * 合并规则（同机种同码在多条线都有工位时）：
 *   工序名 / 排序 / 体积上限 / 说明 取**排序最靠前的线**那一份；
 *   要求按 kind 取最大值；内容按 ord 顺序拼接，同一份文件重复的只留一条。
 *   被丢掉的条数会打日志 —— 这是不可逆的，用户升级前有整库备份兜底。
 *
 * 老库升级前 openDb 会先把 vwi.db 复制一份 .pre4.bak，回滚时换回去即可。
 */
function migrateToModelProcess() {
  const colsOf = (t) => new Set(q.all(`PRAGMA table_info(${t})`).map((r) => r.name));
  if (colsOf('process').has('model_id')) return;

  const hasStation = colsOf('station').size > 0 && colsOf('station').has('id');
  const t = now();
  let merged = 0;   // 被合并掉的（机种, 工序码）组合数
  let dropped = 0;  // 跨线重复内容丢掉条数

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');

    db.exec(`CREATE TABLE process_v4 (
      id            TEXT PRIMARY KEY,
      model_id      TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
      code          TEXT NOT NULL,
      name          TEXT NOT NULL,
      sort          INTEGER NOT NULL DEFAULT 0,
      max_mb        INTEGER NOT NULL DEFAULT 0,
      note          TEXT NOT NULL DEFAULT '',
      play_mode     TEXT NOT NULL DEFAULT 'loop',
      cycle_sec     REAL    NOT NULL DEFAULT 0,
      -- 4.5.0：这道工序在终端上放哪几类（image,pdf,video 的逗号列表）；空串 = 三类全放
      play_kinds    TEXT    NOT NULL DEFAULT '',
      import_batch  TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      UNIQUE(model_id, code)
    )`);
    db.exec(`CREATE TABLE process_req_v4 (
      id          TEXT PRIMARY KEY,
      process_id  TEXT NOT NULL REFERENCES process_v4(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      min_count   INTEGER NOT NULL DEFAULT 0,
      min_width   INTEGER NOT NULL DEFAULT 0,
      min_height  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(process_id, kind)
    )`);
    db.exec(`CREATE TABLE item_v4 (
      id          TEXT PRIMARY KEY,
      model_id    TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
      process_id  TEXT NOT NULL REFERENCES process_v4(id) ON DELETE CASCADE,
      ord         INTEGER NOT NULL DEFAULT 0,
      kind        TEXT NOT NULL,
      media_id    TEXT NOT NULL REFERENCES media(id),
      dwell_sec   INTEGER NOT NULL DEFAULT 10,
      fit         TEXT NOT NULL DEFAULT 'contain',
      zoom        INTEGER NOT NULL DEFAULT 100,
      UNIQUE(model_id, process_id, media_id)
    )`);

    // 1) 工位 → 工序（每个「机种 × 工序码」一条）
    const pMap = new Map();
    if (hasStation) {
      const rows = q.all(`
        SELECT s.*, COALESCE(l.sort, 0) lsort
          FROM station s LEFT JOIN line l ON l.id = s.line_id
         ORDER BY s.model_id, s.code, COALESCE(l.sort, 0), s.id
      `);
      for (const s of rows) {
        const key = `${s.model_id}|${s.code}`;
        if (pMap.has(key)) { merged += 1; continue; }
        const pid = uid('pr');
        q.run(
          `INSERT INTO process_v4(id,model_id,code,name,sort,max_mb,note,play_mode,import_batch,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          pid, s.model_id, s.code, s.name, s.sort || 0, s.max_mb || 0,
          s.note || '', 'loop', s.import_batch || '', s.created_at || t
        );
        pMap.set(key, pid);
      }
    }

    // 2) 工位要求 → 工序要求（同 kind 取最大，宁严不松）
    if (hasStation) {
      for (const r of q.all(`SELECT r.*, s.model_id, s.code
                               FROM station_req r JOIN station s ON s.id = r.station_id`)) {
        const pid = pMap.get(`${r.model_id}|${r.code}`);
        if (!pid) continue;
        const ex = q.get('SELECT * FROM process_req_v4 WHERE process_id = ? AND kind = ?', pid, r.kind);
        if (!ex) {
          q.run(
            'INSERT INTO process_req_v4(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
            uid('sr'), pid, r.kind, r.min_count, r.min_width, r.min_height
          );
        } else {
          q.run(
            'UPDATE process_req_v4 SET min_count = MAX(min_count,?), min_width = MAX(min_width,?), min_height = MAX(min_height,?) WHERE id = ?',
            r.min_count, r.min_width, r.min_height, ex.id
          );
        }
      }
    }

    // 3) 内容 → item_v4。ord 重新连续编号：跨线合并后不能出现 0,1,0,1 这种。
    const cnt = new Map();
    if (hasStation) {
      const items = q.all(`
        SELECT i.*, s.model_id, s.code, COALESCE(l.sort, 0) lsort
          FROM item i
          JOIN station s ON s.id = i.station_id
          LEFT JOIN line l ON l.id = s.line_id
         ORDER BY s.model_id, s.code, COALESCE(l.sort, 0), i.ord, i.id
      `);
      for (const it of items) {
        const pid = pMap.get(`${it.model_id}|${it.code}`);
        if (!pid) continue;
        if (q.get('SELECT id FROM item_v4 WHERE process_id = ? AND media_id = ?', pid, it.media_id)) {
          dropped += 1;
          continue;
        }
        const n = cnt.get(pid) || 0;
        cnt.set(pid, n + 1);
        q.run(
          `INSERT INTO item_v4(id,model_id,process_id,ord,kind,media_id,dwell_sec,fit,zoom)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          it.id, it.model_id, pid, n, it.kind, it.media_id,
          it.dwell_sec || 10, it.fit || 'contain', it.zoom || 100
        );
      }
    }

    // 4) 可生产机种：机种在哪些线上有工位，就是它能在哪些线上做
    if (hasStation && q.get('SELECT COUNT(*) n FROM station').n > 0) {
      db.exec(`INSERT OR IGNORE INTO model_line(model_id, line_id, sort)
               SELECT model_id, line_id, 0 FROM station GROUP BY model_id, line_id`);
      // 老库没有"工位数"这一列，按这条线原来有几块屏（去重后的工序码数）回填
      db.exec(`UPDATE line SET slots = MAX(1,
                 (SELECT COUNT(DISTINCT code) FROM station WHERE line_id = line.id))`);
    }

    // 5) 换表。老表整个丢掉 —— 迁移前 openDb 已复制过整库备份
    db.exec('DROP TABLE IF EXISTS item');
    db.exec('DROP TABLE IF EXISTS station_req');
    db.exec('DROP TABLE IF EXISTS station');
    db.exec('DROP TABLE IF EXISTS process');
    db.exec('ALTER TABLE process_v4 RENAME TO process');
    db.exec('ALTER TABLE process_req_v4 RENAME TO process_req');
    db.exec('ALTER TABLE item_v4 RENAME TO item');

    db.exec('CREATE INDEX IF NOT EXISTS idx_process_model ON process(model_id, sort, code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_ps ON item(model_id, process_id, ord)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_item_media ON item(media_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_station_batch ON process(import_batch)');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚过 */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');

  console.log(`[db] 已升级到 4.0.0：工位并入工序（合并 ${merged} 个跨线工位，去重 ${dropped} 条内容）`);
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

// ---------- 客户端（屏）与工序绑定 ----------
/**
 * 心跳：登记 / 刷新一台客户端。id 现在就是 IP。
 *
 * 为什么 id 用 IP：终端 1.7.1 本来就每 5 秒发一次 telemetry，服务端从 socket 就能
 * 拿到地址，**终端一行不用改**就能进这张表。代价写在明处：DHCP 换了地址就算新设备，
 * 原来的绑定要重做。等终端下次出包上报计算机名，列表里就按名字显示，id 仍是 IP。
 *
 * name / ver / res 用"有值才覆盖"：老终端不报计算机名，不能让空串把之前存的抹掉。
 */
export function upsertClient({ ip, name, lineCode, opCode, ver, res }) {
  const id = String(ip || '').trim();
  if (!id) return null;
  const t = now();
  q.run(
    `INSERT INTO client(id, ip, name, line_code, op_code, ver, res, first_seen, last_seen)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name      = CASE WHEN excluded.name <> '' THEN excluded.name ELSE client.name END,
       line_code = excluded.line_code,
       op_code   = excluded.op_code,
       ver       = CASE WHEN excluded.ver <> '' THEN excluded.ver ELSE client.ver END,
       res       = CASE WHEN excluded.res <> '' THEN excluded.res ELSE client.res END,
       last_seen = excluded.last_seen`,
    id, id, str(name, 64), str(lineCode, 16), str(opCode, 16), str(ver, 24), str(res, 24), t, t
  );
  return q.get('SELECT * FROM client WHERE id = ?', id);
}

/** 全部客户端，最近有心跳的排前面 */
export function clients() {
  return q.all('SELECT * FROM client ORDER BY last_seen DESC');
}

export function clientOf(id) {
  return q.get('SELECT * FROM client WHERE id = ?', String(id || ''));
}

/** 这道工序绑的是哪台屏 */
export function bindOfProcess(lineId, processCode) {
  return q.get('SELECT * FROM client_bind WHERE line_id = ? AND process_code = ?',
    String(lineId || ''), String(processCode || ''));
}

/** 这台屏被绑到哪个工位 */
export function bindOfClient(clientId) {
  return q.get('SELECT * FROM client_bind WHERE client_id = ?', String(clientId || ''));
}

export function binds(lineId = '') {
  return lineId
    ? q.all('SELECT * FROM client_bind WHERE line_id = ? ORDER BY process_code', String(lineId))
    : q.all('SELECT * FROM client_bind');
}

/**
 * 绑定：这道工序 ↔ 这台屏。
 *
 * 两条唯一纪律都在这一处落实（表上有主键和唯一索引兜底）：
 *   ① 一道工序只一台屏 —— 先解掉这道工序原来的
 *   ② 一台屏只占一个工位 —— 先解掉这台屏原来的
 *
 * **绑定不动播放**：屏上仍旧按它自己填的线号 / 工序号拉清单。绑定只是台账，
 * 以及用来发现"这台屏被改成别的工位了"。所以这里既不推 contentRev，也不碰 item。
 */
export function bindClient(clientId, lineId, processCode) {
  const cid = String(clientId || '').trim();
  const lid = String(lineId || '').trim();
  const pc = String(processCode || '').trim();
  if (!cid || !lid || !pc) throw new Error('客户端、线体、工序都不能为空');
  tx(() => {
    q.run('DELETE FROM client_bind WHERE client_id = ?', cid);
    q.run('DELETE FROM client_bind WHERE line_id = ? AND process_code = ?', lid, pc);
    q.run('INSERT INTO client_bind(line_id, process_code, client_id, bound_at) VALUES(?,?,?,?)',
      lid, pc, cid, now());
  });
  return bindOfProcess(lid, pc);
}

export function unbindClient(clientId) {
  return q.run('DELETE FROM client_bind WHERE client_id = ?', String(clientId || '')).changes;
}

export function unbindProcess(lineId, processCode) {
  return q.run('DELETE FROM client_bind WHERE line_id = ? AND process_code = ?',
    String(lineId || ''), String(processCode || '')).changes;
}

// ---------- 线体 ----------
export function lines() {
  return q.all('SELECT * FROM line ORDER BY sort, code');
}

/** 线体的四种状态。running 才让终端读它，其余三种都按"没在跑"处理。 */
export const LINE_STATUS = ['running', 'stopped', 'maintain', 'care'];

/**
 * 设线体状态。enabled 由 status 派生，老代码（终端、switch、activeLine）继续读 enabled。
 *
 * v3.5.0 起**允许多条线同时 running** —— 现场每条线有自己的终端，各带 ?line=，
 * 互不干扰。只有不带 line 参数的老终端会按 sort 取第一条，这是它自己的事。
 */
export function setLineStatus(lineId, status) {
  const s = LINE_STATUS.includes(status) ? status : 'stopped';
  tx(() => {
    q.run('UPDATE line SET status = ?, enabled = ? WHERE id = ?', s, s === 'running' ? 1 : 0, lineId);
    // 不在跑的时候清掉排产：留着会让下次启用时看见一条过期的"下一炉"
    if (s !== 'running') q.run("UPDATE line_state SET next_model_id = '' WHERE line_id = ?", lineId);
  });
  return q.get('SELECT * FROM line WHERE id = ?', lineId);
}

/** 排产：给这条线定一个"下一个要生产的机种"。传空字符串 = 取消排产。 */
export function setNextModel(lineId, modelId) {
  const mid = String(modelId || '');
  if (mid) {
    const m = q.get('SELECT id FROM model WHERE id = ?', mid);
    if (!m) throw new Error('机种不存在');
    if (q.get('SELECT COALESCE(current_model_id,\'\') c FROM line_state WHERE line_id = ?', lineId)?.c === mid) {
      throw new Error('这就是当前正在生产的机种，不用再排一次');
    }
  }
  q.run(
    `INSERT INTO line_state(line_id, next_model_id) VALUES(?,?)
     ON CONFLICT(line_id) DO UPDATE SET next_model_id = excluded.next_model_id`,
    lineId, mid
  );
  return mid;
}

/** 当前启用的线体。多条线同时跑时取 sort 最前的一条（不带 line 的老终端会用它）。 */
export function activeLine() {
  return q.get('SELECT * FROM line WHERE enabled = 1 ORDER BY sort, code LIMIT 1') || null;
}

export function lineById(id) {
  return q.get('SELECT * FROM line WHERE id = ?', String(id || '')) || null;
}

export function lineByCode(code) {
  return q.get('SELECT * FROM line WHERE code = ?', String(code || '').trim()) || null;
}

// ---------- 工序（v4.0.0：工序归机种，一道工序 = 一块屏的内容槽位）----------
const KINDS_ORDER = ['image', 'video', 'pdf'];

/**
 * 「播放内容」的三类，按界面上从左到右的顺序：图片 / PDF / 视频。
 * 存库是逗号列表（`process.play_kinds`），空串 = 三类全放。
 *
 * 为什么不直接复用 process_req 的类型：那是**上传闸门**（允许传什么），
 * 这是**播放闸门**（终端放什么）。现场会有"允许传 PDF 存档，但这一屏只放视频"
 * 这种需求，两个闸门分开才不会互相绑架。
 */
export const PLAY_KINDS = ['image', 'pdf', 'video'];

/**
 * 一条内容属于哪一类「播放内容」。
 *
 * ⚠️ 不能只看 media.kind：PDF 上传时就被拆成了逐页 PNG（kind='image'），
 * 所以要看 src_sha —— 带它的是从 PDF 拆出来的页，算 `pdf`；直接传的图片才算 `image`。
 * 终端只认 <img>/<video>，这条路不变，这里只是给"放不放"分类。
 */
export function playKindOf(kind, srcSha) {
  if (kind === 'video') return 'video';
  if (kind === 'image') return srcSha ? 'pdf' : 'image';
  return String(kind || '');
}

/** 存库文本 → 三类数组。空 = 全部；认不出的值直接忽略，全认不出时退回全部（不让人一存就黑屏）。 */
export function playKindsOf(text) {
  const set = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!set.length) return [...PLAY_KINDS];
  const hit = PLAY_KINDS.filter((k) => set.includes(k));
  return hit.length ? hit : [...PLAY_KINDS];
}
//
// 4.0.0 起不再有「工位」这一层。工序就是内容的宿主：
//   机种 X200 有 OP1 装配 / OP2 调试 / OP3 检验，这三道就是三块屏。
//   终端按 ?line=&op= 找到「这条线当前机种」再取同码工序，路径只有一跳。
//
// 为什么不再按线分：工艺跟着产品走，同一机种在多条线上做的是同一套工序。
// 以前每线一套工位，新建一条线要长出 机种数 × 工序数 个空壳，改一道工序要改所有线。

/**
 * 某个机种的全部工序，含要求与已上传内容。工序数在几十以内，三次查询足够。
 * 返回的字段名和 3.x 的 stationsOf 对齐（code/name/reqs/items），前端不必两套代码。
 */
export function processesOf(modelId) {
  const mid = String(modelId || '');
  const rows = q.all('SELECT * FROM process WHERE model_id = ? ORDER BY sort, code', mid);
  if (!rows.length) return [];

  const byId = new Map(rows.map((p) => [p.id, { reqs: [], items: [] }]));

  for (const r of q.all(
    `SELECT r.* FROM process_req r JOIN process p ON p.id = r.process_id WHERE p.model_id = ?`, mid
  )) {
    const box = byId.get(r.process_id);
    if (box) box.reqs.push({
      kind: r.kind, minCount: r.min_count, minWidth: r.min_width, minHeight: r.min_height
    });
  }

  for (const i of q.all(
    `SELECT i.*, m.name mname, m.bytes, m.width, m.height, m.duration_ms, m.ext, m.mime, m.src_sha
       FROM item i
       JOIN media m ON m.id = i.media_id
       JOIN process p ON p.id = i.process_id
      WHERE p.model_id = ?
      ORDER BY i.ord, i.id`, mid
  )) {
    const box = byId.get(i.process_id);
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
      // 从 PDF 拆出来的页（带 src_sha）：界面据此标「PDF 页」，
      // 播放内容也靠它区分"图片"和"PDF"——两者在库里 kind 都是 image。
      srcSha: i.src_sha || '',
      dwellSec: i.dwell_sec,
      fit: i.fit || 'contain',
      zoom: i.zoom || 100,
      url: `/m/${i.media_id}`
    });
  }

  return rows.map((p) => ({
    id: p.id,
    modelId: p.model_id,
    code: p.code,
    name: p.name,
    sort: p.sort,
    maxMb: p.max_mb,
    note: p.note,
    // loop = 播完从头再来（默认）；once = 播完停在最后一屏
    playMode: p.play_mode === 'once' ? 'once' : 'loop',
    // 工序工时（秒/件）：一道工序 = 一个工位，所以它同时是「工位工时分配」那一列的来源。
    // 0 = 还没量过，不是"零工时"—— 导出的平衡率、瓶颈产能会留空，不拿 0 去算。
    cycleSec: Math.max(0, Math.round((Number(p.cycle_sec) || 0) * 10) / 10),
    // 播放内容：终端放哪几类。空串（老工序）= 三类全放，接口回满三项，界面三格都勾上。
    playKinds: playKindsOf(p.play_kinds),
    reqs: byId.get(p.id).reqs.sort(
      (a, b) => KINDS_ORDER.indexOf(a.kind) - KINDS_ORDER.indexOf(b.kind)
    ),
    items: byId.get(p.id).items
  }));
}

export function processById(id) {
  return q.get('SELECT * FROM process WHERE id = ?', String(id || '')) || null;
}

/** 机种 × 工序码，终端取内容就靠这一个查询。 */
export function processByCode(modelId, code) {
  return q.get('SELECT * FROM process WHERE model_id = ? AND code = ?',
    String(modelId || ''), String(code || '')) || null;
}

/**
 * 整份替换一道工序的元信息、类型要求与内容清单。
 * 六块各判 `!== undefined`：界面分「改名字」「改要求」「改内容」三次发，互不覆盖。
 */
export function saveProcess(modelId, processId, { name, maxMb, note, playMode, cycleSec, playKinds, reqs, items }) {
  tx(() => {
    const p = q.get('SELECT * FROM process WHERE id = ? AND model_id = ?', processId, modelId);
    if (!p) throw Object.assign(new Error('工序不存在'), { status: 400 });

    if (name !== undefined) q.run('UPDATE process SET name = ? WHERE id = ?', str(name, 40) || p.code, p.id);
    if (maxMb !== undefined) q.run('UPDATE process SET max_mb = ? WHERE id = ?', int(maxMb, 0), p.id);
    if (note !== undefined) q.run('UPDATE process SET note = ? WHERE id = ?', str(note, 200), p.id);
    // 工时按 0.1 秒取整：现场拿秒表量出来的是 8.6 这种数，硬转整数把 0.4 抹掉没道理。
    // 上限 24 小时 —— 填 99999 多半是手滑，留着会把平衡率的量纲带歪。
    if (cycleSec !== undefined) {
      const sec = Math.round((Number(cycleSec) || 0) * 10) / 10;
      q.run('UPDATE process SET cycle_sec = ? WHERE id = ?', Math.min(86400, Math.max(0, sec)), p.id);
    }
    if (playMode !== undefined) {
      q.run('UPDATE process SET play_mode = ? WHERE id = ?',
        playMode === 'once' ? 'once' : 'loop', p.id);
    }
    if (playKinds !== undefined) {
      // 三样全选 = 没限制，存空串（和"从来没配过"一个意思），导出与前后对比都按未配置算。
      // 一样都不勾没有意义（这块屏就什么都不放了），直接拒，别让它变成"悄悄不播"。
      const picked = PLAY_KINDS.filter((k) => Array.isArray(playKinds) && playKinds.includes(k));
      if (!picked.length) throw Object.assign(new Error('播放内容至少要留一类'), { status: 400 });
      q.run('UPDATE process SET play_kinds = ? WHERE id = ?',
        picked.length === PLAY_KINDS.length ? '' : picked.join(','), p.id);
    }

    if (Array.isArray(reqs)) {
      q.run('DELETE FROM process_req WHERE process_id = ?', p.id);
      for (const r of reqs) {
        if (!KINDS.includes(r.kind)) continue;
        q.run(
          'INSERT OR IGNORE INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
          uid('sr'), p.id, r.kind, int(r.minCount, 0), int(r.minWidth, 0), int(r.minHeight, 0)
        );
      }
    }

    if (Array.isArray(items)) {
      // 两道闸：没有要求行 = 这道工序不接受这类文件；超过单文件上限也拒。
      // 空 reqs 表示"还没配要求"，此时不锁类型，否则升级上来的老工序传不进东西。
      const allowed = q.all('SELECT kind FROM process_req WHERE process_id = ?', p.id).map((r) => r.kind);
      const limit = p.max_mb;

      q.run('DELETE FROM item WHERE model_id = ? AND process_id = ?', modelId, p.id);
      items.forEach((it, i) => {
        const mediaId = String(it.mediaId || '');
        const m = q.get('SELECT * FROM media WHERE id = ?', mediaId);
        if (!m) throw Object.assign(new Error(`内容里有不存在的文件（${mediaId}）`), { status: 400 });
        // 类型闸门按「内容是哪一类」比，不按 media.kind 比：
        // PDF 页的 kind 是 image，只勾了「PDF」的工序以前会被自己的 PDF 页顶回去。
        const cls = playKindOf(m.kind, m.src_sha);
        if (allowed.length && !allowed.includes(cls)) {
          const cn = cls === 'video' ? '视频' : cls === 'pdf' ? ' PDF' : '图片';
          throw Object.assign(new Error(`这道工序不允许放${cn}：${m.name}`), { status: 400 });
        }
        if (limit > 0 && m.bytes > limit * 1024 * 1024) {
          throw Object.assign(new Error(`文件超过 ${limit} MB：${m.name}`), { status: 400 });
        }
        q.run(
          `INSERT OR IGNORE INTO item(id,model_id,process_id,ord,kind,media_id,dwell_sec,fit,zoom)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          uid('it'), modelId, p.id, i, m.kind, mediaId,
          Math.min(120, Math.max(1, int(it.dwellSec, 10))),
          it.fit === 'cover' ? 'cover' : 'contain',
          Math.min(200, Math.max(50, int(it.zoom, 100)))
        );
      });
    }
  });
}

// ---------- 可生产机种（机种 × 线体）----------
export function modelLines(modelId) {
  return q.all(
    `SELECT l.* FROM model_line ml JOIN line l ON l.id = ml.line_id
      WHERE ml.model_id = ? ORDER BY l.sort, l.code`, String(modelId || '')
  );
}

/** 整批覆盖：传进来的线体就是全部，没传的取消关联。 */
export function setModelLines(modelId, lineIds) {
  const ids = [...new Set((lineIds || []).map((x) => String(x)).filter(Boolean))];
  tx(() => {
    q.run('DELETE FROM model_line WHERE model_id = ?', modelId);
    ids.forEach((lid, i) => {
      if (!q.get('SELECT id FROM line WHERE id = ?', lid)) return;
      q.run('INSERT OR IGNORE INTO model_line(model_id, line_id, sort) VALUES(?,?,?)', modelId, lid, i);
    });
  });
  return modelLines(modelId);
}

/** 这条线能生产哪些机种 —— 线体表格里的「可生产机种」就是它的数量。 */
export function modelsOfLine(lineId) {
  return q.all(
    `SELECT m.* FROM model_line ml JOIN model m ON m.id = ml.model_id
      WHERE ml.line_id = ? ORDER BY m.sort, m.code`, String(lineId || '')
  );
}

// ---------- 种子数据 ----------
// 10 个型号、5 道工序，全部为空清单 —— 完成度从 0/50 开始，等工程部填。
// 型号与工序名都是占位：型号可在界面改名/停用，工序名可改。
export const SEED_MODELS = [
  ['X200', 'X200 型'], ['X210', 'X210 型'], ['X220', 'X220 型'], ['X230', 'X230 型'],
  ['X240', 'X240 型'], ['X250', 'X250 型'], ['X260', 'X260 型'], ['X270', 'X270 型'],
  ['X280', 'X280 型'], ['X290', 'X290 型']
];

// v4.0.0 起工序码从 OP1 起编：现场的屏是 1 号、2 号、3 号，不是 10、20、30。
export const SEED_PROCESSES = [
  ['OP1', '装配'],
  ['OP2', '调试'],
  ['OP3', '检验'],
  ['OP4', '包装'],
  ['OP5', '入库']
];

// 新机种的默认工序名：现场最常见的五道，超出部分用「工序6」兜底。
// 用户明确要求建机种时就把名称填上（装配/调试/检验），建完还能在工序表里逐道改。
export const DEFAULT_PROC_NAMES = ['装配', '调试', '检验', '包装', '入库'];

/**
 * 给机种铺 count 道工序（默认 OP1..OPn），名称取 DEFAULT_PROC_NAMES。
 * 新建机种时弹窗里问"几道工序"，就是调这个。
 */
export function createDefaultProcesses(modelId, count = 5, names = []) {
  const n = Math.min(60, Math.max(1, int(count, 5)));
  const t = now();
  let made = 0;
  for (let i = 1; i <= n; i += 1) {
    const code = `OP${i}`;
    if (q.get('SELECT id FROM process WHERE model_id = ? AND code = ?', modelId, code)) continue;
    const id = uid('pr');
    q.run(
      'INSERT INTO process(id,model_id,code,name,sort,max_mb,note,play_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, modelId, code, str(names[i - 1] || DEFAULT_PROC_NAMES[i - 1] || `工序${i}`, 40), i * 10, 20, '', 'loop', t
    );
    // 和界面上「+ 加工序」建出来的一致：默认允许图片、至少 1 张
    q.run(
      'INSERT OR IGNORE INTO process_req(id,process_id,kind,min_count,min_width,min_height) VALUES(?,?,?,?,?,?)',
      uid('sr'), id, 'image', 1, 1280, 720
    );
    made += 1;
  }
  return made;
}

export function seed() {
  // 只要已经有机种就不撒种子 —— 现场把自己的机种删空后不该又冒出十个 X2xx。
  if (q.get('SELECT id FROM model LIMIT 1')) return { created: false };

  const t = now();
  const ids = [];
  const dftLine = q.get('SELECT id FROM line ORDER BY sort, code LIMIT 1');
  tx(() => {
    SEED_MODELS.forEach(([code, name], i) => {
      const id = uid('md');
      ids.push(id);
      q.run('INSERT INTO model(id,code,name,enabled,sort,created_at) VALUES(?,?,?,?,?,?)',
        id, code, name, 1, i * 10, t);
      // 种子机种默认安排在一线上，否则「可生产机种」全是 0，一进去就像没配好
      if (dftLine) q.run('INSERT OR IGNORE INTO model_line(model_id,line_id,sort) VALUES(?,?,?)', id, dftLine.id, i);
    });
  });
  // 建工序要在事务外：createDefaultProcesses 内部逐条写，套事务没必要但也不冲突，
  // 这里分开只是保持"一个事务一件事"的习惯。
  const names = SEED_PROCESSES.map(([, n]) => n);
  for (const id of ids) createDefaultProcesses(id, SEED_PROCESSES.length, names);

  return { created: true, models: ids.length, processes: SEED_PROCESSES.length };
}

// ---------- 完成度 ----------
// 一套 = (机种 × 工序) 里至少有一条内容。分母 = 全部机种的工序数之和。
//
// 返回 { total, done, byModel: {modelId: {done, total}}, cells: {"modelId:processId": count} }
export function coverage() {
  const models = q.all('SELECT * FROM model ORDER BY sort, code');

  const counts = new Map(
    q.all(`
      SELECT p.model_id, p.code, COUNT(i.id) n
        FROM process p LEFT JOIN item i ON i.process_id = p.id
       GROUP BY p.model_id, p.code
    `).map((r) => [`${r.model_id}|${r.code}`, r.n])
  );
  const procsOf = new Map();
  for (const p of q.all('SELECT id, model_id, code, sort FROM process ORDER BY model_id, sort, code')) {
    if (!procsOf.has(p.model_id)) procsOf.set(p.model_id, []);
    procsOf.get(p.model_id).push(p);
  }

  const byModel = {};
  const cells = {};
  let done = 0;
  let total = 0;
  for (const m of models) {
    const list = procsOf.get(m.id) || [];
    let d = 0;
    for (const p of list) {
      const n = counts.get(`${m.id}|${p.code}`) || 0;
      cells[`${m.id}:${p.id}`] = n;
      if (n > 0) { d++; done++; }
    }
    byModel[m.id] = { done: d, total: list.length };
    total += list.length;
  }

  return { total, done, byModel, cells };
}

// ---------- 通用 ----------
export const KINDS = ['image', 'video', 'pdf'];

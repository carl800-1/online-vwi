// 数据层：内置 node:sqlite，无第三方依赖
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { now, uid, sha256Buf } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 产线：一台服务器可以管多条线
CREATE TABLE IF NOT EXISTS line (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  note        TEXT DEFAULT '',
  active_release_id TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- 看板：工位显示什么。一个看板可被多个工位共用（如线首总览屏）
CREATE TABLE IF NOT EXISTS board (
  id          TEXT PRIMARY KEY,
  line_id     TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  note        TEXT DEFAULT '',
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_board_line ON board(line_id);

-- 页：看板内的有序页面
CREATE TABLE IF NOT EXISTS page (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL DEFAULT 0,
  layout      TEXT NOT NULL DEFAULT 'stack',
  title       TEXT DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 20,
  blocks      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_page_board ON page(board_id, ord);

-- 工位：物理位置 + 绑定终端
CREATE TABLE IF NOT EXISTS station (
  id            TEXT PRIMARY KEY,
  line_id       TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  board_id      TEXT,
  op_no         TEXT DEFAULT '',
  screen_w      INTEGER DEFAULT 1920,
  screen_h      INTEGER DEFAULT 1080,
  override_release_id TEXT,
  last_seen     INTEGER DEFAULT 0,
  last_ip       TEXT DEFAULT '',
  last_seq      INTEGER DEFAULT 0,
  app_version   TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_line ON station(line_id);

-- 发布单：不可变快照。发布后只能新增，不能改
CREATE TABLE IF NOT EXISTS release (
  id          TEXT PRIMARY KEY,
  line_id     TEXT NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT DEFAULT '',
  manifest    TEXT NOT NULL,
  digest      TEXT NOT NULL,
  media_count INTEGER DEFAULT 0,
  byte_size   INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT DEFAULT '',
  revoked_at  INTEGER DEFAULT 0,
  UNIQUE(line_id, seq)
);

-- 工单：开工时把发布单锁死，中途改版不影响在制
CREATE TABLE IF NOT EXISTS workorder (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  product     TEXT NOT NULL DEFAULT '',
  line_id     TEXT NOT NULL REFERENCES line(id),
  plan_qty    INTEGER DEFAULT 0,
  done_qty    INTEGER DEFAULT 0,
  release_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  note        TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  started_at  INTEGER DEFAULT 0,
  closed_at   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wo_line ON workorder(line_id, status);

-- 媒体：按内容寻址，同一文件只存一份
CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,            -- sha256 前 16 位，充当公开短 ID
  sha256      TEXT NOT NULL UNIQUE,
  ext         TEXT NOT NULL DEFAULT 'bin',
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0,
  name        TEXT DEFAULT '',
  kind        TEXT DEFAULT 'file',         -- image / video / file
  created_at  INTEGER NOT NULL,
  created_by  TEXT DEFAULT ''
);

-- 播放日志：不做按天分表，靠时间索引 + 归档
CREATE TABLE IF NOT EXISTS play_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  TEXT NOT NULL,
  board_id    TEXT DEFAULT '',
  page_id     TEXT DEFAULT '',
  page_title  TEXT DEFAULT '',
  block_id    TEXT DEFAULT '',
  release_id  TEXT DEFAULT '',
  wo_code     TEXT DEFAULT '',
  started_at  INTEGER NOT NULL,
  dwell_ms    INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  client_id   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_play_time ON play_log(started_at);
CREATE INDEX IF NOT EXISTS idx_play_station ON play_log(station_id, started_at);

-- 事件日志：上线、掉线、同步、指令、错误
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  station_id  TEXT DEFAULT '',
  msg         TEXT DEFAULT '',
  data        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_event_time ON event_log(at);

-- 下发指令：重启、切页、静音、截屏请求等。落库保证重启不丢
CREATE TABLE IF NOT EXISTS command (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  picked_at   INTEGER DEFAULT 0,
  result      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cmd_station ON command(station_id, picked_at);

-- 终端注册访问令牌：终端用 code + token 拉内容，不给终端开账号
CREATE TABLE IF NOT EXISTS station_token (
  token       TEXT PRIMARY KEY,
  station_id  TEXT NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
`;

let db = null;
let dataDir = '';

export function openDb(dir) {
  dataDir = dir;
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  db = new DatabaseSync(path.join(dir, 'vwi.db'));
  db.exec(SCHEMA);
  return db;
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

// ---------- 种子数据 ----------
export function seed() {
  const exists = q.get('SELECT id FROM line LIMIT 1');
  if (exists) return { created: false };

  const t = now();

  const lineId = uid('ln');
  q.run('INSERT INTO line(id,code,name,note,created_at) VALUES(?,?,?,?,?)',
    lineId, 'L01', '总装一线', '示例产线，可直接改名或在界面上删除', t);

  const demos = [
    {
      code: 'L01-OP10', name: 'OP10 壳体上料', op: '10',
      pages: [
        {
          layout: 'step-focus', title: '第 1 步 · 确认来料与工装', duration: 20,
          blocks: [
            { type: 'heading', slot: 'head', text: '确认来料与工装' },
            { type: 'text', slot: 'main', text: '取用 A 型壳体，检查外观无划伤、无变形。将壳体放入定位工装，听到"咔"声表示到位。' },
            { type: 'param', slot: 'side', text: '壳体型号', value: 'HX-A200' },
            { type: 'param', slot: 'side', text: '工装编号', value: 'FM-OP10-01' },
            { type: 'warn', slot: 'side', level: 'L2', text: '壳体反面有防呆缺口，装反会压伤定位销' }
          ]
        },
        {
          layout: 'step-focus', title: '第 2 步 · 扫码绑定', duration: 15,
          blocks: [
            { type: 'heading', slot: 'head', text: '扫码绑定工单' },
            { type: 'text', slot: 'main', text: '用扫码枪扫描壳体条码，屏幕右上角显示工单号即为绑定成功。扫码失败时手动输入后 6 位。' },
            { type: 'warn', slot: 'side', level: 'L1', text: '未绑定工单严禁流入下道工序' }
          ]
        }
      ]
    },
    {
      code: 'L01-OP30', name: 'OP30 电机装配', op: '30',
      pages: [
        {
          layout: 'step-focus', title: '第 1 步 · 装配前检查', duration: 20,
          blocks: [
            { type: 'heading', slot: 'head', text: '装配前检查' },
            { type: 'text', slot: 'main', text: '核对电机铭牌型号与工单一致；定子引线无破损；轴承端面清洁无异物。' },
            { type: 'param', slot: 'side', text: '电机型号', value: 'M-750W' },
            { type: 'param', slot: 'side', text: '扭矩设定', value: '8.5 N·m' }
          ]
        },
        {
          layout: 'step-focus', title: '第 2 步 · 拧紧四颗螺栓', duration: 30,
          blocks: [
            { type: 'heading', slot: 'head', text: '对角拧紧四颗螺栓' },
            { type: 'text', slot: 'main', text: '按 1→3→2→4 对角顺序拧紧。电动扳手扭矩到达会自动鸣叫，听到鸣叫后松手，禁止补拧。' },
            { type: 'param', slot: 'side', text: '目标扭矩', value: '8.5 N·m ±0.5' },
            { type: 'warn', slot: 'side', level: 'L1', text: '顺序错误会导致端盖变形漏油' },
            { type: 'warn', slot: 'side', level: 'L2', text: '扭矩枪每月校验，超期使用需报备' }
          ]
        },
        {
          layout: 'step-focus', title: '第 3 步 · 自检与报工', duration: 15,
          blocks: [
            { type: 'heading', slot: 'head', text: '自检与报工' },
            { type: 'text', slot: 'main', text: '手动转动输出轴，应顺畅无卡滞。确认无误后在终端点击"完成本件"，数量自动上报工单。' },
            { type: 'warn', slot: 'side', level: 'L3', text: '异常件放红色返修框，不要混入合格品' }
          ]
        }
      ]
    },
    {
      code: 'L01-OP50', name: 'OP50 终检', op: '50',
      pages: [
        {
          layout: 'step-focus', title: '终检项目', duration: 25,
          blocks: [
            { type: 'heading', slot: 'head', text: '终检项目' },
            { type: 'text', slot: 'main', text: '外观 → 空载电流 → 噪音 → 铭牌。四项全部合格后贴合格标，进入包装。' },
            { type: 'param', slot: 'side', text: '空载电流', value: '≤ 1.2 A' },
            { type: 'param', slot: 'side', text: '噪音', value: '≤ 62 dB' }
          ]
        }
      ]
    }
  ];

  for (const d of demos) {
    const boardId = uid('bd');
    q.run('INSERT INTO board(id,line_id,name,note,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
      boardId, lineId, d.name, '', t, '');
    d.pages.forEach((p, i) => {
      q.run('INSERT INTO page(id,board_id,ord,layout,title,duration,blocks) VALUES(?,?,?,?,?,?,?)',
        uid('pg'), boardId, i, p.layout, p.title, p.duration, JSON.stringify(p.blocks));
    });
    q.run('INSERT INTO station(id,line_id,code,name,board_id,op_no,created_at) VALUES(?,?,?,?,?,?,?)',
      uid('st'), lineId, d.code, d.name, boardId, d.op, t);
  }

  return { created: true };
}

export function sha256Text(s) {
  return sha256Buf(Buffer.from(s, 'utf8'));
}

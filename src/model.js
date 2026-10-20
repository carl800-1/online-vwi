// 内容契约：布局、块类型、清洗与校验。服务端与两端唯一共享的约定都在这里。
import { q } from './db.js';
import { str, int, clamp, uid, stableStringify, sha256Buf, parseJson } from './util.js';

/** 布局 -> 允许的槽位。服务端只认这个表，具体像素排布由渲染端决定 */
export const LAYOUTS = {
  stack: ['head', 'main', 'side'],
  'step-focus': ['head', 'main', 'side'],
  split: ['head', 'left', 'right'],
  'video-focus': ['head', 'stage', 'foot'],
  grid: ['head', 'c1', 'c2', 'c3', 'c4']
};

export const LAYOUT_LABEL = {
  stack: '单列',
  'step-focus': '步骤主视图（VWI 主力）',
  split: '左图右文',
  'video-focus': '视频全屏',
  grid: '四宫格'
};

export const BLOCK_TYPES = [
  'heading', 'text', 'param', 'warn', 'image', 'video', 'list', 'clock', 'qr', 'spacer'
];

export const BLOCK_LABEL = {
  heading: '标题',
  text: '正文',
  param: '关键参数',
  warn: '警示',
  image: '图片',
  video: '视频',
  list: '清单',
  clock: '时钟',
  qr: '二维码',
  spacer: '留白'
};

export const WARN_LEVELS = ['L1', 'L2', 'L3'];

function cleanList(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).map((s) => str(s, 200)).filter(Boolean);
}

/** 按类型白名单清洗单个块，未知字段一律丢弃 */
export function sanitizeBlock(raw) {
  const type = String(raw && raw.type || '');
  if (!BLOCK_TYPES.includes(type)) throw new Error(`未知的块类型：${type}`);
  const b = { id: str(raw.id, 40) || uid('bk'), type, slot: str(raw.slot, 20) || 'main' };

  if (type === 'heading' || type === 'text') {
    b.text = str(raw.text, 2000);
  } else if (type === 'param') {
    b.text = str(raw.text || raw.label, 100);
    b.value = str(raw.value, 200);
  } else if (type === 'warn') {
    b.level = WARN_LEVELS.includes(raw.level) ? raw.level : 'L2';
    b.text = str(raw.text, 500);
  } else if (type === 'image') {
    b.mediaId = str(raw.mediaId, 40);
    b.fit = raw.fit === 'cover' ? 'cover' : 'contain';
    b.caption = str(raw.caption, 200);
  } else if (type === 'video') {
    b.mediaId = str(raw.mediaId, 40);
    b.loop = !!raw.loop;
    b.mute = raw.mute !== false;
    b.startSec = clamp(raw.startSec || 0, 0, 86400);
  } else if (type === 'list') {
    b.items = cleanList(raw.items);
  } else if (type === 'clock') {
    b.format = str(raw.format, 20) || 'HH:mm:ss';
  } else if (type === 'qr') {
    b.value = str(raw.value, 500);
  }
  return b;
}

/** 清洗一页，并校验槽位是否属于该布局 */
export function sanitizePage(raw, ord) {
  const layout = LAYOUTS[raw.layout] ? raw.layout : 'stack';
  const slots = LAYOUTS[layout];
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .slice(0, 30)
    .map((b) => {
      const blk = sanitizeBlock(b);
      if (!slots.includes(blk.slot)) blk.slot = slots[Math.min(1, slots.length - 1)];
      return blk;
    });
  return {
    id: str(raw.id, 40) || uid('pg'),
    ord,
    layout,
    title: str(raw.title, 120),
    duration: clamp(raw.duration || 20, 3, 600),
    blocks
  };
}

/** 发布前预检：返回问题清单，空数组才允许发布 */
export function preflight(lineId) {
  const problems = [];
  const boards = q.all('SELECT * FROM board WHERE line_id = ?', lineId);
  const stations = q.all('SELECT * FROM station WHERE line_id = ?', lineId);

  if (!stations.length) problems.push('该产线下没有工位，发布出去没有人接收');
  if (!boards.length) problems.push('该产线下没有看板');

  for (const s of stations) {
    if (!s.board_id) problems.push(`工位 ${s.code} 未绑定看板`);
    else if (!boards.some((b) => b.id === s.board_id)) problems.push(`工位 ${s.code} 绑定的看板不存在`);
  }

  for (const b of boards) {
    const pages = q.all('SELECT * FROM page WHERE board_id = ? ORDER BY ord', b.id);
    if (!pages.length) {
      problems.push(`看板「${b.name}」没有任何页面`);
      continue;
    }
    // 只检查真正被工位引用的看板
    const used = stations.some((s) => s.board_id === b.id);
    if (!used) continue;

    pages.forEach((p, i) => {
      const label = `「${b.name}」第 ${i + 1} 页`;
      if (!p.title.trim()) problems.push(`${label} 缺少标题`);
      const blocks = parseJson(p.blocks, []);
      if (!blocks.length) problems.push(`${label} 没有任何内容块`);
      for (const blk of blocks) {
        if ((blk.type === 'image' || blk.type === 'video') && !blk.mediaId) {
          problems.push(`${label} 的${BLOCK_LABEL[blk.type] || '媒体'}块没有选择文件`);
        }
        if (blk.type === 'image' || blk.type === 'video') {
          if (blk.mediaId && !q.get('SELECT id FROM media WHERE id = ?', blk.mediaId)) {
            problems.push(`${label} 引用的媒体 ${blk.mediaId} 已不存在`);
          }
        }
        if (blk.type === 'warn' && !String(blk.text || '').trim()) {
          problems.push(`${label} 的警示块内容为空`);
        }
      }
    });
  }
  return [...new Set(problems)];
}

/** 生成整条产线的内容快照（发布单的 manifest 主体） */
export function buildSnapshot(lineId) {
  const boards = q.all('SELECT * FROM board WHERE line_id = ?', lineId);
  const stations = q.all('SELECT * FROM station WHERE line_id = ?', lineId);
  const mediaIds = new Set();
  const boardSnap = {};

  for (const b of boards) {
    const pages = q.all('SELECT * FROM page WHERE board_id = ? ORDER BY ord', b.id).map((p) => {
      const blocks = parseJson(p.blocks, []);
      for (const blk of blocks) if (blk.mediaId) mediaIds.add(blk.mediaId);
      return {
        id: p.id, ord: p.ord, layout: p.layout, title: p.title,
        duration: p.duration, blocks
      };
    });
    boardSnap[b.id] = { id: b.id, name: b.name, pages };
  }

  const media = {};
  for (const id of mediaIds) {
    const m = q.get('SELECT id,sha256,ext,mime,size FROM media WHERE id = ?', id);
    if (m) media[id] = { sha256: m.sha256, ext: m.ext, mime: m.mime, size: m.size };
  }

  const stationSnap = {};
  for (const s of stations) {
    stationSnap[s.code] = {
      id: s.id, code: s.code, name: s.name, opNo: s.op_no || '',
      boardId: s.board_id || ''
    };
  }

  const body = { lineId, boards: boardSnap, stations: stationSnap, media };
  body.digest = 'sha256:' + sha256Buf(Buffer.from(stableStringify({ boards: boardSnap, stations: stationSnap, media }), 'utf8')).slice(0, 32);
  return body;
}

/** 把整线快照裁剪成某个工位需要的部分（终端只下载自己那份） */
export function sliceForStation(snapshot, station, signUrl) {
  const info = snapshot.stations[station.code];
  const board = info ? snapshot.boards[info.boardId] : null;
  if (!board) return null;

  const media = {};
  for (const [id, m] of Object.entries(snapshot.media)) {
    media[id] = { ...m, url: signUrl(id) };
  }

  return {
    releaseId: snapshot.releaseId || '',
    seq: snapshot.seq || 0,
    digest: snapshot.digest,
    station: { code: station.code, name: station.name, opNo: station.op_no || '' },
    board: { id: board.id, name: board.name },
    pages: board.pages,
    media
  };
}

export function layoutMeta() {
  return {
    layouts: Object.entries(LAYOUTS).map(([k, slots]) => ({ key: k, label: LAYOUT_LABEL[k], slots })),
    blocks: BLOCK_TYPES.map((k) => ({ key: k, label: BLOCK_LABEL[k] })),
    warnLevels: WARN_LEVELS
  };
}

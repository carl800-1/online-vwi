// 工序表导入：先解析成行给界面看，确认之后再整批写库。
//
// 为什么分两步：工艺表是现场自己做的，格式千差万别（有表头没表头、三列四列、
// 序号列在最前）。直接解析即入库，一旦列错位就得一条条删回来；先预览一眼，
// 发现不对就换个文件，什么都不用收拾。
import { q, tx, stationsOf, ensureStation } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { notifyContentChanged } from '../switch.js';
import { now, str } from '../util.js';
import { parseSheet } from '../xlsx.js';

/** 工序码：字母或数字开头，允许 - _ . 。中文工序码现场也有，所以不强制字母 */
const CODE_RE = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]{0,15}$/;

function readBuf(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(badRequest('文件太大（上限 8 MB），工序表一般几十 KB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 首行是不是标题行：看着不像工序码就当标题丢掉 */
function looksLikeHeader(cell) {
  const v = String(cell || '').trim();
  if (!v) return true;
  if (/^(code|op|no\.?|序号|工序|编号|名称)/i.test(v)) return true;
  return !/^[\w\u4e00-\u9fa5]/.test(v);
}

export function register(router) {
  // 第一步：只解析，不落库
  router.post('/api/import/parse', async (req, res, ctx) => {
    let filename = 'workbook.xlsx';
    try { filename = decodeURIComponent(String(ctx.query.filename || filename)); } catch { /* 明文就用原样 */ }

    const buf = await readBuf(req);
    if (!buf.length) throw badRequest('文件是空的');

    let rows;
    try {
      rows = parseSheet(buf);
    } catch (e) {
      throw badRequest(e.message || '读不出这个文件，请确认是 .xlsx 或 .csv');
    }
    if (!rows.length) throw badRequest('这张表里没有读到任何内容');

    const header = looksLikeHeader(rows[0][0]) ? rows[0] : null;
    const body = header ? rows.slice(1) : rows;
    if (!body.length) throw badRequest('只有标题行，没有工序数据');

    sendJson(res, 200, {
      filename,
      header,
      total: body.length,
      // 预览只回前 12 行：界面弹窗里看个样子就够，整表可能在几百行
      preview: body.slice(0, 12),
      rows: body
    });
  });

  // 第二步：按确认过的行批量建/更新
  router.post('/api/stations/import', async (req, res) => {
    const body = await readJsonBody(req);
    const modelId = String(body.modelId || '').trim();
    const lineId = String(body.lineId || '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const mode = body.mode === 'update' ? 'update' : 'merge';

    const model = q.get('SELECT * FROM model WHERE id = ?', modelId);
    if (!model) throw badRequest('机种不存在');
    const line = q.get('SELECT * FROM line WHERE id = ?', lineId);
    if (!line) throw badRequest('线体不存在');
    if (!rows.length) throw badRequest('没有可导入的行');

    const stat = { created: 0, updated: 0, skipped: 0, bad: [] };
    const ts = now();

    // 整批一个事务：中途出错整批回滚，不会留下"导了一半"的工序表
    tx(() => {
      rows.forEach((r, i) => {
        const cell = (n) => str(Array.isArray(r) ? r[n] : r[['code', 'name', 'note'][n]], 200);
        const code = cell(0).trim().toUpperCase();
        const name = cell(1).trim();
        const note = cell(2).trim();

        if (!code) { stat.bad.push(`第 ${i + 1} 行：没有工序码`); return; }
        if (!CODE_RE.test(code)) { stat.bad.push(`第 ${i + 1} 行「${code}」：工序码里有不支持的字符`); return; }

        const old = q.get('SELECT * FROM station WHERE model_id = ? AND line_id = ? AND code = ?',
          modelId, lineId, code);

        if (!old) {
          // ensureStation 自己算 sort（排在最后），顺便把码规范化
          ensureStation(modelId, lineId, code, name || code, undefined, undefined, note, ts);
          stat.created += 1;
        } else if (mode === 'update') {
          q.run('UPDATE station SET name = ?, note = ? WHERE id = ?',
            str(name || old.name, 40), str(note, 200), old.id);
          stat.updated += 1;
        } else {
          stat.skipped += 1;
        }
      });
    });

    if (stat.created || stat.updated) notifyContentChanged();
    sendJson(res, 200, { ...stat, stations: stationsOf(modelId, lineId) });
  });
}

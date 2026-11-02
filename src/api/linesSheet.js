// 线体清单的 Excel 导入 / 导出。
//
// 与工序那条链（api/import.js + api/export.js）同构：导出一份表 → 在 Excel 里改
// → 整份导回，先解析预览、确认了才写库。两步而不是"选中文件即入库"，理由和工序一样：
// 线体表是现场自己拼的，列一错位（把工位数填进名称列）一导就得一条条改回来。
//
// 四列：线体名称 / 编码 / 工位数 / 状态。
//
// 为什么「状态」只导出、不导入：它是**现场实时状态**（运行 / 停线 / 维修 / 保养），
// 不是配置。拿一份上周导出的表导回来，不该把昨天刚点的「运行」冲回「停线」。
// 认这一列只是为了它在表里不把别的列顶乱，读到了也不写库。
//
// 编码是终端 config.json 里填的寻址标识，所以改编码是**危险动作**：
// 预览里会明写「现场终端要跟着改」，不让人以为是改个显示名。
import { q, tx, lines } from '../db.js';
import { sendJson, readJsonBody, badRequest } from '../router.js';
import { parseSheet, buildWorkbook } from '../xlsx.js';
import { sendXlsx, stamp } from './export.js';
import { now, str, int, uid } from '../util.js';

const TITLE = ['线体名称', '编码', '工位数', '状态'];
const WIDTHS = [26, 14, 10, 10];

/** 线体状态 → 表格里的中文。导入时不读，只用于导出。 */
const ST_TEXT = { running: '运行', stopped: '停线', maintain: '维修', care: '保养' };

/** 终端/接口要求的编码形状，和 POST /api/lines 里的正则保持一致 */
const CODE_RE = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * 表头别名。键归一化后匹配（去空格、去括号备注、去标点、转小写）。
 *
 * 刻意**不收**「序号」「行号」：那是 Excel 自己的行号，收进来当编码就是灾难。
 * 也不收裸的 "line" —— 它在英文表里指"线体名称"还是"线体编码"说不清，
 * 与其猜错，不如让它落到"认不出表头"按位置读，至少读法可预期。
 */
const ALIAS = {
  name: ['线体名称', '线体', '产线', '产线名称', '生产线', '生产线名称', '名称', 'linename', 'name'],
  code: ['编码', '代码', '编号', '线体编码', '线体代码', 'linecode', 'code'],
  slots: ['工位数', '工位数量', '工位', '屏数', '屏幕数', '块数', 'slots'],
  status: ['状态', '线体状态', 'status']   // 认出来，但不写库
};

const FIELDS = ['name', 'code', 'slots', 'status'];

function normHeader(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')   // 「工位数（几块屏）」→「工位数」
    .replace(/[：:、,，;；*＊]/g, '');
}

const FIELD_OF = new Map();
for (const f of FIELDS) for (const a of ALIAS[f]) FIELD_OF.set(normHeader(a), f);

/** 表头行识别：前 5 行里挑「能认出最多字段」的那行，且必须认出名称或编码之一 */
function findHeader(rows) {
  let best = null;
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i += 1) {
    const r = rows[i] || [];
    const map = {};
    r.forEach((cell, ci) => {
      const f = FIELD_OF.get(normHeader(cell));
      if (f && map[f] === undefined) map[f] = ci;
    });
    const n = Object.keys(map).length;
    if (!n) continue;
    if (map.name === undefined && map.code === undefined) continue;
    if (!best || n > best.n) best = { index: i, map, n };
  }
  // 只认出一个字段（比如整表第一格恰好叫「名称」）容易误判成标题行，要求至少两个
  return best && best.n >= 2 ? best : null;
}

function readBuf(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(badRequest('文件太大（上限 8 MB），线体表一般几十 KB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const cellAt = (row, i) => (i === undefined || i === null ? '' : str(row && row[i], 200).trim());

/** 导出行：按排序取，和界面上的表格同序 */
function collect() {
  return lines().map((l) => [l.name, l.code, String(l.slots || 0), ST_TEXT[l.status] || l.status || '停线']);
}

function templateSheets() {
  return [
    {
      name: '线体清单',
      widths: WIDTHS,
      rows: [
        TITLE,
        ['一线', 'L1', 5, '运行'],
        ['二线', 'L2', 8, '停线']
      ]
    },
    {
      name: '填写说明',
      widths: [104],
      freeze: false,
      rows: [
        ['线体清单导入模板 · 填写说明'],
        [''],
        ['1. 只读「线体清单」这一页。这一页是说明，不会被导入。'],
        ['2. 第一行是标题行，从第二行开始，一条线体填一行。'],
        ['3. 四列：线体名称 / 编码 / 工位数 / 状态。'],
        ['   · 线体名称必填，全厂不能重名（例如「一线」「总装二线」）。'],
        ['   · 编码是终端 config.json 里填的寻址标识，只能用字母、数字、点、下划线、横线，'],
        ['     最长 16 个字符，例如 L1、L2、WM、XB。留空会按 L1、L2… 自动补一个没被占用的。'],
        ['   · 工位数 = 这条线有几块屏，只做展示参考，填 1~200，留空按 5 算。'],
        ['   · 状态填「运行 / 停线 / 维修 / 保养」—— 这一列**导出供查看，导入不生效**，'],
        ['     导入不会改任何一条线的状态。新导入的线一律是「停线」，需要时在界面上点「运行」。'],
        ['4. 认列认的是**表头名**，不是列号。在前面插一列「序号」、或把列换个顺序，都不影响导入。'],
        ['   但表头名别改，认不出会退回按前三列位置读（名称 / 编码 / 工位数）。'],
        ['5. 第五列以后随便加自己的列（序号、责任人、备注），导入不读。'],
        ['6. 已存在的线体按**编码**认，编码空着就按名称认。三种处理方式：'],
        ['   只加新的（跳过已有）/ 加新的+更新已有 / 只更新不新建。'],
        ['7. 改编码要想清楚：现场那台终端的 config.json 里填的就是旧编码，'],
        ['   改了编码，终端会连不上，得在同一台机器上把配置一起改。'],
        ['8. 「可生产机种」不在这张表里：一个机种能在哪几条线上做，去「机种设置」里勾。'],
        ['9. 老版 .xls 请先在 Excel 里「另存为」.xlsx 或 .csv，导入不了 .xls。'],
        ['10. 示例那两行（一线 / 二线）导入前请删掉，不然会真的建出这两条线。'],
        ['11. 导入路径：线体设置 → 右上角「导入 Excel」。'],
        ['    会先弹预览：读到几行、哪些新增、哪些有变化、哪些不合要求，确认了才写库。']
      ]
    }
  ];
}

export function register(router) {
  // ---------- 导出 ----------
  router.get('/api/export/lines.xlsx', (req, res) => {
    const rows = collect();
    if (!rows.length) throw badRequest('还没有线体，先建一条再来导出');
    sendXlsx(
      res,
      buildWorkbook([{ name: '线体清单', widths: WIDTHS, rows: [TITLE, ...rows] }]),
      `线体清单-${stamp()}.xlsx`
    );
  });

  // 导入模板：和导出的表逐列同构，多两行示例 + 一页说明
  router.get('/api/export/lines-template.xlsx', (req, res) => {
    sendXlsx(res, buildWorkbook(templateSheets()), '线体清单导入模板.xlsx');
  });

  // ---------- 导入第一步：只解析、只判定，不落库 ----------
  router.post('/api/import/lines/parse', async (req, res, ctx) => {
    let filename = 'lines.xlsx';
    try { filename = decodeURIComponent(String(ctx.query.filename || filename)); } catch { /* 明文就用原样 */ }

    const buf = await readBuf(req);
    if (!buf.length) throw badRequest('文件是空的');

    let all;
    try {
      all = parseSheet(buf);
    } catch (e) {
      throw badRequest(e.message || '读不出这个文件，请确认是 .xlsx 或 .csv');
    }
    if (!all.length) throw badRequest('这张表里没有读到任何内容');

    const head = findHeader(all);
    // 认不出表头就按位置读：0 名称 / 1 编码 / 2 工位数
    const map = head ? head.map : { name: 0, code: 1, slots: 2 };
    const body = head ? all.slice(head.index + 1) : all;
    if (!body.length) throw badRequest('只有标题行，没有线体数据');

    // 全库索引：编码和名称都是唯一键，两个都要能认
    const exist = lines();
    const byCode = new Map(exist.map((l) => [String(l.code).toLowerCase(), l]));
    const byName = new Map(exist.map((l) => [String(l.name).toLowerCase(), l]));

    const seenKey = new Map();   // 身份键 → 首次出现的行号（行内查重）
    const out = [];

    body.forEach((r, i) => {
      const rowNo = (head ? head.index + 1 : 0) + i + 1;  // 回到 Excel 里的真实行号
      const name = cellAt(r, map.name);
      const code = cellAt(r, map.code);
      const rawSlots = cellAt(r, map.slots);
      const slots = rawSlots === '' ? 5 : int(rawSlots, 0);

      const rec = {
        row: rowNo,
        name,
        code: code || '',
        slots: slots || 0,
        status: 'new',
        reason: '',
        detail: ''
      };

      // 整行空白：表格末尾常有空行，不算"不合要求"
      if (!name && !code && rawSlots === '') return;

      if (!name) { rec.status = 'bad'; rec.reason = '没有填线体名称'; out.push(rec); return; }
      if (code && !CODE_RE.test(code)) {
        rec.status = 'bad';
        rec.reason = '编码只能用字母、数字、点、下划线、横线，最长 16 个字符';
        out.push(rec);
        return;
      }
      if (rawSlots !== '' && (!Number.isFinite(slots) || slots < 1 || slots > 200)) {
        rec.status = 'bad';
        rec.reason = '工位数要填 1~200 的整数（这条线有几块屏）';
        out.push(rec);
        return;
      }
      rec.slots = Math.min(200, Math.max(1, slots || 5));

      // 认已有：先按编码，再按名称。两边指向不同的线，就是表本身写错了。
      let old = code ? (byCode.get(code.toLowerCase()) || null) : null;
      if (!old && name) {
        const sameName = byName.get(name.toLowerCase()) || null;
        if (sameName) {
          const otherCode = code ? (byCode.get(code.toLowerCase()) || null) : null;
          if (!code || !otherCode) old = sameName;
          else if (otherCode.id === sameName.id) old = sameName;
          else {
            rec.status = 'bad';
            rec.reason = `名称「${name}」和编码 ${code}（属于「${otherCode.name}」）对不上，请只留一个当依据`;
            out.push(rec);
            return;
          }
        }
      }
      if (old && name && old.name.toLowerCase() !== name.toLowerCase() && byName.has(name.toLowerCase())) {
        const clash = byName.get(name.toLowerCase());
        if (clash.id !== old.id) {
          rec.status = 'bad';
          rec.reason = `名称「${name}」已经被「${clash.code}」占用`;
          out.push(rec);
          return;
        }
      }

      const key = old ? `id:${old.id}` : `new:${(code || name).toLowerCase()}`;
      if (seenKey.has(key)) {
        rec.status = 'bad';
        rec.reason = `与第 ${seenKey.get(key)} 行是同一条线体`;
        out.push(rec);
        return;
      }
      seenKey.set(key, rowNo);

      if (!old) {
        rec.status = 'new';
        if (!code) rec.detail = '编码留空，导入时自动补一个';
        out.push(rec);
        return;
      }

      rec.lineId = old.id;
      rec.oldName = old.name;
      rec.oldCode = old.code;
      rec.oldSlots = old.slots || 0;

      const bits = [];
      if (old.code !== code && code) bits.push(`编码 ${old.code} → ${code}（现场终端要跟着改）`);
      if ((old.name || '') !== name) bits.push(`名称 ${old.name} → ${name}`);
      if (Number(old.slots || 0) !== rec.slots) bits.push(`工位数 ${old.slots || 0} → ${rec.slots}`);

      if (!bits.length) {
        rec.status = 'same';
        rec.code = old.code;   // 表里编码留空但名称命中，回填真编码给界面看
      } else {
        rec.status = 'diff';
        rec.detail = bits.join('；');
        if (!code) rec.code = old.code;
      }
      out.push(rec);
    });

    if (!out.length) throw badRequest('这张表里没有读到任何线体行');

    const counts = { new: 0, same: 0, diff: 0, bad: 0 };
    for (const r of out) counts[r.status] += 1;

    sendJson(res, 200, {
      filename,
      header: head ? (all[head.index] || []) : null,
      headerRow: head ? head.index + 1 : 0,
      mapping: map,
      positional: !head,
      total: out.length,
      counts,
      // 状态列认出来了但不会生效，界面上要说清，否则会有人以为能批量改状态
      statusIgnored: map.status !== undefined,
      rows: out
    });
  });

  // ---------- 导入第二步：按确认过的行批量建 / 更新 ----------
  //
  // mode：
  //   merge        只加库里没有的，已存在的一律跳过（重复导同一份表不会动任何东西）
  //   update       加新的 + 覆盖已存在的名称与工位数
  //   update-only  只改已存在的，不建新线体
  router.post('/api/lines/import', async (req, res) => {
    const body = await readJsonBody(req);
    const mode = ['merge', 'update', 'update-only'].includes(body.mode) ? body.mode : 'merge';
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw badRequest('没有可导入的行');

    const stat = { created: 0, updated: 0, kept: 0, skipped: 0, bad: [], lines: [] };
    let sort = q.get('SELECT COALESCE(MAX(sort),0) s FROM line').s;
    const ts = now();

    tx(() => {
      rows.forEach((r, i) => {
        const rowNo = Number(r && r.row) || i + 1;
        const name = str(r && r.name, 40).trim();
        let code = str(r && r.code, 16).trim();
        const slots = Math.min(200, Math.max(1, int(r && r.slots, 5)));

        if (!name) { stat.bad.push({ row: rowNo, name: '', code, reason: '没有填线体名称' }); return; }
        if (code && !CODE_RE.test(code)) {
          stat.bad.push({ row: rowNo, name, code, reason: '编码只能用字母、数字、点、下划线、横线，最长 16 个字符' });
          return;
        }

        // 库里按编码/名称重新找一遍：预览和落库之间可能有人动过界面，以库为准
        let old = code ? q.get('SELECT * FROM line WHERE code = ?', code) : null;
        if (!old) old = q.get('SELECT * FROM line WHERE name = ?', name);

        if (!old) {
          if (mode === 'update-only') { stat.skipped += 1; return; }
          if (!code) code = nextLineCode();
          if (q.get('SELECT id FROM line WHERE code = ?', code)) {
            stat.bad.push({ row: rowNo, name, code, reason: `编码 ${code} 已被占用` });
            return;
          }
          sort += 10;
          const id = uid('ln');
          q.run(
            'INSERT INTO line(id,code,name,enabled,status,slots,sort,created_at) VALUES(?,?,?,?,?,?,?,?)',
            id, code, name, 0, 'stopped', slots, sort, ts
          );
          stat.created += 1;
          stat.lines.push({ name, code, kind: 'created' });
          return;
        }

        if (mode === 'merge') { stat.skipped += 1; return; }

        // 改名撞了别的线：明确报错，不做"自动加后缀"这种自作主张
        const nameTaken = q.get('SELECT id FROM line WHERE name = ?', name);
        if (nameTaken && nameTaken.id !== old.id) {
          stat.bad.push({ row: rowNo, name, code: code || old.code, reason: `名称「${name}」已被「${old.code}」占用` });
          return;
        }
        if (code && code !== old.code) {
          const codeTaken = q.get('SELECT id FROM line WHERE code = ?', code);
          if (codeTaken && codeTaken.id !== old.id) {
            stat.bad.push({ row: rowNo, name, code, reason: `编码 ${code} 已被「${codeTaken.name}」占用` });
            return;
          }
        }

        const nextCode = code || old.code;
        const nextSlots = Math.min(200, Math.max(1, int(r && r.slots, old.slots || 5)));
        if (old.name === name && old.code === nextCode && Number(old.slots || 0) === nextSlots) {
          stat.kept += 1;
          return;
        }
        // 只改这三样：状态、enabled、sort 是运行态与顺序，导入不碰
        q.run('UPDATE line SET name = ?, code = ?, slots = ? WHERE id = ?', name, nextCode, nextSlots, old.id);
        stat.updated += 1;
        // from 只在编码真改了时才给 —— 否则界面上会冒出「原编码 L1」，看着像编码变了
        stat.lines.push({ name, code: nextCode, from: nextCode !== old.code ? old.code : '', kind: 'updated' });
      });
    });

    sendJson(res, 200, { ...stat, mode });
  });
}

/** 和 POST /api/lines 同一套取号规则：L1、L2…，跳过已占用的 */
function nextLineCode() {
  const used = new Set(q.all('SELECT code FROM line').map((r) => String(r.code).toLowerCase()));
  for (let i = 1; i < 999; i += 1) {
    if (!used.has(`l${i}`)) return `L${i}`;
  }
  return `L${Date.now()}`;
}

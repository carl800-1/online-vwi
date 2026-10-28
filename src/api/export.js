// 工序清单导出：生成 .xlsx 直接下发，外加一份给现场用的导入模板。
//
// 为什么导出和导入用同一套三列：导出来改完能原样导回去，是一个闭环。
// 多出来的列（序号、备注之类）导入时会被忽略，所以现场可以自己在后面加列。
//
// 全部机种导出是「机种 × 线体」一个 sheet —— 同一机种在一线和二线的工序编码
// 本来就不是一回事，混在一张表里没法看。
import { q, stationsOf } from '../db.js';
import { badRequest } from '../router.js';
import { buildWorkbook } from '../xlsx.js';

const TITLE = ['工序码', '名称', '做什么'];
const WIDTHS = [14, 22, 62];

/**
 * sheet 名合法化：Excel 只认 ≤31 字符、不能含 : \ / ? * [ ]、不能首尾撇号、不能重名（不分大小写）。
 * 不处理的话，机种名里带个「/」整个文件就打不开了。
 */
function sheetName(raw, used) {
  let s = String(raw || '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '');
  if (!s) s = 'Sheet';
  if (s.length > 31) s = s.slice(0, 31);

  let name = s;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const tail = `(${n})`;
    name = (s.length + tail.length > 31 ? s.slice(0, 31 - tail.length) : s) + tail;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sendXlsx(res, buf, filename) {
  // 中文文件名走 RFC 5987；另外给一个纯 ASCII 的 filename 兜底老客户端
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

export function register(router) {
  // 导出工序清单。不带 modelId = 全部机种（机种 × 线体 各一个 sheet）；
  // 带 modelId（可再带 lineId）= 只导这一个，改完能直接导回去。
  router.get('/api/export/stations.xlsx', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '').trim();
    const lineId = String(ctx.query.lineId || '').trim();

    const models = modelId
      ? q.all('SELECT * FROM model WHERE id = ?', modelId)
      : q.all('SELECT * FROM model ORDER BY sort, code');
    if (!models.length) throw badRequest(modelId ? '机种不存在' : '还没有机种，先去「机种设置」建一个');

    const lines = lineId
      ? q.all('SELECT * FROM line WHERE id = ?', lineId)
      : q.all('SELECT * FROM line ORDER BY sort, code');
    if (!lines.length) throw badRequest(lineId ? '线体不存在' : '还没有线体，先去「线体设置」建一条');

    const used = new Set();
    const sheets = [];
    for (const m of models) {
      for (const l of lines) {
        const sts = stationsOf(m.id, l.id);
        if (!sts.length) continue;
        // 只有「机种和线体都锁死」才省掉线体后缀 —— 一个机种在两条线上工序不同，
        // 光写机种名看不出是哪个 sheet
        const label = (models.length === 1 && lines.length === 1)
          ? m.name
          : `${m.name} - ${l.name}`;
        sheets.push({
          name: sheetName(label, used),
          widths: WIDTHS,
          rows: [TITLE, ...sts.map((s) => [s.code, s.name || '', s.note || ''])]
        });
      }
    }
    if (!sheets.length) throw badRequest('这个范围里还没有配过工序，先去加几道再来导出');

    const tag = models.length === 1 ? models[0].name : '全部机种';
    sendXlsx(res, buildWorkbook(sheets), `工序清单-${tag}-${stamp()}.xlsx`);
  });

  // 导入模板：标题行 + 一行示例，另开一页写说明 ——
  // 说明不能放在第一页的数据区里，否则会被当成一道工序导进去。
  router.get('/api/export/template.xlsx', (req, res) => {
    const sheets = [
      {
        name: '工序清单',
        widths: WIDTHS,
        rows: [
          TITLE,
          ['OP10', '压装', '装轴承后压到底，压完手转一圈听有无异响']
        ]
      },
      {
        name: '填写说明',
        widths: [96],
        freeze: false,
        rows: [
          ['工序清单导入模板 · 填写说明'],
          [''],
          ['1. 只读「工序清单」这一页。这一页是说明，不会被导入。'],
          ['2. 第一行是标题行，从第二行开始，一道工序填一行。'],
          ['3. 三列：工序码 / 名称 / 做什么。第四列以后不读，可以放自己的序号或备注。'],
          ['4. 工序码：字母、数字或中文开头，可以带 - _ . ，最长 16 个字符；'],
          ['   同一个机种在同一条线体内不能重复。'],
          ['5. 「名称」留空会用工序码顶上；「做什么」可以空着，之后再在界面上补。'],
          ['6. 示例那一行（OP10 压装）导入前请删掉，不然会真的建出一道 OP10。'],
          ['7. 导入路径：机种设置 → 选好机种和线体 → 「导入 Excel」。'],
          ['   会先弹预览（读到几行、跳过哪行标题、前 12 行长什么样），确认了才写库。'],
          ['8. 同名工序二选一：跳过（只加新的）/ 覆盖名称与说明（已配的内容不动）。'],
          ['9. 老版 .xls 请先在 Excel 里「另存为」.xlsx 或 .csv，导入不了 .xls。'],
          ['10. 现场 Excel 导出的 CSV 通常是 GBK 编码，也能直接导入，不用转码。']
        ]
      }
    ];

    sendXlsx(res, buildWorkbook(sheets), '工序清单导入模板.xlsx');
  });
}

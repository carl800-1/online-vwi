// 工序清单导出：全厂一张表，直接下发 .xlsx；外加一份同构的导入模板。
//
// 为什么是「一张表」而不是每个机种一个 sheet：导入只读第一页，
// 分 sheet 导出的文件改完根本导不回去，等于导出和导入是两套东西。
// 一张表五列（机种 / 线体 / 工序码 / 名称 / 做什么），导出 → 改 → 导回，闭环。
//
// 机种线体两列填**名称**（「X200 型」「一线」），因为现场是这么叫的；
// 导入时名称和编码都认，手改的时候写成 X200 也能对上。
import { q } from '../db.js';
import { badRequest } from '../router.js';
import { buildWorkbook } from '../xlsx.js';

const TITLE = ['机种', '线体', '工序码', '名称', '做什么'];
const WIDTHS = [16, 12, 12, 22, 62];

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

/** 按「机种 → 线体 → 工序顺序」拉出全表行；带 modelId / lineId 就只取那一块 */
function collect(modelId, lineId) {
  const models = modelId
    ? q.all('SELECT * FROM model WHERE id = ?', modelId)
    : q.all('SELECT * FROM model ORDER BY sort, code');
  if (!models.length) throw badRequest(modelId ? '机种不存在' : '还没有机种，先去「机种设置」建一个');

  const lines = lineId
    ? q.all('SELECT * FROM line WHERE id = ?', lineId)
    : q.all('SELECT * FROM line ORDER BY sort, code');
  if (!lines.length) throw badRequest(lineId ? '线体不存在' : '还没有线体，先去「线体设置」建一条');

  const rows = [];
  for (const m of models) {
    for (const l of lines) {
      const sts = q.all(
        'SELECT code, name, note FROM station WHERE model_id = ? AND line_id = ? ORDER BY sort, code',
        m.id, l.id
      );
      for (const s of sts) rows.push([m.name, l.name, s.code, s.name || '', s.note || '']);
    }
  }
  return { rows, models, lines };
}

export function register(router) {
  // 导出工序清单。不带参数 = 全厂；带 modelId（可再带 lineId）= 只导那一块。
  router.get('/api/export/stations.xlsx', (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '').trim();
    const lineId = String(ctx.query.lineId || '').trim();

    const { rows, models, lines } = collect(modelId, lineId);
    if (!rows.length) throw badRequest('这个范围里还没有配过工序，先去加几道再来导出');

    let tag = '全部机种';
    if (modelId && lineId) tag = `${models[0].name}-${lines[0].name}`;
    else if (modelId) tag = models[0].name;
    else if (lineId) tag = lines[0].name;

    sendXlsx(
      res,
      buildWorkbook([{ name: '工序清单', widths: WIDTHS, rows: [TITLE, ...rows] }]),
      `工序清单-${tag}-${stamp()}.xlsx`
    );
  });

  // 导入模板：与导出的表**逐列同构**，只是多两行示例、另开一页写说明 ——
  // 说明不能放在「工序清单」这页的数据区里，否则会被当成一道工序导进去。
  router.get('/api/export/template.xlsx', (req, res) => {
    const model = q.get('SELECT name FROM model ORDER BY sort, code LIMIT 1');
    const line = q.get('SELECT name FROM line ORDER BY sort, code LIMIT 1');
    const m = model ? model.name : 'X200 型';
    const l = line ? line.name : '一线';

    const sheets = [
      {
        name: '工序清单',
        widths: WIDTHS,
        rows: [
          TITLE,
          [m, l, 'OP10', '压装', '装轴承后压到底，压完手转一圈听有无异响'],
          [m, l, 'OP20', '拧紧', '力矩 25N·m，拧完打标记']
        ]
      },
      {
        name: '填写说明',
        widths: [100],
        freeze: false,
        rows: [
          ['工序清单导入模板 · 填写说明'],
          [''],
          ['1. 只读「工序清单」这一页。这一页是说明，不会被导入。'],
          ['2. 第一行是标题行，从第二行开始，一道工序填一行；一个机种在一条线上有多少道工序就填多少行。'],
          ['3. 五列：机种 / 线体 / 工序码 / 名称 / 做什么。'],
          ['   · 机种、线体填**名称**（如「X200 型」「一线」），填编码（X200 / L1）也认。'],
          ['   · 名称和线体必须是系统里已经建好的，没建档的行会被列出来，不会凭空建。'],
          ['   · 工序码：字母、数字或中文开头，可带 - _ . ，最长 16 个字符；'],
          ['     同一个机种在同一条线体内不能重复。'],
          ['   · 「名称」留空会用工序码顶上；「做什么」可以空着，之后再在界面上补。'],
          ['4. 认列认的是**表头名**，不是列号。在前面插一列「序号」、或把列换个顺序，都不影响导入。'],
          ['   但表头名别改（「工序码」不能写成「工位」那种认不出的），认不出会退回按前三列位置读。'],
          ['5. 第四列以后随便加自己的列（序号、责任人、版本号），导入不读。'],
          ['6. 示例那两行（OP10 / OP20）导入前请删掉，不然会真的建出这两道工序。'],
          ['7. 导入路径：机种设置 → 右上角「导入」→ 选文件。'],
          ['   会先弹预览：读到几行、哪些新增、哪些已存在、哪些不合要求，确认了才写库。'],
          ['8. 已存在的工序三选一：只加新的（跳过已有）/ 加新的+更新已有 / 只更新不新建。'],
          ['9. 导入完成后可在结果窗口一键「撤销本次导入」，只删这次新建的工序。'],
          ['10. 老版 .xls 请先在 Excel 里「另存为」.xlsx 或 .csv，导入不了 .xls。'],
          ['11. 现场 Excel 导出的 CSV 通常是 GBK 编码，也能直接导入，不用转码。']
        ]
      }
    ];

    sendXlsx(res, buildWorkbook(sheets), '工序清单导入模板.xlsx');
  });
}

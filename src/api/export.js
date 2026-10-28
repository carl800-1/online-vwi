// 工序清单导出：全厂一张表，直接下发 .xlsx；外加一份同构的导入模板。
//
// 为什么是「一张表」而不是每个机种一个 sheet：导入只读第一页，
// 分 sheet 导出的文件改完根本导不回去，等于导出和导入是两套东西。
// 一张表四列（机种 / 工序码 / 名称 / 做什么），导出 → 改 → 导回，闭环。
//
// v4.0.0 去掉「线体」列：工序归机种，不再按线分。
// 机种填**名称**（「X200 型」），因为现场是这么叫的；编码也认。
import { q } from '../db.js';
import { badRequest } from '../router.js';
import { buildWorkbook } from '../xlsx.js';

const TITLE = ['机种', '工序码', '名称', '做什么'];
const WIDTHS = [20, 12, 22, 66];

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

/** 按「机种 → 工序顺序」拉出全表行；带 modelId 就只取那个机种 */
function collect(modelId) {
  const models = modelId
    ? q.all('SELECT * FROM model WHERE id = ?', modelId)
    : q.all('SELECT * FROM model ORDER BY sort, code');
  if (!models.length) throw badRequest(modelId ? '机种不存在' : '还没有机种，先去「机种设置」建一个');

  const rows = [];
  for (const m of models) {
    const ps = q.all(
      'SELECT code, name, note FROM process WHERE model_id = ? ORDER BY sort, code', m.id
    );
    for (const p of ps) rows.push([m.name, p.code, p.name || '', p.note || '']);
  }
  return { rows, models };
}

export function register(router) {
  // 导出工序清单。不带参数 = 全厂；带 modelId = 只导那个机种。
  const doExport = (req, res, ctx) => {
    const modelId = String(ctx.query.modelId || '').trim();
    const { rows, models } = collect(modelId);
    if (!rows.length) throw badRequest('这个范围里还没有工序，先去加几道再来导出');
    const tag = modelId ? models[0].name : '全部机种';
    sendXlsx(
      res,
      buildWorkbook([{ name: '工序清单', widths: WIDTHS, rows: [TITLE, ...rows] }]),
      `工序清单-${tag}-${stamp()}.xlsx`
    );
  };
  router.get('/api/export/processes.xlsx', doExport);
  // 老地址（3.4.0 及以前的前端、脚本）继续有效
  router.get('/api/export/stations.xlsx', doExport);

  // 导入模板：与导出的表**逐列同构**，只是多两行示例、另开一页写说明 ——
  // 说明不能放在「工序清单」这页的数据区里，否则会被当成一道工序导进去。
  router.get('/api/export/template.xlsx', (req, res) => {
    const model = q.get('SELECT name FROM model ORDER BY sort, code LIMIT 1');
    const m = model ? model.name : 'X200 型';

    const sheets = [
      {
        name: '工序清单',
        widths: WIDTHS,
        rows: [
          TITLE,
          [m, 'OP1', '压装', '装轴承后压到底，压完手转一圈听有无异响'],
          [m, 'OP2', '拧紧', '力矩 25N·m，拧完打标记']
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
          ['2. 第一行是标题行，从第二行开始，一道工序填一行；一个机种有几道工序就填几行。'],
          ['3. 四列：机种 / 工序码 / 名称 / 做什么。'],
          ['   · 机种填**名称**（如「X200 型」），填编码（X200）也认。'],
          ['   · 机种必须是系统里已经建好的，没建档的行会被列出来，不会凭空建。'],
          ['   · 工序码：字母、数字或中文开头，可带 - _ . ，最长 16 个字符；'],
          ['     同一个机种内不能重复。默认从 OP1、OP2… 起编。'],
          ['   · 「名称」留空会用工序码顶上；「做什么」可以空着，之后再在界面上补。'],
          ['4. 认列认的是**表头名**，不是列号。在前面插一列「序号」、或把列换个顺序，都不影响导入。'],
          ['   但表头名别改（「工序码」不能写成「工位」那种认不出的），认不出会退回按前三列位置读。'],
          ['5. 第四列以后随便加自己的列（序号、责任人、版本号），导入不读。'],
          ['6. 示例那两行（OP1 / OP2）导入前请删掉，不然会真的建出这两道工序。'],
          ['7. 导入路径：机种设置 → 右上角「导入」→ 选文件。'],
          ['   会先弹预览：读到几行、哪些新增、哪些已存在、哪些不合要求，确认了才写库。'],
          ['8. 已存在的工序三选一：只加新的（跳过已有）/ 加新的+更新已有 / 只更新不新建。'],
          ['9. 导入完成后可在结果窗口一键「撤销本次导入」，只删这次新建的工序。'],
          ['10. 老版 .xls 请先在 Excel 里「另存为」.xlsx 或 .csv，导入不了 .xls。'],
          ['11. 现场 Excel 导出的 CSV 通常是 GBK 编码，也能直接导入，不用转码。'],
          ['12. 线体不在这张表里：一个机种能在哪几条线上做，在「机种设置」里勾选。']
        ]
      }
    ];

    sendXlsx(res, buildWorkbook(sheets), '工序清单导入模板.xlsx');
  });
}

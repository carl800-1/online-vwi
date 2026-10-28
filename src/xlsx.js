// 读写工序表（.xlsx / .csv）。
//
// 为什么自己解/自己拼 ZIP 而不装库：整个项目只有一个运行时依赖 mupdf（PDF 拆页），
// xlsx 说到底是「ZIP 里放几份 XML」，node:zlib 够用，省掉一个几百 KB 的包，
// 现场部署也不用多带一份 node_modules。
//
// 读：store / deflate 两种压缩、sharedStrings、inlineStr、数值、公式结果文本、CSV/TSV（UTF-8 与 GBK）。
// 写：只用 inlineStr（不建 sharedStrings 表，少一层索引）、ZIP 一律 store 不压缩
//     —— 工序表就几 KB，deflate 省不下什么，代码却能少一半。
// 不支持：.xls（97-2003 二进制，它不是 ZIP）、加密文件、zip64（>4 GB，工序表不可能这么大）。
// 遇到不支持的会抛一句人话，让界面直接提示，而不是静默读到空表。

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;   // 中央目录结束符
const SIG_CEN = 0x02014b50;    // 中央目录项
const SIG_LOC = 0x04034b50;    // 本地文件头

/** 把 xlsx 当 ZIP 解开，返回 文件名 → Buffer */
function unzip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66560);   // EOCD 后面最多跟 64KB 注释
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 目录）；老版 .xls 请先另存为 .xlsx');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count && p + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CEN) break;

    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // zip64 的偏移写成 0xFFFFFFFF，真遇到就直接说清楚，别去猜
    if (csize === 0xffffffff || loc === 0xffffffff) {
      throw new Error('这个 xlsx 用了 zip64 格式（文件过大），暂不支持');
    }
    if (buf.readUInt32LE(loc) === SIG_LOC) {
      // 本地头里的文件名/扩展区长度可能和中央目录不一致，以本地头为准
      const lName = buf.readUInt16LE(loc + 26);
      const lExtra = buf.readUInt16LE(loc + 28);
      const start = loc + 30 + lName + lExtra;
      const raw = buf.subarray(start, start + csize);
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** A1 / BC12 → 0 起的列号 */
function colOf(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * sharedStrings：Excel 把重复出现的文本存成一张表，单元格里只放索引。
 * 一个 <si> 里可能有多个 <r><t>（一段话被改过字体就会拆开），要拼起来才是完整字符串。
 */
function parseSst(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    out.push([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => decodeXml(t[1])).join(''));
  }
  return out;
}

function parseSheetXml(xml, sst) {
  const rows = [];
  // 单元格可能是 <c .../>（空）或 <c ...>...</c>，两种都要吃下
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let next = 0;
    cellRe.lastIndex = 0;
    let cm = cellRe.exec(rm[1]);
    while (cm) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      let v = '';

      if (type === 'inlineStr') {
        v = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
      } else {
        const vm = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = vm ? vm[1] : '';
        if (type === 's') v = sst[Number(raw)] ?? '';   // 共享字符串索引
        else v = decodeXml(raw);                        // 数值 / str（公式结果）
      }

      const idx = ref ? colOf(ref) : next;
      cells[idx] = v;
      next = idx + 1;
      cm = cellRe.exec(rm[1]);
    }
    rows.push(cells);
  }
  return rows;
}

/** 去掉空行、把 undefined 补成空串、砍掉整列都空的尾巴 */
function tidy(rows) {
  return rows
    .map((r) => {
      const out = [];
      for (let i = 0; i < r.length; i += 1) out[i] = r[i] === undefined ? '' : String(r[i]).trim();
      while (out.length && !out[out.length - 1]) out.pop();
      return out;
    })
    .filter((r) => r.some((c) => c !== ''));
}

function splitCsv(text) {
  const head = text.split(/\r?\n/).slice(0, 6).join('\n');
  const sep = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? '\t' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }   // "" 是一个引号本身
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseText(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel 在中文 Windows 上「另存为 CSV」默认是 GBK，直接按 UTF-8 读会全是乱码
    text = new TextDecoder('gbk').decode(buf);
  }
  return splitCsv(text.replace(/^\uFEFF/, ''));
}

/**
 * 入口：给一段文件内容，回二维字符串数组。
 * 靠前两个字节判断是不是 ZIP（PK），不是就按纯文本表格读。
 */
export function parseSheet(buf) {
  // 老版 .xls 是 OLE 复合文档（D0 CF 11 E0），不是 ZIP。当文本读会得到一屏乱码，
  // 所以这里直接拦住，让现场另存为 .xlsx —— 比"导入成功 0 行"好排查得多。
  if (buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new Error('这是老版 .xls（97-2003），请在 Excel 里「另存为」.xlsx 或 .csv 再导入');
  }

  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) return tidy(parseText(buf));

  const files = unzip(buf);
  const sstXml = files.get('xl/sharedStrings.xml');
  const sst = sstXml ? parseSst(sstXml.toString('utf8')) : [];

  let path = 'xl/worksheets/sheet1.xml';
  if (!files.has(path)) {
    const first = [...files.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0];
    if (!first) throw new Error('xlsx 里没有找到工作表');
    path = first;
  }
  return tidy(parseSheetXml(files.get(path).toString('utf8'), sst));
}

// ============================================================
// 写：把二维数组拼成 .xlsx
// ============================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 打包成 ZIP，全部 store（method 0，不压缩）。
 * 顺序有讲究：[Content_Types].xml 排第一 —— 老版本 Excel 认死这个位置。
 */
function zipStore(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const centrals = [];
  let offset = 0;

  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0);
    loc.writeUInt16LE(20, 4);            // 解压所需版本 2.0
    loc.writeUInt16LE(0x0800, 6);        // 文件名按 UTF-8（全 ASCII 也不碍事）
    loc.writeUInt16LE(0, 8);             // method 0 = store
    loc.writeUInt16LE(dosTime, 10);
    loc.writeUInt16LE(dosDate, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18);  // 压缩后
    loc.writeUInt32LE(data.length, 22);  // 原始
    loc.writeUInt16LE(nameBuf.length, 26);
    loc.writeUInt16LE(0, 28);            // extra len

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);            // version made by
    cen.writeUInt16LE(20, 6);            // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);            // extra
    cen.writeUInt16LE(0, 32);            // comment
    cen.writeUInt16LE(0, 34);            // disk start
    cen.writeUInt16LE(0, 36);            // internal attrs
    cen.writeUInt32LE(0, 38);            // external attrs
    cen.writeUInt32LE(offset, 42);       // 本地头偏移

    parts.push(loc, nameBuf, data);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }

  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cenBuf, eocd]);
}

/** XML 转义。顺手剔掉 XML 1.0 不允许的控制字符，否则 Excel 会报"文件已损坏" */
function escXml(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A，25 → Z，26 → AA */
function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows, widths, freeze) {
  const cols = (widths && widths.length)
    ? '<cols>' + widths.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    : '';

  // 全部用 inlineStr：不建 sharedStrings 表，而且「0010」这种带前导零的工序码
  // 不会被 Excel 当成数字吃掉
  const body = rows.map((r, ri) => {
    const cells = (r || []).map((v, ci) => {
      if (v === null || v === undefined || v === '') return '';
      return `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${
        escXml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  // 冻结首行：25 道工序往下滚时表头还在，跟界面上的表格一个体验
  const views = freeze === false
    ? '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '</sheetView></sheetViews>';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + views
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + cols
    + `<sheetData>${body}</sheetData>`
    + '</worksheet>';
}

/**
 * 入口：拼一个 xlsx 出来。
 * @param {Array<{name:string, rows:string[][], widths?:number[], freeze?:boolean}>} sheets
 *   name 由调用方负责合法化（≤31 字符、无 : \ / ? * [ ]、不重名）
 * @returns {Buffer}
 */
export function buildWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('没有可导出的工作表');

  const CT = 'application/vnd.openxmlformats-officedocument';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/>`
    + sheets.map((s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`
      ).join('')
    + '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`
    + '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + `xmlns:r="${REL}">`
    + '<sheets>' + sheets.map((s, i) =>
        `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';

  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((s, i) =>
        `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      ).join('')
    + '</Relationships>';

  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ...sheets.map((s, i) => [
      `xl/worksheets/sheet${i + 1}.xml`,
      sheetXml(s.rows || [], s.widths, s.freeze)
    ])
  ]);
}

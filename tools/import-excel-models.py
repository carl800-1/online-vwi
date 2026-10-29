#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从「装配工时定额一览表」Excel 批量导入机种到 ESOP 服务端。

用法：
  python tools/import-excel-models.py "C:\\path\\Hikoki.xlsx" --dry-run    # 只看会导什么
  python tools/import-excel-models.py "C:\\path\\Hikoki.xlsx"             # 真导

默认连 http://127.0.0.1:8092（正在跑的服务端），走它的 HTTP 接口写库，
不直接改 vwi.db —— 避免和运行中的进程抢 WAL 锁。

流程：
  1. 读表 → 清洗（丢异常行、按机种编号去重、线号归一）
  2. 按线号建线体（已存在就复用）
  3. 逐个建机种（已存在就跳过，可重复跑）
  4. 打印报告

表里认的列（按表头文字找，不认列号）：
  NO / 代表机种 / 产品名称 / 产品代码 / 线号
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections import Counter, OrderedDict

try:
    import openpyxl
except ImportError:
    sys.exit("缺 openpyxl：pip install openpyxl")

CODE_RE = re.compile(r'^[A-Za-z0-9._-]{1,32}$')

# 线号 → (线体编码, 线体名称)。线体编码只允许字母数字点下划线横线，
# 所以 1# / 2# / 中文 都得换一个能过校验的码；名称保留现场的叫法。
LINE_MAP = {
    '1#': ('L1', '1#'),
    '2#': ('L2', '2#'),
    'L08': ('L08', 'L08'),
    '1A2': ('1A2', '1A2'),
    '1A4': ('1A4', '1A4'),
    '1A5': ('1A5', '1A5'),
    '1A6': ('1A6', '1A6'),
    '1A7': ('1A7', '1A7'),
    '2A1': ('2A1', '2A1'),
    '外贸配件': ('WM', '外贸配件'),
    '细胞线': ('XB', '细胞线'),
}

HEADER_KEYS = {
    'no': ['NO', 'No', 'no'],
    'code': ['代表机种'],
    'name': ['产品名称'],
    'pcode': ['产品代码'],
    'line': ['线号'],
}


def api(base, path, payload=None, method=None):
    url = base.rstrip('/') + path
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ('POST' if data else 'GET'))
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode('utf-8')
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')
        try:
            detail = json.loads(detail).get('error') or detail
        except Exception:
            pass
        raise RuntimeError(f'{method or "GET"} {path} -> {e.code} {detail[:200]}')


def find_header(rows):
    """在前若干行里找含「代表机种」的那一行，返回 (行下标, 列名→列号)。"""
    wanted = [v for vs in HEADER_KEYS.values() for v in vs]
    for i, r in enumerate(rows[:15]):
        cells = [str(c).strip() if c is not None else '' for c in r]
        if any(w in cells for w in wanted):
            col = {}
            for key, aliases in HEADER_KEYS.items():
                for c, text in enumerate(cells):
                    if text in aliases:
                        col[key] = c
                        break
            if 'code' in col:
                return i, col
    return None, None


def read_sheet(path, sheet_name=None):
    wb = openpyxl.load_workbook(path, data_only=True)
    name = sheet_name or wb.sheetnames[0]
    if name not in wb.sheetnames:
        sys.exit(f'没有名为「{name}」的表，可用的有：{wb.sheetnames}')
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    hi, col = find_header(rows)
    if hi is None:
        sys.exit(f'「{name}」里没找到表头（需要含「代表机种」的那一行）')

    out, skipped = [], []
    for r in rows[hi + 2:]:                      # 表头下第二行起（第一行是公式说明）
        def cell(key):
            i = col.get(key)
            if i is None or i >= len(r) or r[i] is None:
                return ''
            return str(r[i]).strip()

        code, pname = cell('code'), cell('name')
        if not code:
            continue
        line = cell('line')
        line = '' if line in ('', 'None') else line
        if not CODE_RE.match(code):
            skipped.append((code, f'编号不合法（{pname or "无名称"}）'))
            continue
        # 「1」「2」这种纯数字短编号是表里串行串出来的（原表备注写着「部装」），不是机种
        if code.isdigit() and len(code) < 4:
            skipped.append((code, f'编号无意义（{pname or "无名称"}）'))
            continue
        out.append({
            'code': code,
            'name': pname or code,
            'pcode': cell('pcode'),
            'line': line,
        })
    return out, skipped


CJK = re.compile(r'[\u4e00-\u9fff]')


def merge_dupes(records):
    """同一机种出现在多行（多条线 / 整机行 + 部装行）→ 合并成一条，线号取并集。

    产品名称的取法：整机行是中文品类（电钻/斜切割机…），部装行是英文部件名
    （HEAD ASS´Y…）。所以优先取中文名、其次取出现次数最多的、最后取首行。
    """
    groups = OrderedDict()
    for rec in records:
        groups.setdefault(rec['code'], []).append(rec)

    merged, dup, odd = [], [], []
    for code, rows in groups.items():
        if len(rows) > 1:
            dup.append(code)
        names = [r['name'] for r in rows if r['name']]
        cjk_names = [n for n in names if CJK.search(n)]
        if cjk_names:
            name = Counter(cjk_names).most_common(1)[0][0]
        elif names:
            name = Counter(names).most_common(1)[0][0]
        else:
            name = code
        if not CJK.search(name):
            odd.append((code, name))
        lines = []
        for r in rows:
            if r['line'] and r['line'] not in lines:
                lines.append(r['line'])
        merged.append({'code': code, 'name': name,
                       'pcode': next((r['pcode'] for r in rows if r['pcode']), ''),
                       'lines': lines})
    return merged, dup, odd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('excel')
    ap.add_argument('--base', default='http://127.0.0.1:8092')
    ap.add_argument('--sheet', default='未结束机种')
    ap.add_argument('--processes', type=int, default=15)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--keep-demo', action='store_true', help='保留现有演示机种与线体，只追加')
    args = ap.parse_args()

    records, skipped = read_sheet(args.excel, args.sheet)
    models, dup, odd = merge_dupes(records)

    lines_needed = Counter()
    for m in models:
        for ln in m['lines']:
            lines_needed[ln] += 1

    unknown = [ln for ln in lines_needed if ln not in LINE_MAP]
    if unknown:
        sys.exit(f'线号没有映射：{unknown}，请先在 LINE_MAP 里补上')

    print('=' * 66)
    print(f'读表结果：{len(records)} 行有效 / {len(models)} 个唯一机种')
    print(f'  跳过异常行 {len(skipped)} 条' + (f'：{skipped[:5]}' if skipped else ''))
    print(f'  合并重复编号 {len(dup)} 条（同一机种在多行 / 多条线）')
    if odd:
        print(f'  产品名称仍非中文的 {len(odd)} 个（表里这些行只填了部件名）：'
              f'{[c for c, _ in odd[:6]]}')
    print(f'  每机种工序数 {args.processes} → 约 {len(models) * args.processes} 条工序记录')
    print('  线号 -> 线体：')
    for ln, n in lines_needed.most_common():
        code, name = LINE_MAP[ln]
        print(f'    {ln:<8} -> {code:<4} {name:<8} {n} 个机种')
    if args.dry_run:
        print('\n[试跑] 前 5 个机种：')
        for m in models[:5]:
            print('  ', m)
        print('[试跑] 未写入任何数据。去掉 --dry-run 真导。')
        return

    exist_models = {m['code']: m for m in api(args.base, '/api/models')['models']}
    exist_lines = {l['code']: l for l in api(args.base, '/api/lines')['lines']}
    want_line_codes = {LINE_MAP[ln][0] for ln in lines_needed}

    # 1) 先建/复用线体。顺序很关键：老的「L1 一线」正好是 1# 那条线的编码，
    #    直接复用改名即可 —— 这样也保住了终端 config.json 里写死的 line=L1。
    line_ids = {}
    for ln in lines_needed:
        code, name = LINE_MAP[ln]
        cur = exist_lines.get(code)
        if cur:
            line_ids[ln] = cur['id']
            if cur['name'] != name:
                api(args.base, f"/api/lines/{cur['id']}", {'name': name}, 'PUT')
                print(f'  复用线体 {code}，改名 {cur["name"]} → {name}')
            else:
                print(f'  复用线体 {code} {name}')
            continue
        got = api(args.base, '/api/lines', {'code': code, 'name': name, 'slots': 5, 'status': 'stopped'})
        line_ids[ln] = got['id']
        print(f'  新建线体 {code} {name}')

    if not args.keep_demo:
        # 2) 删掉不在目标里的线体（此时已有 11 条，不会再撞「至少保留一条」）
        for line in list(exist_lines.values()):
            if line['code'] in want_line_codes:
                continue
            if line['status'] == 'running':
                api(args.base, f"/api/lines/{line['id']}", {'status': 'stopped'}, 'PUT')
            try:
                api(args.base, f"/api/lines/{line['id']}", method='DELETE')
                print(f"  删线体 {line['code']} {line['name']}")
            except RuntimeError as e:
                print(f"  略过线体 {line['code']}：{e}")

        # 3) 删掉不在表里的机种（演示数据 X200…X290 之类）
        keep_codes = {m['code'] for m in models}
        removed = 0
        for m in exist_models.values():
            if m['code'] in keep_codes:
                continue
            try:
                api(args.base, f"/api/models/{m['id']}", method='DELETE')
                removed += 1
            except RuntimeError as e:
                print(f"  删机种 {m['code']} 失败：{e}")
        print(f'  清掉表外机种 {removed} 个')

    # 3) 建机种
    todo = [m for m in models if m['code'] not in exist_models]
    print(f'\n开始导入 {len(todo)} 个机种…')
    ok, fail = 0, []
    for i, m in enumerate(todo, 1):
        ids = [line_ids[ln] for ln in m['lines'] if ln in line_ids]
        try:
            api(args.base, '/api/models', {
                'code': m['code'], 'name': m['name'],
                'processCount': args.processes, 'lineIds': ids,
            })
            ok += 1
        except RuntimeError as e:
            fail.append((m['code'], str(e)))
        if i % 100 == 0 or i == len(todo):
            print(f'  {i}/{len(todo)} …')

    print('\n' + '=' * 66)
    print(f'完成：新建 {ok} 个机种，失败 {len(fail)} 个，已存在跳过 {len(models) - len(todo)} 个')
    for code, err in fail[:10]:
        print(f'  ✗ {code}: {err}')

    stat = api(args.base, '/api/models')
    print(f"接口复核：机种 {len(stat['models'])} 个 / 工序总计 "
          f"{sum(m['total'] for m in stat['models'])} 条")
    for l in api(args.base, '/api/lines')['lines']:
        print(f"  线体 {l['code']:<5} {l['name']:<8} 机种 {l['modelCount']} 个  状态 {l['status']}")


if __name__ == '__main__':
    main()

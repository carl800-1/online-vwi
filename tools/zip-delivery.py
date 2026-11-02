#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把交付文件夹原样压成 zip（zip 根 = 文件夹内容，不带外层目录名），逐条比对 sha256。

用法：python tools/zip-delivery.py <版本号>
"""
import hashlib
import pathlib
import sys
import zipfile

BASE = pathlib.Path(r"D:\project\09.ESOP")


def sha(f):
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ver = sys.argv[1]
    src = BASE / f"v{ver}" / "ESOP-Server"
    zp = BASE / f"v{ver}" / "ESOP-Server.zip"
    if not src.is_dir():
        sys.exit(f"找不到文件夹：{src}")

    files = sorted(p for p in src.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in files)
    print(f"打包 {src.name}：{len(files)} 个文件，原始 {total / 1048576:.1f} MB")

    if zp.exists():
        zp.unlink()
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in files:
            z.write(p, str(p.relative_to(src)).replace("\\", "/"))

    size = zp.stat().st_size
    print(f"完成：{zp.name}  {size / 1048576:.1f} MB")

    # 逐条比对：zip 里解出来的 sha256 必须和磁盘上的文件一模一样
    ok = bad = 0
    with zipfile.ZipFile(zp) as z:
        names = set(z.namelist())
        disk = {str(p.relative_to(src)).replace("\\", "/") for p in files}
        missing = disk - names
        extra = names - disk
        for rel in sorted(disk):
            h_zip = hashlib.sha256(z.read(rel)).hexdigest()
            h_disk = sha(src / rel)
            if h_zip == h_disk:
                ok += 1
            else:
                bad += 1
                print(f"  ✗ 不一致 {rel}")
    print(f"比对：{ok} 一致 / {bad} 不一致；少 {len(missing)} 条，多 {len(extra)} 条")
    if bad or missing or extra:
        sys.exit(1)
    print(f"zip sha256 = {sha(zp).upper()}")


if __name__ == "__main__":
    main()

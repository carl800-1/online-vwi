#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交付文件夹完整性自检：临时压成 zip（zip 根 = 文件夹内容，不带外层目录名），
逐条比对 sha256，比完把 zip 删掉。

**5.0.1 起不再交付 zip**（用户 2026-11-17 决定）：交付只给「ESOP-Server 文件夹」，
解压即用。本脚本因此退化成自检工具，产物不留；想留一份备份加 `--keep`。

用法：python tools/zip-delivery.py <版本号> [--keep]
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
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    keep = "--keep" in sys.argv
    if not args:
        sys.exit("用法：python tools/zip-delivery.py <版本号> [--keep]")

    ver = args[0]
    src = BASE / f"v{ver}" / "ESOP-Server"
    zp = BASE / f"v{ver}" / "ESOP-Server.zip"
    if not src.is_dir():
        sys.exit(f"找不到文件夹：{src}")

    files = sorted(p for p in src.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in files)
    print(f"自检 {src.name}：{len(files)} 个文件，原始 {total / 1048576:.1f} MB")

    if zp.exists():
        zp.unlink()
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in files:
            z.write(p, str(p.relative_to(src)).replace("\\", "/"))

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
        sys.exit(f"自检不通过，zip 留在 {zp} 供排查")

    exe = src / "ESOP-Server.exe"
    if exe.exists():
        print(f"ESOP-Server.exe sha256 = {sha(exe).upper()}")

    if keep:
        print(f"已保留 {zp.name}（--keep，仅作备份，不进交付）")
    else:
        zp.unlink()
        print("已删除 zip —— 5.0.1 起交付只给文件夹，不再附压缩包")


if __name__ == "__main__":
    main()

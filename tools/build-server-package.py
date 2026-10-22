#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把服务端绿色免安装包打成 zip。

只打包「干净」的运行态：data 目录里除了说明.txt 一律不带
（数据库和媒体是运行期数据，第一次启动会自动重建空库）。

用法：python tools/build-server-package.py [版本号]
默认版本号取自根 package.json。
"""
import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
PKG_NAME = "online-vwi-server-{ver}-win-x64"

# 打包进 zip 的内容
# node_modules/mupdf 是唯一一个运行时依赖（PDF 拆页要用它的 wasm），不能漏 ——
# 漏了的表现是"绿色包能启动、上传 PDF 立刻 500"，很难一眼看出是缺包。
INCLUDE_DIRS = ["src", "public", "docs", "tools", "node_modules/mupdf"]
INCLUDE_FILES = ["server.js", "package.json", "使用说明.txt"]
RUNTIME_FILES = [("runtime", "node.exe")]


def collect(pkg: pathlib.Path):
    """列出 (归档内相对路径, 磁盘路径) 列表。"""
    items = []
    for d in INCLUDE_DIRS:
        for f in sorted((pkg / d).rglob("*")):
            if f.is_file():
                items.append((f.relative_to(pkg), f))
    for f in INCLUDE_FILES:
        p = pkg / f
        if p.exists():
            items.append((pathlib.Path(f), p))
    for d, f in RUNTIME_FILES:
        p = pkg / d / f
        if p.exists():
            items.append((pathlib.Path(d) / f, p))
    # data\ 只放说明，不放数据库
    data_note = pkg / "data" / "说明.txt"
    if data_note.exists():
        items.append((pathlib.Path("data") / "说明.txt", data_note))
    # 根目录下的 bat（中文 4 个 + 英文 4 个）
    for f in sorted(pkg.glob("*.bat")):
        items.append((pathlib.Path(f.name), f))
    return items


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else json.loads(
        (ROOT / "package.json").read_text(encoding="utf-8")
    )["version"]

    pkg = RELEASE / PKG_NAME.format(ver=version)
    if not pkg.exists():
        print(f"找不到包目录：{pkg}")
        sys.exit(1)

    zip_path = RELEASE / (PKG_NAME.format(ver=version) + ".zip")
    items = collect(pkg)
    total = sum(f.stat().st_size for _, f in items)
    print(f"打包 {pkg.name}：{len(items)} 个文件，原始 {total/1048576:.1f} MB")

    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, f in items:
            z.write(f, str(pathlib.Path(pkg.name) / rel))

    size = zip_path.stat().st_size
    print(f"完成：{zip_path.name}  {size/1048576:.1f} MB")

    # 校验：解压回来数一遍文件数，并抽查 node.exe 的 sha256
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        assert len(names) == len(items), f"文件数不符：{len(names)} != {len(items)}"
        with z.open(f"{pkg.name}/runtime/node.exe") as src:
            import hashlib
            h = hashlib.sha256(src.read()).hexdigest()
    print(f"校验通过：{len(names)} 个条目，runtime/node.exe sha256 = {h}")


if __name__ == "__main__":
    main()

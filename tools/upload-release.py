#!/usr/bin/env python3
"""往 GitHub Release 传附件。

用法：
  python tools/upload-release.py v1.3.0 --upload terminal/dist/online-vwi-terminal-1.3.0-x64.exe
  python tools/upload-release.py v1.5.0 --note .release-notes/v1.5.0.md   # 只更新说明

只做两件事：更新 Release 说明、上传附件。Release 本身用创建脚本建好。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/carl800-1/online-vwi/releases"
TOKEN_FILE = Path(os.path.expanduser("~/.workbuddy/secrets/github_pat.txt"))


def token() -> str:
    t = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not t:
        sys.exit(f"PAT 为空，请用 notepad {TOKEN_FILE} 填写")
    return t


def api(method: str, url: str, data=None, ctype="application/json; charset=utf-8"):
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token(),
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": ctype,
            "User-Agent": "online-vwi-release-uploader",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {method} {url}\n{e.read().decode('utf-8', 'replace')[:800]}")


def find_release(tag: str) -> dict:
    # /releases/tags/<tag> 返回的是**单个对象**，不是数组（写错会报
    # "string indices must be integers"，'str' object 没有 tag_name 键）
    rel = api("GET", API + f"/tags/{tag}")
    if rel.get("tag_name") != tag:
        sys.exit(f"远端返回的 tag 是 {rel.get('tag_name')!r}，不是 {tag!r}")
    return rel


def set_note(rel: dict, note_path: str) -> None:
    body = Path(note_path).read_text(encoding="utf-8")
    api(
        "PATCH",
        API + f"/{rel['id']}",
        json.dumps({"body": body}).encode("utf-8"),
    )
    print(f"  说明已更新（{len(body)} 字符）")


def upload(rel: dict, path: str) -> None:
    p = Path(path)
    if not p.is_file():
        sys.exit(f"文件不存在：{p}")
    size = p.stat().st_size
    name = p.name
    for a in rel["assets"]:
        if a["name"] == name:
            print(f"  已存在，跳过：{name}")
            return
    url = (
        f"https://uploads.github.com/repos/carl800-1/online-vwi/releases/"
        f"{rel['id']}/assets?name={urllib.parse.quote(name)}"
    )
    print(f"  上传 {name}（{size / 1048576:.1f} MB）…")
    with p.open("rb") as f:
        req = urllib.request.Request(
            url,
            data=f,
            method="POST",
            headers={
                "Authorization": "Bearer " + token(),
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
                "User-Agent": "online-vwi-release-uploader",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=3600) as r:
                j = json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"HTTP {e.code}\n{e.read().decode('utf-8', 'replace')[:800]}")
    print(f"  完成：{j['browser_download_url']}")


def main() -> None:
    """用法：upload-release.py <tag> [--note <md>] [--upload <file>]...

    注意 --upload 后面的路径必须紧挨着（argv 里天然如此），
    但**路径不能以 -- 开头**，否则和旗标混淆。
    """
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    tag = sys.argv[1]
    note = None
    uploads = []
    i = 2
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--note":
            note = sys.argv[i + 1]
            i += 2
        elif arg == "--upload":
            uploads.append(sys.argv[i + 1])
            i += 2
        else:
            uploads.append(arg)
            i += 1

    print(f"[{tag}] 定位 Release…")
    rel = find_release(tag)
    if note:
        set_note(rel, note)
    for u in uploads:
        upload(rel, u)
    if not note and not uploads:
        print("  什么都没做")


if __name__ == "__main__":
    main()
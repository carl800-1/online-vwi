#!/usr/bin/env python3
"""删掉 Release 上传错的附件。用法：delete-asset.py <tag> <asset_name>"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_FILE = Path(os.path.expanduser("~/.workbuddy/secrets/github_pat.txt"))
API = "https://api.github.com/repos/carl800-1/online-vwi/releases"

tag, asset_name = sys.argv[1], sys.argv[2]
tk = TOKEN_FILE.read_text(encoding="utf-8").strip()
hdr = {
    "Authorization": "Bearer " + tk,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "online-vwi-release-uploader",
}


def call(method, url):
    req = urllib.request.Request(url, method=method, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r) if method == "GET" else None
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {method}\n{e.read().decode('utf-8', 'replace')[:500]}")


rel = call("GET", API + f"/tags/{tag}")
hit = [a for a in rel["assets"] if a["name"] == asset_name]
if not hit:
    print(f"tag {tag} 上没有名为 {asset_name} 的附件；现有：{[a['name'] for a in rel['assets']]}")
    sys.exit(0)
for a in hit:
    # 删附件的端点是 /releases/assets/<asset_id>，
    # **不是** /releases/<release_id>/assets/<asset_id>（后者 404）
    call("DELETE", API.replace("/releases", "/releases/assets") + f"/{a['id']}")
    print(f"已删除 {a['name']}（asset id={a['id']}）")
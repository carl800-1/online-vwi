#!/usr/bin/env python3
"""建 GitHub Release（tag 已存在，只建 release 壳）。用法：create-release.py <tag> <name> <note.md>"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_FILE = Path(os.path.expanduser("~/.workbuddy/secrets/github_pat.txt"))
API = "https://api.github.com/repos/carl800-1/online-vwi/releases"

tag, name, note = sys.argv[1], sys.argv[2], sys.argv[3]
tk = TOKEN_FILE.read_text(encoding="utf-8").strip()
if not tk:
    sys.exit(f"PAT 为空：{TOKEN_FILE}")

body = Path(note).read_text(encoding="utf-8")
data = json.dumps(
    {"tag_name": tag, "name": name, "body": body, "draft": False, "prerelease": False}
).encode("utf-8")
req = urllib.request.Request(
    API,
    data=data,
    method="POST",
    headers={
        "Authorization": "Bearer " + tk,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "online-vwi-release-uploader",
    },
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.load(r)
    print(f"OK {tag} id={j['id']} {j['html_url']}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code} {e.read().decode('utf-8', 'replace')[:500]}")
    sys.exit(1)
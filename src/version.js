// 版本号只有这一个来源。
//
// 之前 server.js、server-gui 横幅各读一次 package.json，而 /api/status 里干脆
// 写死了 '2.0.0' —— 接口对外报了个根本不存在的版本，现场排查时会被带偏。
// 现在统一从这里取，读不到就退回 '0.0.0'，绝不让服务因为读不到版本号而起不来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let v = '0.0.0';
try {
  v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || v;
} catch { /* 读不到就用占位值，不影响运行 */ }

export const VERSION = v;
// 通用工具：ID、时间、哈希、文本处理
import crypto from 'node:crypto';
import fs from 'node:fs';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz'; // 去掉 i l o u，避免手抄歧义

export function uid(prefix = '') {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += B32[bytes[i] % 32];
  return prefix ? `${prefix}_${s}` : s;
}

export function now() {
  return Date.now();
}

/** 人类可读的编码：ESOP-7K2M9Q，便于现场口头报读 */
export function humanCode(prefix = 'ESOP') {
  const chars = 'ACDEFGHJKLMNPQRTUVWXY34679';
  let s = '';
  const b = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += chars[b[i] % chars.length];
  return `${prefix}-${s}`;
}

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(path);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

export function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function str(v, max = 200) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

export function int(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** 稳定序列化：对象键排序，保证同一内容 hash 一致 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 从终端请求里抠出「这台机器长什么样」。
 *
 * 全部走 query：终端主进程拼 URL 最省事，也不用为心跳单独开一个 POST。
 * 字段都可选 —— 老版本终端只带 op，缺的字段就保留上一次的值，不会把档案冲成空。
 * 分辨率用 res=1920x1080，版本用 ver=1.6.0，磁盘剩余 MB 用 free，下载进度用 pd/pt。
 */
export function termMeta(ctx) {
  const qy = ctx.query || {};
  const meta = {};
  if (ctx.ip) meta.ip = ctx.ip;
  if (qy.res) meta.res = qy.res;
  if (qy.ver) meta.ver = qy.ver;
  if (qy.free !== undefined && qy.free !== '') meta.free = Number(qy.free) * 1024 * 1024;
  if (qy.pd !== undefined && qy.pd !== '') meta.done = Number(qy.pd);
  if (qy.pt !== undefined && qy.pt !== '') meta.total = Number(qy.pt);
  if (qy.model) meta.modelCode = String(qy.model).slice(0, 32);
  if (qy.st) meta.status = qy.st;
  return meta;
}

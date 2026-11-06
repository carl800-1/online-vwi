// 只为给「终端设置页」截图用的假 preload。
// 真终端的 window.vwi 由 main.js 的 IPC 提供，这里用 node:http 直接请求服务端，
// 让 setup.html 走的是同一套调用与同一条错误分支，截出来的界面就是真界面。
const { contextBridge } = require('electron');
const http = require('node:http');

const BASE = process.env.SETUP_SHOT_SERVER || 'http://127.0.0.1:8114';

function getJson(base, path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = 'HTTP ' + res.statusCode;
          try { msg = JSON.parse(body).error || msg; } catch { /* 保留状态码 */ }
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('连接超时')));
  });
}

function norm(s) {
  const t = String(s || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : 'http://' + t;
}

contextBridge.exposeInMainWorld('vwi', {
  probe: async (server) => {
    const url = norm(server);
    try {
      const [lines, st] = await Promise.all([
        getJson(url, '/api/lines'),
        getJson(url, '/api/status').catch(() => null)
      ]);
      const list = lines.lines || [];
      const active = list.find((l) => l.enabled) || list[0] || null;
      const procs = active
        ? await getJson(url, '/api/processes?lineId=' + encodeURIComponent(active.id))
        : { processes: [] };
      return {
        ok: true,
        server: url,
        version: (st && st.version) || '',
        modelCode: (st && st.model && st.model.code) || '',
        lines: list,
        activeLineCode: active ? active.code : '',
        processes: procs.processes || []
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  lineProcesses: async (_server, lineId) => {
    try {
      const r = await getJson(BASE, '/api/processes?lineId=' + encodeURIComponent(lineId));
      return { ok: true, processes: r.processes || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  saveConfig: async () => ({ ok: true }),
  openContentDir: () => {},
  openLog: () => {},
  quit: () => {},
  snapshot: async () => ({ line: '', op: '', status: null, view: null }),
  cacheStats: async () => ({
    modelCode: 'X200',
    files: 1,
    bytes: 0,
    currentDir: 'C:\\Users\\Chenzhichao\\AppData\\Local\\esop-client\\content\\current'
  })
});

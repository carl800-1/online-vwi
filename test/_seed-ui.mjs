// UI 点检用的最小数据：两条运行线 + 三个机种（其中一条线故意不挂机种，用来看空态）。
//
//   node test/_seed-ui.mjs            （默认 http://127.0.0.1:8093）
//   BASE=http://127.0.0.1:8094 node test/_seed-ui.mjs
//
// 可重复跑：线体名 / 机种编号已存在就跳过，不会报错。
const BASE = process.env.BASE || process.env.VWI_UI_BASE || 'http://127.0.0.1:8093';

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
  return { status: r.status, body: j, text: txt };
}

async function main() {
  const st = await req('GET', '/api/status');
  if (st.status !== 200) throw new Error(`服务没起来：${BASE} → ${st.status}`);

  const lines = (await req('GET', '/api/lines')).body.lines || [];
  const found = (n) => lines.find((l) => l.name === n);
  const foundCode = (c) => lines.find((l) => l.code === c);

  // 1# 挂机种、2# 空着。空库自带一条「一线 / L1」，直接收编当 1#，别硬建重名编码。
  let l1 = found('1#') || foundCode('L1');
  if (l1 && l1.name !== '1#') {
    const r = await req('PUT', `/api/lines/${l1.id}`, { name: '1#' });
    if (r.status === 200) l1 = r.body;
  }
  if (!l1) {
    const r = await req('POST', '/api/lines', { name: '1#', code: 'L1', status: 'running', slots: 15 });
    if (r.status !== 200) throw new Error('建线 1# 失败：' + r.text);
    l1 = r.body;
  }
  let l2 = found('2#') || foundCode('L2');
  if (!l2) {
    const r = await req('POST', '/api/lines', { name: '2#', code: 'L2', status: 'running', slots: 15 });
    if (r.status !== 200) throw new Error('建线 2# 失败：' + r.text);
    l2 = r.body;
  }
  // 两条都必须 running，否则推送面板里看不到
  for (const l of [l1, l2]) {
    if (l.status !== 'running') await req('PUT', `/api/lines/${l.id}`, { status: 'running' });
  }

  const codes = ['CR13VCA1', 'C7MFAH6', 'CR12V7A1'];
  for (const code of codes) {
    const r = await req('POST', '/api/models', { code, name: code + ' 测试机种', processCount: 4, lineIds: [l1.id] });
    if (r.status !== 200 && !/已存在/.test(r.text)) throw new Error(`建机种 ${code} 失败：${r.text}`);
  }
  // 已存在的机种也要确保挂在 1# 上
  const models = (await req('GET', '/api/models')).body.models || [];
  for (const code of codes) {
    const m = models.find((x) => x.code === code);
    if (m && !(m.lineIds || []).includes(l1.id)) {
      await req('PUT', `/api/models/${m.id}`, { lineIds: [...(m.lineIds || []), l1.id] });
    }
  }

  console.log(`数据就绪：1#=${l1.id}（${codes.length} 个机种）、2#=${l2.id}（空）`);
}

main().catch((e) => { console.error('seed 失败：', e.message); process.exit(1); });

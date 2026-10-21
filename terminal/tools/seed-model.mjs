// 把测试图上传到服务端并配成某型号的"每工序一张"清单。
// 用法：node tools/seed-model.mjs X210 http://127.0.0.1:8092
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = process.argv[2] || 'X210';
const BASE = (process.argv[3] || 'http://127.0.0.1:8092').replace(/\/+$/, '');
const mediaDir = path.join(__dirname, 'probe', 'media');

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url} → ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  const models = (await json(`${BASE}/api/models`)).models;
  const procs = (await json(`${BASE}/api/processes`)).processes;
  const model = models.find((m) => m.code === MODEL);
  if (!model) throw new Error(`型号 ${MODEL} 不存在`);
  console.log(`型号 ${model.code} = ${model.id}，工序 ${procs.map((p) => p.code).join('/')}`);

  for (const p of procs) {
    // 同一工序可能有多张（xxx-op10.png / xxx-op10-1.png / -2 …），按文件名排序后整批提交
    const prefix = `${MODEL.toLowerCase()}-${p.code.toLowerCase()}`;
    const files = fs.readdirSync(mediaDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
      .sort();
    if (!files.length) { console.warn(`跳过 ${p.code}：缺少 ${prefix}*.png`); continue; }

    const items = [];
    for (const f of files) {
      const full = path.join(mediaDir, f);
      const up = await json(`${BASE}/api/media/upload?filename=${encodeURIComponent(f)}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: fs.readFileSync(full)
      });
      items.push({ mediaId: up.id, dwellSec: 5 });
      console.log(`  ${p.code} ← ${f} ${up.id} (${up.width}x${up.height}, ${(up.bytes / 1024 / 1024).toFixed(2)}MB)`);
    }

    await json(`${BASE}/api/playlist`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: model.id, processId: p.id, items })
    });
  }
  console.log('完成');
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });

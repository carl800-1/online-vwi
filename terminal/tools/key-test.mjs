// 键盘拦截验收：往真实窗口里发按键，看 kiosk 该拦的拦住、逃生门该开的能开。
// 用法：node tools/key-test.mjs <CDP端口> <组合键> [等待毫秒]
//   组合键：alt+f4 | ctrl+alt+shift+q | ctrl+w | f11 | f5
const port = Number(process.argv[2] || 9228);
const combo = (process.argv[3] || 'alt+f4').toLowerCase();
const waitMs = Number(process.argv[4] || 1500);

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYMAP = {
  f4: { key: 'F4', code: 'F4', vk: 115 },
  f5: { key: 'F5', code: 'F5', vk: 116 },
  f11: { key: 'F11', code: 'F11', vk: 122 },
  q: { key: 'q', code: 'KeyQ', vk: 81 },
  w: { key: 'w', code: 'KeyW', vk: 87 }
};

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p.resolve(m); }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('超时')); } }, 5000);
  });

  const parts = combo.split('+');
  let mods = 0;
  for (const p of parts.slice(0, -1)) mods |= MOD[p] || 0;
  const spec = KEYMAP[parts[parts.length - 1]];
  if (!spec) throw new Error('不支持的按键：' + combo);

  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: mods, key: spec.key, code: spec.code,
    windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: mods, key: spec.key, code: spec.code,
    windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk
  });
  console.log(`已发送 ${combo}（modifiers=${mods}）`);

  await new Promise((r) => setTimeout(r, waitMs));
  // 窗口还在不在：再请求一次页面标题
  try {
    const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    console.log(`窗口仍在，标题：${r.result.result.value}`);
    ws.close();
    process.exit(0);
  } catch {
    console.log('窗口已消失（进程退出）');
    process.exit(2);
  }
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });

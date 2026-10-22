// 在线 VWI 发布系统 · 服务端入口（命令行外壳）
// 层级：型号 → 工序 → 播放清单，到此为止（没有工位）
//
// 这层只管三件事：调核心、打印横幅、处理 Ctrl+C。
// 真正的服务逻辑在 src/server-core.js —— 桌面版（server-gui）要复用同一份，
// 不能让它拖着命令行行为一起走。
import { listen, summary, portFromArgv } from './src/server-core.js';

const inst = await listen({ port: portFromArgv() || undefined });
const PORT = inst.server.address().port;
const s = summary(inst);

console.log('');
console.log('  在线 VWI 发布系统 v' + s.version);
console.log('  ────────────────────────────────────────────');
console.log('  管理端    http://127.0.0.1:' + PORT + '/');
console.log('  终端画面  http://127.0.0.1:' + PORT + '/player.html?op=OP30');
console.log('  数据目录  ' + s.data);
console.log('  内容      ' + s.items + ' 条清单项，媒体 ' + s.mediaCount + ' 个 / ' + (s.mediaBytes / 1048576).toFixed(1) + 'MB');
if (inst.seeded.created) {
  console.log('');
  console.log('  已生成：' + inst.seeded.models + ' 个型号 × ' + inst.seeded.processes + ' 道工序（内容为空，等工程部填）');
}
if (s.lan.length) {
  console.log('');
  console.log('  局域网访问（终端装机器上填这个）：');
  // s.lan 是 [{ name, address }]，已按「真网卡优先」排好序，虚拟网卡排后面
  for (const a of s.lan) console.log('    http://' + a.address + ':' + PORT + '   ← ' + a.name);
}
console.log('');

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  inst.server.close(() => process.exit(0));
});
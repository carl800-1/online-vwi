// 验证终端配置目录从 online-vwi-terminal 迁到 esop-client 的三种情况
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CFG = path.join(__dirname, '..', 'src', 'config.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

function fresh() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'esop-mig-'));
  process.env.LOCALAPPDATA = base;
  delete process.env.ESOP_TERMINAL_ROOT;
  delete process.env.VWI_TERMINAL_ROOT;
  delete require.cache[require.resolve(CFG)];
  return base;
}

function seedLegacy(base, cfgObj) {
  const dir = path.join(base, 'online-vwi-terminal');
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  if (cfgObj) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfgObj), 'utf8');
  fs.writeFileSync(path.join(dir, 'content', 'a.txt'), 'x');
  return dir;
}

// ── 1. 老目录有配置 → 迁到新目录，内容一起搬 ──
console.log('\n【1】老目录存在且有 config.json');
{
  const base = fresh();
  const legacy = seedLegacy(base, { op: 'OP30', server: 'http://1.2.3.4:8092' });
  const cfg = require(CFG);
  ok('root 指向 esop-client', path.basename(cfg.PATHS.root) === 'esop-client', cfg.PATHS.root);
  ok('迁移成功', cfg.MIGRATION.migrated === true, JSON.stringify(cfg.MIGRATION));
  ok('新目录有 config.json', fs.existsSync(path.join(base, 'esop-client', 'config.json')));
  ok('content 一起搬过来', fs.existsSync(path.join(base, 'esop-client', 'content', 'a.txt')));
  ok('老目录已消失（rename 语义）', !fs.existsSync(legacy));
  const c = cfg.load();
  ok('读得到原来的 op', c.op === 'OP30', c.op);
  ok('读得到原来的 server', c.server === 'http://1.2.3.4:8092', c.server);
}

// ── 2. 老目录有 config，但新目录已装过（有 config）→ 不迁，用新的 ──
console.log('\n【2】新目录已经有 config.json（已升过级）');
{
  const base = fresh();
  seedLegacy(base, { op: 'OP10', server: 'http://old:8092' });
  fs.mkdirSync(path.join(base, 'esop-client'), { recursive: true });
  fs.writeFileSync(path.join(base, 'esop-client', 'config.json'),
    JSON.stringify({ op: 'OP50', server: 'http://new:8092' }), 'utf8');
  const cfg = require(CFG);
  ok('不触发迁移', cfg.MIGRATION.migrated === false);
  const c = cfg.load();
  ok('用的是新目录的配置', c.op === 'OP50', c.op);
  ok('老目录原样保留', fs.existsSync(path.join(base, 'online-vwi-terminal', 'config.json')));
}

// ── 3. 只有老目录、没有 config.json（装到一半）→ 也搬，别丢缓存 ──
console.log('\n【3】老目录存在但没有 config.json');
{
  const base = fresh();
  seedLegacy(base, null);
  const cfg = require(CFG);
  ok('仍然迁移（缓存不丢）', cfg.MIGRATION.migrated === true, JSON.stringify(cfg.MIGRATION));
  ok('content 已搬', fs.existsSync(path.join(base, 'esop-client', 'content', 'a.txt')));
}

// ── 4. 全新机器，两处都没有 → 直接用新目录 ──
console.log('\n【4】全新机器');
{
  const base = fresh();
  const cfg = require(CFG);
  ok('root 是新目录', path.basename(cfg.PATHS.root) === 'esop-client');
  ok('没有迁移动作', cfg.MIGRATION.migrated === false && !cfg.MIGRATION.error);
}

// ── 5. 测试用环境变量覆盖 → 完全不碰 LOCALAPPDATA ──
console.log('\n【5】ESOP_TERMINAL_ROOT 覆盖');
{
  const base = fresh();
  seedLegacy(base, { op: 'OP20', server: 'http://x:8092' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esop-root-'));
  process.env.ESOP_TERMINAL_ROOT = tmp;
  delete require.cache[require.resolve(CFG)];
  const cfg = require(CFG);
  ok('root 就是覆盖值', cfg.PATHS.root === tmp, cfg.PATHS.root);
  ok('不迁移', cfg.MIGRATION.migrated === false);
  ok('老目录没被动', fs.existsSync(path.join(base, 'online-vwi-terminal', 'config.json')));
  delete process.env.ESOP_TERMINAL_ROOT;
}

// ── 6. 旧环境变量 VWI_TERMINAL_ROOT 仍然认（现有测试脚本靠它）──
console.log('\n【6】旧名 VWI_TERMINAL_ROOT 兼容');
{
  const base = fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esop-root2-'));
  process.env.VWI_TERMINAL_ROOT = tmp;
  delete require.cache[require.resolve(CFG)];
  const cfg = require(CFG);
  ok('旧变量仍生效', cfg.PATHS.root === tmp, cfg.PATHS.root);
  delete process.env.VWI_TERMINAL_ROOT;
}

console.log('\n────────────────────────────');
console.log('  通过 ' + pass + '　失败 ' + fail);
console.log('────────────────────────────\n');
process.exit(fail ? 1 : 0);

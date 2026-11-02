// 造一份「已经跑了一上午」的数据，给界面截图用（一次性脚本）。
//
//   node test/_seed-prod.mjs <数据目录>
//
// 为什么直接写库而不是调接口：生产概况里的工时、产量是"当天累计"，
// 刚建好的库一条都没有，截图会全是「—」。要看到 84% 这种真实数字，
// 只能把台账补进去 —— 这属于造演示数据，不该有产品接口来做。
import { openDb, q, seed } from '../src/db.js';
import { uid, now } from '../src/util.js';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node test/_seed-prod.mjs <数据目录>');
  process.exit(1);
}

openDb(dir);
seed();

const d0 = new Date();
d0.setHours(0, 0, 0, 0);
const T0 = d0.getTime();
const p = (n) => String(n).padStart(2, '0');
const TODAY = `${d0.getFullYear()}-${p(d0.getMonth() + 1)}-${p(d0.getDate())}`;

const md = (code) => q.get('SELECT id FROM model WHERE code = ?', code);

// 一线用默认线，二线/三线新建
const l1 = q.get('SELECT * FROM line ORDER BY sort, code LIMIT 1');
q.run("UPDATE line SET name = '一线', code = '1#', status = 'running', enabled = 1 WHERE id = ?", l1.id);

function addLine(code, name, status, slots, sort) {
  const id = uid('ln');
  q.run(
    'INSERT INTO line(id, code, name, enabled, status, slots, sort, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, code, name, status === 'running' ? 1 : 0, status, slots, sort, T0
  );
  return id;
}
const l2 = addLine('L08', '二线', 'running', 6, 20);
addLine('1A5', '三线', 'maintain', 5, 30);

function setModel(lineId, modelId) {
  q.run('DELETE FROM line_state WHERE line_id = ?', lineId);
  q.run(
    'INSERT INTO line_state(line_id, current_model_id, next_model_id, pending_model_id, pending_deadline, seq) VALUES(?,?,?,?,?,?)',
    lineId, modelId, '', '', 0, 1
  );
}

const x200 = md('X200');
const x210 = md('X210');
setModel(l1.id, x200.id);
setModel(l2, x210.id);

/** 一天的台账：标准产能 / 计划工时 / 计划 / 累计 / 最近一小时 / 停机分钟 */
function input(modelId, std, shift, plan, done, hour, down) {
  q.run(
    `INSERT INTO prod_input(model_id, day, std_rate, shift_hours, plan_qty, done_qty, hour_qty, down_min, note, ts)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    modelId, TODAY, std, shift, plan, done, hour, down, '', now()
  );
}

// 一线做 X200：8 小时班，中途换型停机 70 分钟，已做 760 件
input(x200.id, 120, 8, 900, 760, 98, 70);
// 二线做 X210：同样的班，只停了 20 分钟，节拍低一些
input(x210.id, 95, 8, 640, 585, 88, 20);

console.log(JSON.stringify({
  day: TODAY,
  lines: q.all('SELECT name, code, status FROM line').map((l) => `${l.name}/${l.code}/${l.status}`),
  input: q.all('SELECT model_id, done_qty, hour_qty FROM prod_input').map((r) => `${r.model_id}:${r.done_qty}`)
}));

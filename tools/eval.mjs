// 本地评估分类器：node tools/eval.mjs [订单表] [labels.json]
// labels.json = { "lab": ["订单号", ...], "personal": [...] }（任一可省略）
// 只在本机读文件、打印统计，不写任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const T = require(path.join(here, '../js/xlsx-lite.js'));
const N = require(path.join(here, '../js/normalize.js'));
const C = require(path.join(here, '../js/classify.js'));

const file = process.argv[2] || path.join(here, '../local-data/订单数据.xlsx');
const labFile = process.argv[3] || path.join(here, '../local-data/labels.json');
const buf = fs.readFileSync(file);
const rows = await T.read(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), file);
const orders = N.rowsToOrders(rows);
const labels = fs.existsSync(labFile) ? JSON.parse(fs.readFileSync(labFile, 'utf8')) : {};
const truth = new Map();
for (const no of labels.lab || []) truth.set(no, 'lab');
for (const no of labels.personal || []) truth.set(no, 'personal');

const ctx = { compiled: C.compile(C.DEFAULT_RULES), norm: N.norm };
const results = C.classifyAll(orders, ctx);
const tally = {}, wrong = [];
let lines = 0;
for (const o of orders) for (const l of o.lines) {
  lines++;
  const r = results.get(l.id);
  const t = truth.get(o.no) || '未标注';
  tally[t] = tally[t] || { lab: 0, personal: 0, unsure: 0 };
  tally[t][r.cat]++;
  if (t !== '未标注' && r.cat !== t && r.cat !== 'unsure') wrong.push({ t, r, title: l.title.slice(0, 26) });
}
console.log(`订单 ${orders.length}，商品行 ${lines}，已标注订单 ${truth.size}`);
console.log('真实类别 → 判成 实验室 / 个人 / 待定');
for (const [t, v] of Object.entries(tally)) {
  const n = v.lab + v.personal + v.unsure;
  console.log(`  ${t.padEnd(8)} ${String(v.lab).padStart(4)} ${String(v.personal).padStart(4)} ${String(v.unsure).padStart(4)}   (共 ${n})`);
}
if (tally.lab) {
  const v = tally.lab, n = v.lab + v.personal + v.unsure;
  console.log(`\n实验室召回 ${(v.lab / n * 100).toFixed(1)}%，误判为个人 ${v.personal} 件，交给人判 ${v.unsure} 件`);
}
if (wrong.length) {
  console.log('\n判反的：');
  for (const w of wrong) console.log(`  应为${w.t} 判成${w.r.cat}  ${w.r.why}  | ${w.title}`);
}

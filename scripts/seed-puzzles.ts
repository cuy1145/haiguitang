/**
 * 题库种子核对脚本（`pnpm seed`）。
 * 打印种子题库的结构摘要与事实集规模，便于人工核对题库与判定关键词是否配套。
 * 不入库、不发网络请求——真正的入库在服务启动时自动完成（保存于 SQLite）。
 */
import { seedPuzzles, BOT_QUESTIONS } from '../packages/server/src/data/seed-puzzles.ts';

const puzzles = seedPuzzles();
console.log(`\n题库种子：${puzzles.length} 道题\n`);
for (const p of puzzles) {
  const required = p.facts.filter((f) => f.required).length;
  const falseCount = p.facts.filter((f) => !f.isTrue).length;
  console.log(`· [${p.id}] ${p.title}`);
  console.log(`  汤面：${p.surface.slice(0, 40)}…`);
  console.log(`  分级：${p.rating}  难度：${p.difficulty}  预计：${p.estMinutes} 分钟  标签：${p.tags.join('/') || '—'}`);
  console.log(`  事实点：${p.facts.length}（必需 ${required} / 否定 ${falseCount}）  汤底 ${p.truth.truth.length} 字`);
  console.log(`  机器人提问脚本：${(BOT_QUESTIONS[p.id] ?? []).length} 条`);
  const missingKeys = p.facts.filter((f) => !f.keys || f.keys.length === 0);
  if (missingKeys.length > 0) console.log(`  ⚠ 有 ${missingKeys.length} 条事实点缺少关键词（模拟主持人将无法命中）`);
  console.log('');
}
const noTruth = puzzles.filter((p) => !p.truth.truth || p.truth.truth.length < 20);
if (noTruth.length > 0) {
  console.error('✗ 存在汤底过短的题目：', noTruth.map((p) => p.id).join(', '));
  process.exitCode = 1;
} else {
  console.log('✓ 结构与事实集自检通过（更严格的坏题检测属于题库脚本，见 docs/DESIGN.md §4）');
}

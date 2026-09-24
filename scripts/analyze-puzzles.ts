/**
 * 题库体检 —— `pnpm analyze:puzzles`
 *
 * 把一整个题库（例如 HuggingFace 上 2 万道题）拉下来，**统一分析有没有问题**，
 * 产出一份人看的报告 + 机器可读的数据，并把"能用的题"单独导出，供后续补事实点入库。
 *
 * 它回答四类问题：
 *   ① 数据本身干不干净：缺字段、长度异常、markdown/客套话残留、模型自言自语
 *   ② 体裁对不对：超自然当谜底、猎奇血腥、违禁内容（这些玩家没法用"是/否"推）
 *   ③ 有没有重复：一模一样 / 高度相似（近似去重用 SimHash + 分桶比较，2 万条约几秒）
 *   ④ 逻辑闭不闭合的**代理指标**：汤底复述汤面、汤面没问句、汤底里出现了汤面没有的人名地名
 *
 * 用法：
 *   pnpm analyze:puzzles --source=file:data/haiguitang-raw.jsonl          # 本地文件（推荐先下好）
 *   pnpm analyze:puzzles --source=hf-file:lpj990/haiguitang/neww_clue_data.jsonl --hf-endpoint=https://hf-mirror.com
 *   pnpm analyze:puzzles --source=hf:lpj990/haiguitang --limit 2000       # 走 datasets-server（慢）
 *   pnpm analyze:puzzles --source=file:data/x.jsonl --dump                # 额外导出逐条判定 (JSONL)
 *
 * 产物（默认写到 data/，该目录已被 .gitignore 忽略，不会进仓库）：
 *   data/puzzle-analysis.md      人看的报告
 *   data/puzzle-analysis.json    机器可读的统计
 *   data/candidates.jsonl        通过质检且不重复的题（下一步补事实点用）
 *   data/rejected.jsonl          被拒的题 + 原因（--dump 时）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanPuzzleText, screenPuzzleText, similarity } from '../packages/core/src/index.ts';
import { seedPuzzles } from '../packages/server/src/data/seed-puzzles.ts';
import { fetchSource, genericAdapter, licenseOf, type RawItem } from './lib/sources.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const source = arg('source') ?? 'file:data/haiguitang-raw.jsonl';
const hfEndpoint = arg('hf-endpoint') ?? 'https://huggingface.co';
const outDir = resolve(root, arg('out-dir') ?? 'data');
const limit = Number(arg('limit') ?? 0);           // 0 = 全量
const dump = args.includes('--dump');
const topN = Number(arg('top') ?? 8);
const nearDupOn = !args.includes('--no-near-dup');

// ---------------------------------------------------------------- 工具
const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
const pct = (n: number, total: number): string => `${((n / Math.max(1, total)) * 100).toFixed(1)}%`;

function quantiles(nums: number[]): { min: number; p25: number; p50: number; p75: number; p95: number; max: number; avg: number } {
  if (nums.length === 0) return { min: 0, p25: 0, p50: 0, p75: 0, p95: 0, max: 0, avg: 0 };
  const s = [...nums].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { min: s[0]!, p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), max: s[s.length - 1]!, avg: nums.reduce((a, b) => a + b, 0) / nums.length };
}

/** 64 位 SimHash（近似去重用）：对 4-gram 做哈希后按位投票 */
function simhash(text: string): bigint {
  const t = norm(text);
  const bits = new Array<number>(64).fill(0);
  for (let i = 0; i + 4 <= t.length; i++) {
    let h = 1469598103934665603n;
    for (let j = 0; j < 4; j++) {
      h ^= BigInt(t.charCodeAt(i + j));
      h = (h * 1099511628211n) & 0xffffffffffffffffn;
    }
    for (let b = 0; b < 64; b++) bits[b]! += ((h >> BigInt(b)) & 1n) === 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (bits[b]! > 0) out |= 1n << BigInt(b);
  return out;
}
const hamming = (a: bigint, b: bigint): number => {
  let x = a ^ b; let c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
};

/** 汤面里"不是谜题"的信号：模型自言自语 / 编号列表 / 多题混装 */
const CHATTER = [/^\s*(可以|好的|当然|下面|这是|以下)/, /(题目|示例|如下)\s*[:：]/, /\*\*|```|^#{1,6}\s/m, /(希望|如需|欢迎)[^。！？]{0,12}(喜欢|帮助|继续)/];
const ASK = /(为什么|为何|怎么回事|发生了什么|推理|猜|解释|原因|真相是|请问)/;
/** 内容风险权重（命中一次就加这么多分；用于排序抽检，不是硬门槛） */
const RISK_WORDS: Array<[RegExp, number, string]> = [
  [/强奸|性侵|猥亵|恋童|轮奸|幼女/, 40, '性暴力/涉未成年'],
  [/囚禁|绑架|拐卖|虐待|家暴|虐杀/, 30, '囚禁/虐待'],
  [/碎尸|肢解|分尸|剥皮|割喉|掏空|挖出|内脏|脑浆|眼球/, 25, '猎奇血腥'],
  [/恶魔|鬼魂|恶灵|诅咒|附体|僵尸|巫术|投胎|通灵/, 20, '超自然/灵异'],
  [/激光分解|外星|平行宇宙|时空穿越|丧尸|基因变异|克隆人|世界末日/, 20, '科幻/灾难'],
  [/自杀|跳楼|割腕/, 10, '自伤'],
];

/** 把原因归并成稳定的分类（否则报告里会出现"只剩 2 字/9 字/8 字…"几十行） */
function canonicalReason(reason: string): string {
  if (/清洗后(汤面|汤底)/.test(reason)) return '清洗后长度不合格（太短或超过上限）';
  if (/命中违禁/.test(reason)) return '命中违禁关键词（政治/色情/危险操作等）';
  if (/超自然|灵异/.test(reason)) return '谜底靠超自然/灵异 —— 玩家无法用「是/否」推出';
  if (/性暴力|虐待|囚禁/.test(reason)) return '涉及性暴力 / 虐待 / 囚禁 —— 朋友局不合适';
  if (/猎奇血腥/.test(reason)) return '猎奇血腥描写 —— 不适合朋友局';
  if (/科幻|灾难/.test(reason)) return '谜底是科幻/超自然灾难 —— 破坏「封闭世界」';
  return reason;
}

interface Row {
  idx: number;
  rawSurface: string;
  rawTruth: string;
  surface: string;
  truth: string;
  cleaned: boolean;
  screenOk: boolean;
  reasons: string[];
  flags: string[];
  risk: number;
  riskTags: string[];
  hash: bigint;
  dupOf: number | null;
  conflictOf: number | null;
  nearOf: number | null;
}

// ---------------------------------------------------------------- 主流程
console.log('题库体检\n');
console.log(`源：${source}   许可：${licenseOf(source)}`);
const raw = await fetchSource(source, { want: limit > 0 ? limit : 20000, hfEndpoint });
let items: RawItem[] = genericAdapter(raw);
if (limit > 0) items = items.slice(0, limit);
console.log(`解析出 ${items.length} 条（源记录 ${Array.isArray(raw) ? raw.length : '非数组'}）\n`);

const rows: Row[] = [];
const reasonHist = new Map<string, number>();
const flagHist = new Map<string, number>();
const riskHist = new Map<string, number>();
const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };

console.log('① 逐条清洗 + 文本级质检…');
for (const [idx, it] of items.entries()) {
  const surface = cleanPuzzleText(it.surface);
  const truth = cleanPuzzleText(it.truth);
  const cleaned = surface !== it.surface.trim() || truth !== it.truth.trim();
  const screen = screenPuzzleText({ surface, truth });
  const reasons = screen.issues.map((i) => canonicalReason(i.reason));
  for (const r of reasons) bump(reasonHist, r);

  const flags: string[] = [];
  if (CHATTER.some((re) => re.test(it.surface) || re.test(it.truth))) flags.push('清洗前有 markdown/客套话（已自动清掉）');
  // 注意：海龟汤的汤面本来就常常不写问句（"为什么"是隐含的），所以只在"又短又没问句"时才提示
  if (!ASK.test(surface) && surface.length < 25) flags.push('汤面过短且没有提问（疑似残句）');
  if (similarity(surface, truth) >= 0.6) flags.push('汤底复述汤面（相似度过高）');
  if (truth.length < surface.length * 0.5) flags.push('汤底过短（可能没说清）');
  if (/\d+\s*[.、)]\s*\S/.test(surface)) flags.push('汤面疑似编号列表');
  for (const f of flags) bump(flagHist, f);

  // 内容风险分（排序抽检用）
  const all = `${surface}\n${truth}`;
  let risk = 0;
  const riskTags: string[] = [];
  for (const [re, w, tag] of RISK_WORDS) {
    if (re.test(all)) { risk += w; riskTags.push(tag); }
  }
  if (risk > 0) bump(riskHist, riskTags.join('+'));

  rows.push({ idx, rawSurface: it.surface, rawTruth: it.truth, surface, truth, cleaned, screenOk: screen.ok, reasons, flags, risk, riskTags, hash: simhash(surface), dupOf: null, conflictOf: null, nearOf: null });
}

const pass = rows.filter((r) => r.screenOk);
const rejected = rows.filter((r) => !r.screenOk);
console.log(`   通过 ${pass.length} / 拒绝 ${rejected.length}（通过率 ${pct(pass.length, rows.length)}）`);

console.log('② 精确去重 + 同题不同底检测…');
// 两种重复要分开算（评测集常见"同一道题多行、每行一个猜测"）：
//   · 完全重复：汤面 + 汤底都相同（同一道题出现多次）
//   · 冲突：汤面相同但汤底不同（同一道题配了两个"真相"，判定会自相矛盾）
const bySurface = new Map<string, number>();
const byPair = new Map<string, number>();
for (const r of rows) {
  const sKey = norm(r.surface);
  const pKey = `${sKey}|${norm(r.truth)}`;
  const firstSameSurface = bySurface.get(sKey);
  const firstSamePair = byPair.get(pKey);
  if (firstSamePair !== undefined) r.dupOf = firstSamePair;
  else if (firstSameSurface !== undefined && norm(rows[firstSameSurface]!.truth) !== norm(r.truth)) r.conflictOf = firstSameSurface;
  if (firstSameSurface === undefined) bySurface.set(sKey, r.idx);
  if (firstSamePair === undefined) byPair.set(pKey, r.idx);
}
const exactDups = rows.filter((r) => r.dupOf !== null).length;
const conflicts = rows.filter((r) => r.conflictOf !== null).length;
const uniquePuzzles = rows.length - exactDups;
console.log(`   独立题目 ${uniquePuzzles} 条 · 完全重复 ${exactDups} 条 · 同汤面不同汤底 ${conflicts} 条`);
for (const r of rows) {
  if (r.dupOf !== null) bump(reasonHist, '同一道题重复出现（汤面+汤底都相同）');
  if (r.conflictOf !== null) bump(reasonHist, '同一汤面配了不同汤底（题目自相矛盾）');
}

console.log('③ 近似去重（SimHash 64 位，Hamming ≤ 3）…');
if (nearDupOn) {
  // LSH：把 64 位切成 4 段，每段 16 位分桶；同桶内才算距离（避免 2 万 × 2 万的暴力比较）
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.dupOf !== null) continue;
    for (let seg = 0; seg < 4; seg++) {
      const key = `${seg}:${(r.hash >> BigInt(seg * 16)) & 0xffffn}`;
      const arr = buckets.get(key);
      if (arr) arr.push(r.idx); else buckets.set(key, [r.idx]);
    }
  }
  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > 60) continue;   // 超大同桶跳过，避免退化
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = rows[arr[i]!]!; const b = rows[arr[j]!]!;
        if (b.nearOf !== null || a.dupOf !== null || b.dupOf !== null) continue;
        if (hamming(a.hash, b.hash) <= 3) { b.nearOf = a.idx; break; }
      }
    }
  }
}
const nearDups = rows.filter((r) => r.nearOf !== null).length;
console.log(`   近似重复 ${nearDups} 条`);

// 与现有题库比
console.log('④ 与现有题库比对…');
const existing = seedPuzzles().map((p) => ({ id: p.id, title: p.title, surface: cleanPuzzleText(p.surface), hash: simhash(p.surface) }));
let clashExisting = 0;
for (const r of rows) {
  for (const e of existing) {
    if (norm(r.surface) === norm(e.surface) || hamming(r.hash, e.hash) <= 3) { clashExisting++; r.flags.push(`与现有题库《${e.title}》重复`); break; }
  }
}
console.log(`   与现有题库重复 ${clashExisting} 条\n`);

// ---------------------------------------------------------------- 汇总
// 可用的题：通过质检 + 不重复 + **内容风险分为 0**（有风险的单独列出来供人工抽检）
const usable = rows.filter((r) => r.screenOk && r.dupOf === null && r.nearOf === null && r.risk === 0);
const risky = rows.filter((r) => r.screenOk && r.dupOf === null && r.nearOf === null && r.risk > 0);
const surfaceLen = quantiles(rows.map((r) => r.surface.length));
const truthLen = quantiles(rows.map((r) => r.truth.length));
const cleanedCount = rows.filter((r) => r.cleaned).length;

// 估算下一步补事实点的 token 成本（经验值：输入≈汤面+汤底+提示词，输出≈600）
const estIn = Math.round(usable.reduce((a, r) => a + (r.surface.length + r.truth.length) * 1.6 + 500, 0));
const estOut = usable.length * 600;

const md: string[] = [];
md.push('# 题库体检报告\n');
md.push(`- 源：\`${source}\``);
md.push(`- 源许可：**${licenseOf(source)}**`);
md.push(`- 生成时间：${new Date().toISOString()}`);
md.push(`- 样本量：**${rows.length}** 条\n`);
md.push('## 一、结论\n');
md.push(`| 指标 | 数量 | 占比 |`);
md.push(`|---|---|---|`);
md.push(`| 原始条目 | ${rows.length} | 100% |`);
md.push(`| **独立题目**（汤面+汤底去重后） | **${uniquePuzzles}** | ${pct(uniquePuzzles, rows.length)} |`);
md.push(`| 文本级质检**通过** | ${pass.length} | ${pct(pass.length, rows.length)} |`);
md.push(`| 质检**拒绝** | ${rejected.length} | ${pct(rejected.length, rows.length)} |`);
md.push(`| 完全重复（汤面+汤底都相同） | ${exactDups} | ${pct(exactDups, rows.length)} |`);
md.push(`| 近似重复（SimHash ≤3） | ${nearDups} | ${pct(nearDups, rows.length)} |`);
md.push(`| 与现有题库撞题 | ${clashExisting} | ${pct(clashExisting, rows.length)} |`);
md.push(`| 需要清洗（markdown/标签/客套话） | ${cleanedCount} | ${pct(cleanedCount, rows.length)} |`);
md.push(`| 同汤面不同汤底（**题目自相矛盾**） | ${conflicts} | ${pct(conflicts, rows.length)} |`);
md.push(`| 通过质检但仍命中风险词（已排除在候选之外） | ${risky.length} | ${pct(risky.length, rows.length)} |`);
md.push(`| **可直接使用（质检通过 + 不重复 + 零内容风险）** | **${usable.length}** | **${pct(usable.length, rows.length)}** |\n`);

md.push('## 二、按拒绝原因分布\n');
md.push('| 原因 | 条数 |');
md.push('|---|---|');
for (const [k, v] of [...reasonHist.entries()].sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
md.push('');

md.push('## 三、文本特征\n');
md.push('| 长度 | min | p25 | 中位数 | p75 | p95 | max | 平均 |');
md.push('|---|---|---|---|---|---|---|---|');
md.push(`| 汤面（字） | ${surfaceLen.min} | ${surfaceLen.p25} | ${surfaceLen.p50} | ${surfaceLen.p75} | ${surfaceLen.p95} | ${surfaceLen.max} | ${surfaceLen.avg.toFixed(1)} |`);
md.push(`| 汤底（字） | ${truthLen.min} | ${truthLen.p25} | ${truthLen.p50} | ${truthLen.p75} | ${truthLen.p95} | ${truthLen.max} | ${truthLen.avg.toFixed(1)} |`);
md.push('');

md.push('## 四、可疑模式（即使通过质检也值得注意）\n');
md.push('| 模式 | 条数 |');
md.push('|---|---|');
for (const [k, v] of [...flagHist.entries()].sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
md.push('');
md.push('### 内容风险分布（风险分为 0 的才进 candidates.jsonl）\n');
md.push('| 风险类型 | 条数 |');
md.push('|---|---|');
for (const [k, v] of [...riskHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) md.push(`| ${k} | ${v} |`);
md.push('');

const show = (title: string, list: Row[]): void => {
  md.push(`### ${title}\n`);
  for (const r of list.slice(0, topN)) {
    md.push(`- **#${r.idx}** ${r.reasons.join('；') || r.flags.join('；')}`);
    md.push(`  - 汤面：${r.surface.slice(0, 90)}${r.surface.length > 90 ? '…' : ''}`);
    md.push(`  - 汤底：${r.truth.slice(0, 90)}${r.truth.length > 90 ? '…' : ''}`);
  }
  md.push('');
};
show('拒绝样例（前几条）', rejected);
show('题目自相矛盾（同汤面不同汤底）', rows.filter((r) => r.conflictOf !== null));
show('近似重复样例', rows.filter((r) => r.nearOf !== null));
show('有内容风险、已排除在外的样例', risky);

md.push('## 五、下一步成本估算\n');
md.push(`要把这 **${usable.length}** 道可用题补出事实点表（每道一次模型调用）：`);
md.push(`- 估算输入 ≈ ${(estIn / 1000).toFixed(0)}K token，输出 ≈ ${(estOut / 1000).toFixed(0)}K token`);
md.push(`- 按 DeepSeek flash 价位，几十万 token 大约**几毛到几块钱**（以实际账单为准）`);
md.push(`- 建议先 \`--limit 50\` 试一批，确认质量后再全量\n`);
md.push('## 六、怎么继续\n');
md.push('```powershell');
md.push('# 1) 只把可用的题导入（自动补事实点 + 坏题检测）');
md.push(`pnpm import:puzzles --source=file:${join('data', 'candidates.jsonl')} --accept-license=${licenseOf(source)} --limit 50`);
md.push('# 2) 满意后去掉 --limit 全量导入');
md.push('```');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'puzzle-analysis.md'), md.join('\n'), 'utf8');
writeFileSync(join(outDir, 'puzzle-analysis.json'), JSON.stringify({
  source, license: licenseOf(source), generatedAt: new Date().toISOString(),
  total: rows.length, pass: pass.length, rejected: rejected.length,
  exactDuplicates: exactDups, conflicts, nearDuplicates: nearDups, clashWithExisting: clashExisting,
  cleaned: cleanedCount, usable: usable.length, risky: risky.length,
  reasons: Object.fromEntries([...reasonHist.entries()].sort((a, b) => b[1] - a[1])),
  flags: Object.fromEntries([...flagHist.entries()].sort((a, b) => b[1] - a[1])),
  riskTags: Object.fromEntries([...riskHist.entries()].sort((a, b) => b[1] - a[1])),
  surfaceLen, truthLen, estTokens: { input: estIn, output: estOut },
}, null, 2), 'utf8');
writeFileSync(join(outDir, 'candidates.jsonl'), usable.map((r) => JSON.stringify({ surface: r.surface, truth: r.truth })).join('\n'), 'utf8');
if (dump) {
  writeFileSync(join(outDir, 'rejected.jsonl'), rows.filter((r) => !r.screenOk || r.dupOf !== null || r.nearOf !== null)
    .map((r) => JSON.stringify({ idx: r.idx, surface: r.surface, truth: r.truth, reasons: r.reasons, flags: r.flags, dupOf: r.dupOf, nearOf: r.nearOf })).join('\n'), 'utf8');
}

console.log('═══ 结论 ═══');
console.log(`可 用：${usable.length} / ${rows.length}（${pct(usable.length, rows.length)}）`);
console.log(`拒绝原因 top5：`);
for (const [k, v] of [...reasonHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${v.toString().padStart(6)}  ${k}`);
console.log(`可疑模式 top5：`);
for (const [k, v] of [...flagHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${v.toString().padStart(6)}  ${k}`);
console.log(`\n报告：data/puzzle-analysis.md`);
console.log(`可用题：data/candidates.jsonl（${usable.length} 条）`);
if (dump) console.log('明细：data/rejected.jsonl');

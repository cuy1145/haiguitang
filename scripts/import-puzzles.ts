/**
 * 题库导入 —— `pnpm import:puzzles`
 *
 * 为什么要它：我们的判定引擎依赖**事实点表**，而网上流传的题库基本只有「汤面 + 汤底」两栏。
 * 于是导入分四步：① 取源 → ② 清洗 + 文本级质检 → ③ **补事实点表** → ④ 结构校验 → 写文件。
 *
 * 补事实点有两种模式：
 *   `--facts=rule`（默认，**不需要 API Key、零成本**）
 *       用汤底拆句当成立事实；如果数据源自带「玩家猜测 + 对错标签」（如 Turtle-Bench），
 *       还会把 T 标签的猜测当成立事实、F 标签的当**否定型事实**（"玩家猜过但不成立"）。
 *   `--facts=ai`（需要 AI_KEY，质量更好）
 *       调模型拆原子事实，并顺带把繁体转成简体。
 *
 * 用法：
 *   pnpm import:puzzles --source=modelscope:Narcissuses/Turtle-Bench/train_8k.json --accept-license=apache-2.0
 *   pnpm import:puzzles --source=file:data/soup.jsonl --facts=ai --limit 50 --accept-license=apache-2.0
 *   pnpm import:puzzles --source=... --dry-run          # 只取源 + 质检，不写文件
 *
 * 产出：`packages/server/src/data/collected-puzzles.ts`（生成物，带来源/许可/时间头注释）
 *       提交后由 CI 自动部署 —— 题库是**编译进 Worker 的常量**，不走数据库。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveFacts } from './lib/facts.ts';
import { checkAndNormalizePuzzle, cleanPuzzleText, screenPuzzleText, summarizePuzzleIssues } from '../packages/core/src/puzzle-check.ts';
import { seedPuzzles } from '../packages/server/src/data/seed-puzzles.ts';
import { HostService } from '../packages/server/src/ai.ts';
import type { Puzzle } from '../packages/core/src/types.ts';
import { fetchSource, genericAdapter, licenseOf, type RawItem } from './lib/sources.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const has = (n: string): boolean => args.includes(`--${n}`);

const source = arg('source') ?? 'modelscope:Narcissuses/Turtle-Bench/train_8k.json';
const limit = Math.max(1, Number(arg('limit') ?? 5000));
const dryRun = has('dry-run');
const accepted = arg('accept-license');
const factsMode = (arg('facts') ?? (process.env.AI_KEY ? 'ai' : 'rule')) as 'rule' | 'ai';
const outFile = resolve(root, arg('out') ?? 'packages/server/src/data/collected-puzzles.ts');

/** 数据来源的署名信息（写进题库，前端会显示"题库来源"） */
const SOURCE_META: Record<string, { author: string; url: string; type: Puzzle['sourceType'] }> = {
  'Narcissuses/Turtle-Bench': { author: 'Turtle-Bench（ModelScope）', url: 'https://modelscope.cn/datasets/Narcissuses/Turtle-Bench', type: 'crawl' },
  'KONpiGG/astrbot_plugin_soupai': { author: 'astrbot_plugin_soupai（GitHub）', url: 'https://github.com/KONpiGG/astrbot_plugin_soupai', type: 'crawl' },
};
const sourceKey = source.replace(/^(modelscope|github):/, '').replace(/\/[^/]+\.(json|jsonl)$/i, '');
const meta = SOURCE_META[sourceKey] ?? { author: source, url: '', type: 'crawl' as const };

console.log('题库导入\n');
console.log(`源：${source}`);
console.log(`许可：${licenseOf(source)}   补事实点：${factsMode}${factsMode === 'rule' ? '（不需要 Key）' : '（需要 AI_KEY）'}\n`);

// ---------------------------------------------------------------- ① 许可确认
// 本地文件源（file:）无法自动识别许可，用 --license= 显式声明（例：--license=apache-2.0）
const license = arg('license') ?? licenseOf(source);
if (!dryRun) {
  if (!accepted) {
    console.error(`✗ 未确认源题库许可。确认接受后请加： --accept-license=${license}`);
    console.error('  说明：第三方题库并入仓库会带来相应许可义务（AGPL 有传染性），请自行判断。');
    process.exit(2);
  }
  if (accepted.toUpperCase() !== license.toUpperCase()) {
    console.error(`✗ 许可不匹配：源是 ${license}，你声明的是 ${accepted}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- ② 取源 + 清洗 + 质检
const raw = await fetchSource(source);
const items = genericAdapter(raw);
console.log(`解析出 ${items.length} 条原始记录`);

const existingSurfaces = new Set(seedPuzzles().map((p) => cleanPuzzleText(p.surface).replace(/\s+/g, '')));
const seen = new Set<string>();
const picked: RawItem[] = [];
for (const it of items) {
  const cleaned: RawItem = {
    ...(it.title ? { title: cleanPuzzleText(it.title).slice(0, 24) } : {}),
    surface: cleanPuzzleText(it.surface),
    truth: cleanPuzzleText(it.truth),
    ...(it.guesses ? { guesses: it.guesses.map((g) => ({ text: cleanPuzzleText(g.text), label: g.label })) } : {}),
  };
  const key = cleaned.surface.replace(/\s+/g, '');
  if (!key || existingSurfaces.has(key) || seen.has(key)) continue;   // 与现有题库、与源内去重
  seen.add(key);
  picked.push(cleaned);
  if (picked.length >= limit) break;
}
console.log(`去重后 ${picked.length} 条（源内重复 + 与现有题库撞题的已去掉）\n`);

const screened = picked.map((it) => ({ it, screen: screenPuzzleText(it) }));
// 另外挡两道：汤底太短（与 scripts/seed-puzzles.ts 的自检门槛保持一致：≥20 字）——
// 这类题通常是"一句话答案"的填充题，事实点也拆不出来。
const tooShort = screened.filter((s) => s.screen.ok && s.screen.truth.length < 20);
const passText = screened.filter((s) => s.screen.ok && s.screen.truth.length >= 20);
console.log(`文本级质检：通过 ${passText.length} / 拒绝 ${screened.length - passText.length}（其中汤底过短 ${tooShort.length}）`);
for (const f of screened.filter((s) => !s.screen.ok).slice(0, 6)) {
  console.log(`  ✗ ${f.screen.surface.slice(0, 24)}… → ${summarizePuzzleIssues(f.screen.issues)}`);
}

if (dryRun) {
  console.log(`\n（dry-run）正式导入会为这 ${passText.length} 道补事实点表：${factsMode === 'rule' ? '规则版，零成本' : '调用模型，每道一次'}。`);
  process.exit(0);
}

// ---------------------------------------------------------------- ③ 补事实点 + ④ 结构校验
const host = factsMode === 'ai' ? makeHost() : null;
if (factsMode === 'ai' && !host) {
  console.error('✗ --facts=ai 需要 AI_BASE_URL / AI_MODEL / AI_KEY（或改用 --facts=rule）');
  process.exit(3);
}

const acceptedPuzzles: Puzzle[] = [];
const rejected: Array<{ surface: string; why: string }> = [];
for (const [i, it] of passText.map((s) => s.it).entries()) {
  process.stdout.write(`\r补事实点 ${i + 1}/${passText.length}…`);
  let candidate: Record<string, unknown> = { ...(it.title ? { title: it.title } : {}), surface: it.surface, truth: it.truth, facts: deriveFacts(it) };

  if (host) {
    const res = await host.generateFacts(
      { apiKey: process.env.AI_KEY!, baseUrl: process.env.AI_BASE_URL!, model: process.env.AI_MODEL!, provider: 'openai-compatible' },
      { surface: it.surface, truth: it.truth },
    );
    if (!res.ok) { rejected.push({ surface: it.surface, why: `模型补事实点失败：${res.errorClass}` }); continue; }
    const rawFacts = res.raw as { surface_simplified?: string; truth_simplified?: string } & Record<string, unknown>;
    candidate = {
      ...(it.title ? { title: it.title } : {}),
      surface: typeof rawFacts.surface_simplified === 'string' && rawFacts.surface_simplified.trim() ? cleanPuzzleText(rawFacts.surface_simplified) : it.surface,
      truth: typeof rawFacts.truth_simplified === 'string' && rawFacts.truth_simplified.trim() ? cleanPuzzleText(rawFacts.truth_simplified) : it.truth,
      facts: rawFacts.facts ?? deriveFacts(it),
    };
  }

  const checked = checkAndNormalizePuzzle(candidate, {
    idPrefix: 'imp',
    minFacts: 2,                      // 短汤底只能拆出 2 条；2 条也够判定
    source: { type: meta.type, author: meta.author, url: meta.url, attributionRequired: true },
  });
  if (!checked.ok) { rejected.push({ surface: it.surface, why: summarizePuzzleIssues(checked.issues) }); continue; }
  acceptedPuzzles.push(checked.puzzle);
}
process.stdout.write('\r' + ' '.repeat(30) + '\r');

console.log(`\n通过校验：${acceptedPuzzles.length} 道；被拒：${rejected.length} 道`);
for (const r of rejected.slice(0, 8)) console.log(`  ✗ ${r.surface.slice(0, 26)}… → ${r.why}`);
if (acceptedPuzzles.length === 0) { console.error('没有任何题目通过校验，未写文件。'); process.exit(4); }

// ---------------------------------------------------------------- 写文件
const body = acceptedPuzzles.map((p) => JSON.stringify(p)).join(',\n  ');
const header = `/**
 * 导入题库（**由 pnpm import:puzzles 自动生成，请勿手改**）
 *
 * 源：${source}
 * 许可：${license}（运行导入时已显式确认接受）
 * 事实点来源：${factsMode === 'rule' ? '规则抽取（汤底拆句 + 数据集的猜测标签，未调用模型）' : '模型生成（含繁转简）'}
 * 生成时间：${new Date().toISOString()}
 * 题量：${acceptedPuzzles.length}（另有 ${rejected.length} 道未通过质检，已丢弃）
 *
 * 说明：题库是**编译进 Worker 的常量**（见 store-d1.ts 的 PUZZLES），不在数据库里；
 * 改完提交推送即可，CI 会自动部署。想更新题库：重跑导入脚本 → git push。
 */
import type { Puzzle } from '@ht/core';

const RAW: Puzzle[] = [
  ${body},
];

export function collectedPuzzles(): Puzzle[] {
  return RAW;
}
`;
writeFileSync(outFile, header, 'utf8');
console.log(`\n✓ 已写入 ${outFile.replace(root, '').replace(/^[\\/]/, '')}`);
console.log('  下一步：pnpm typecheck && pnpm test && git add -A && git commit && git push（CI 自动部署）');

function makeHost(): HostService | null {
  const baseUrl = process.env.AI_BASE_URL ?? '';
  const model = process.env.AI_MODEL ?? '';
  const key = process.env.AI_KEY ?? '';
  if (!baseUrl || !model || !key) return null;
  return new HostService({
    store: { getVerdict: () => null, putVerdict: () => {}, insertQuestion: () => {} } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    config: { enabled: true, provider: 'openai-compatible', baseUrl, model, key, timeoutMs: 60000, maxRetries: 1 },
    siteQuotaAllows: () => true,
  });
}

void readFileSync;

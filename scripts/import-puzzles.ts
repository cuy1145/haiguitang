/**
 * 题库导入（爬虫）—— `pnpm import:puzzles`
 *
 * 为什么需要它：我们的判定引擎依赖**事实点表**，而网上流传的题库基本只有「汤面 + 汤底」两栏。
 * 所以导入分两步：① 抓取并解析源题库 → ② 用模型为每道题补出事实点表 → ③ 过一遍坏题检测 → ④ 写文件。
 *
 * 用法：
 *   pnpm import:puzzles --source=github:KONpiGG/astrbot_plugin_soupai/network_soupai.json \
 *                       --accept-license=AGPL-3.0 --limit 40 [--dry-run]
 *
 * 参数：
 *   --source=<...>        支持三种：
 *                          github:owner/repo/path[#ref]  （走 GitHub Contents API，沙箱里也可用）
 *                          https://...                   （直接 GET，要求返回 JSON）
 *                          file:./local.json             （本地文件，便于离线调试）
 *   --limit=N             最多导入多少道（默认 30；模型调用要花钱，建议先小批量试）
 *   --accept-license=<id> 显式接受源题库的许可（AGPL-3.0 等）。**不传就不写文件**。
 *   --dry-run             只抓取 + 解析 + 报告，不调用模型、不写文件（用于先看质量）
 *   --out=<file>          输出文件（默认 packages/server/src/data/collected-puzzles.ts）
 *
 * 模型配置（补事实点用，复用服务端同一套 AI 配置）：
 *   AI_BASE_URL / AI_MODEL / AI_KEY     —— 也可以用 .env 或命令行环境变量
 *
 * 产出：目标文件里是一组**已通过校验**的 Puzzle，seedPuzzles() 会自动带上它们。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAndNormalizePuzzle, summarizePuzzleIssues } from '../packages/core/src/puzzle-check.ts';
import { seedPuzzles } from '../packages/server/src/data/seed-puzzles.ts';
import { HostService } from '../packages/server/src/ai.ts';
import type { Puzzle } from '../packages/core/src/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const source = arg('source') ?? 'github:KONpiGG/astrbot_plugin_soupai/network_soupai.json';
const limit = Math.max(1, Number(arg('limit') ?? 30));
const dryRun = has('dry-run');
const accepted = arg('accept-license');
const outFile = resolve(root, arg('out') ?? 'packages/server/src/data/collected-puzzles.ts');

/** 已知源题库的许可（未列出的一律要求显式确认） */
const SOURCE_LICENSES: Record<string, string> = {
  'github:KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
  'KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
};

interface RawItem { surface: string; truth: string }
type Adapter = (raw: unknown) => RawItem[];

/** 通用适配器：兼容 {surface,truth} / {puzzle,answer} / {question,answer} 等常见形态 */
const genericAdapter: Adapter = (raw: unknown): RawItem[] => {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown[] }).data) ? (raw as { data: unknown[] }).data : []);
  const out: RawItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const surface = [o.surface, o.puzzle, o.question, o.title_surface].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const truth = [o.truth, o.answer, o.bottom, o.solution].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    if (!surface || !truth) continue;
    out.push({ surface: surface.trim(), truth: truth.trim() });
  }
  return out;
};

async function fetchSource(src: string): Promise<unknown> {
  if (src.startsWith('file:')) {
    const p = resolve(root, src.slice(5));
    if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  if (src.startsWith('github:')) {
    const spec = src.slice(7);
    const [repoAndPath, ref] = spec.split('#');
    const parts = (repoAndPath ?? '').split('/');
    const repo = `${parts[0]}/${parts[1]}`;
    const path = parts.slice(2).join('/');
    if (!repo.includes('/') || !path) throw new Error('github 源格式应为 github:owner/repo/path[#ref]');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'haiguitang-import' };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `https://api.github.com/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}：${url}`);
    const body = await res.json() as { content?: string; encoding?: string; size?: number };
    if (!body.content) throw new Error('GitHub API 没有返回文件内容');
    const text = Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return JSON.parse(text);
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}：${src}`);
  return JSON.parse(await res.text());
}

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

// ---------------------------------------------------------------- 主流程
console.log('题库导入\n');
console.log(`源：${source}`);
console.log(`上限：${limit} 道${dryRun ? '（dry-run：不调用模型、不写文件）' : ''}\n`);

const license = SOURCE_LICENSES[source] ?? SOURCE_LICENSES[source.replace(/\/[^/]+$/, '')] ?? 'UNKNOWN';
if (!dryRun) {
  if (!accepted) {
    console.error('✗ 未确认源题库许可。若确认接受，请显式加上： --accept-license=' + license);
    console.error('  说明：本项目是 AGPL-3.0 的第三方题库，导入后你的仓库需要遵守该许可（有传染性）。');
    console.error('  不想承担这个义务的话，请改用房主端「AI 创作」——那不会把第三方数据写进仓库。');
    process.exit(2);
  }
  if (accepted.toUpperCase() !== license.toUpperCase()) {
    console.error(`✗ 许可不匹配：源是 ${license}，你声明的是 ${accepted}`);
    process.exit(2);
  }
}

const raw = await fetchSource(source);
const items = genericAdapter(raw);
console.log(`解析出 ${items.length} 道原始题目（源许可：${license}）`);

// 去重：与现有题库按汤面去重，源内也去重
const existingSurfaces = new Set(seedPuzzles().map((p) => p.surface.replace(/\s+/g, '')));
const seen = new Set<string>();
const picked: RawItem[] = [];
for (const it of items) {
  const key = it.surface.replace(/\s+/g, '');
  if (existingSurfaces.has(key) || seen.has(key)) continue;
  seen.add(key);
  picked.push(it);
  if (picked.length >= limit) break;
}
console.log(`去重后取前 ${picked.length} 道\n`);

if (dryRun) {
  console.log('前 3 道预览：');
  for (const it of picked.slice(0, 3)) {
    console.log(`· ${it.surface.slice(0, 60)}…`);
    console.log(`  汤底：${it.truth.slice(0, 60)}…`);
  }
  const missingFacts = picked.filter((it) => !/facts/.test(JSON.stringify(it))).length;
  console.log(`\n注意：源题库只有汤面+汤底，${missingFacts}/${picked.length} 道缺事实点表 —— 正式导入时由模型补齐（需 AI_KEY）。`);
  console.log('dry-run 结束，未写任何文件。');
  process.exit(0);
}

const host = makeHost();
if (!host) {
  console.error('✗ 缺少模型配置：请设置 AI_BASE_URL / AI_MODEL / AI_KEY（用来给每道题补事实点表）');
  console.error('  例：$env:AI_BASE_URL="https://api.deepseek.com"; $env:AI_MODEL="deepseek-flash"; $env:AI_KEY="sk-..."');
  process.exit(3);
}

const acceptedPuzzles: Array<{ puzzle: Puzzle; from: RawItem }> = [];
const rejected: Array<{ surface: string; why: string }> = [];
for (const [i, it] of picked.entries()) {
  process.stdout.write(`\r处理 ${i + 1}/${picked.length}…`);
  const factsRes = await host.generateFacts(
    { apiKey: process.env.AI_KEY!, baseUrl: process.env.AI_BASE_URL!, model: process.env.AI_MODEL!, provider: 'openai-compatible' },
    { surface: it.surface, truth: it.truth },
  );
  if (!factsRes.ok) { rejected.push({ surface: it.surface, why: `补事实点失败：${factsRes.errorClass}` }); continue; }
  const checked = checkAndNormalizePuzzle({ surface: it.surface, truth: it.truth, ...(factsRes.raw as object) }, { idPrefix: 'imp' });
  if (!checked.ok) { rejected.push({ surface: it.surface, why: summarizePuzzleIssues(checked.issues) }); continue; }
  acceptedPuzzles.push({ puzzle: checked.puzzle, from: it });
}
process.stdout.write('\r' + ' '.repeat(30) + '\r');

console.log(`\n通过校验：${acceptedPuzzles.length} 道；被拒：${rejected.length} 道`);
for (const r of rejected.slice(0, 8)) console.log(`  ✗ ${r.surface.slice(0, 32)}… → ${r.why}`);

if (acceptedPuzzles.length === 0) {
  console.error('没有任何题目通过校验，未写文件。');
  process.exit(4);
}

const header = `/**
 * 导入题库（**由 pnpm import:puzzles 自动生成，请勿手改**）
 *
 * 源：${source}
 * 许可：${license}（运行导入时已显式确认接受）
 * 生成时间：${new Date().toISOString()}
 * 题量：${acceptedPuzzles.length}（另有 ${rejected.length} 道未通过坏题检测，已丢弃）
 *
 * 说明：源题库只提供"汤面 + 汤底"，**事实点表由模型补齐**并经过
 * packages/core/src/puzzle-check.ts 的统一校验（结构 / 汤面泄露 / 违禁词…）。
 * 因此理论上仍可能有个别事实点不准确 —— 玩到问题题可以用房主端「AI 创作」换一题。
 */
import type { Puzzle } from '@ht/core';

export function collectedPuzzles(): Puzzle[] {
  return ${JSON.stringify(acceptedPuzzles.map((a) => a.puzzle), null, 2)
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : `  ${line}`))
    .join('\n')};
}
`;

writeFileSync(outFile, header, 'utf8');
console.log(`\n✓ 已写入 ${outFile.replace(root + '\\', '').replace(root + '/', '')}`);
console.log('  下一步：pnpm typecheck && pnpm test && git add -A && git commit && git push（CI 会自动部署）');

// 顺手跑一次种子自检，确保新题能进库（失败也不回滚文件，方便人工查看）
console.log('\n运行种子自检…');
const res = spawnSync('node', ['scripts/seed-puzzles.ts'], { cwd: root, stdio: 'inherit' });
if (res.status !== 0) console.log('（种子自检未通过，请检查上面的输出）');

/**
 * 题库来源的统一取数层（`pnpm import:puzzles` 与 `pnpm analyze:puzzles` 共用）。
 *
 * 支持的源：
 *   file:<路径>                        本地 JSON / JSONL（最稳，适合先把文件下下来）
 *   hf-file:<id>/<path>[#ref]          HuggingFace 直连文件（可用 --hf-endpoint 换镜像）
 *   hf:<id>[#config=&split=&rows=]     HuggingFace datasets-server 分页
 *   github:<owner>/<repo>/<path>[#ref] GitHub Contents API
 *   https://...                        直接 GET JSON
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RawItem { surface: string; truth: string }
export type Adapter = (raw: unknown) => RawItem[];

/** 已知源题库的许可（未列出的必须在调用处显式确认） */
export const SOURCE_LICENSES: Record<string, string> = {
  // HuggingFace：这一个许可是 Apache-2.0（干净、可再分发，只需注明出处）
  'hf:lpj990/haiguitang': 'apache-2.0',
  'hf-file:lpj990/haiguitang': 'apache-2.0',
  'lpj990/haiguitang': 'apache-2.0',
  // 下面几个数据集没有声明许可，要用必须自己判断风险
  'hf:neurostellar/haiguitang': 'UNKNOWN',
  'hf-file:neurostellar/haiguitang': 'UNKNOWN',
  'hf:lin52/TurtleSoup': 'UNKNOWN',
  'hf-file:lin52/TurtleSoup': 'UNKNOWN',
  // ModelScope（阿里，国内访问快；Turtle-Bench 是 Apache-2.0 的经典题库/评测集）
  'modelscope:Narcissuses/Turtle-Bench': 'apache-2.0',
  'Narcissuses/Turtle-Bench': 'apache-2.0',
  // GitHub
  'github:KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
  'KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
};

/** 从源字符串推断许可：先精确匹配，再退化到"仓库/数据集 id"匹配 */
export function licenseOf(source: string): string {
  if (SOURCE_LICENSES[source]) return SOURCE_LICENSES[source]!;
  const bare = source.replace(/^(github|hf|hf-file):/, '').replace(/\/[^/]+\.(json|jsonl|csv|txt)$/i, '');
  return SOURCE_LICENSES[bare] ?? 'UNKNOWN';
}

/**
 * 通用适配器：兼容 {surface,truth} / {puzzle,answer} / {Riddle,Solution} / {question,answer} 等形态。
 * 只做"取字段"，清洗交给 core 的 cleanPuzzleText()。
 */
export const genericAdapter: Adapter = (raw: unknown): RawItem[] => {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown[] }).data) ? (raw as { data: unknown[] }).data : []);
  const out: RawItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const surface = [o.surface, o.puzzle, o.question, o.Riddle, o.riddle, o['汤面']]
      .find((v) => typeof v === 'string' && (v as string).trim()) as string | undefined;
    const truth = [o.truth, o.answer, o.bottom, o.Solution, o.solution, o['汤底']]
      .find((v) => typeof v === 'string' && (v as string).trim()) as string | undefined;
    if (!surface || !truth) continue;
    out.push({ surface: surface.trim(), truth: truth.trim() });
  }
  return out;
};

export function parseTextAsItems(text: string): unknown[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try { return JSON.parse(text); } catch { /* 落到 JSONL */ }
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function readLocal(src: string): unknown[] {
  const p = resolve(process.cwd(), src.slice(5));
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  return parseTextAsItems(readFileSync(p, 'utf8'));
}

/**
 * HuggingFace **直连文件**：`hf-file:<id>/<path>[#ref]`
 * 国内网络常连不上 huggingface.co，而镜像通常只镜像仓库文件（resolve 路径），
 * 所以这条路径配 `--hf-endpoint=https://hf-mirror.com` 最实用。
 */
export async function fetchHfFile(src: string, endpoint: string): Promise<unknown[]> {
  const spec = src.slice(8);
  const [pathPart, ref = 'main'] = spec.split('#');
  const secondSlash = (pathPart ?? '').indexOf('/', (pathPart ?? '').indexOf('/') + 1);
  if (secondSlash < 0) throw new Error('hf-file 源格式应为 hf-file:owner/repo/path[#ref]');
  const id = (pathPart ?? '').slice(0, secondSlash);
  const file = (pathPart ?? '').slice(secondSlash + 1);
  const url = `${endpoint.replace(/\/+$/, '')}/datasets/${id}/resolve/${ref}/${file}`;
  console.log(`下载：${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'haiguitang-tools' }, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}\n（国内网络可加 --hf-endpoint=https://hf-mirror.com）`);
  }
  return parseTextAsItems(await res.text());
}

/** HuggingFace datasets-server 分页：`hf:<id>[#config=&split=&rows=]` */
export async function fetchHf(src: string, want: number): Promise<unknown[]> {
  const [idPart, queryPart] = src.slice(3).split('#');
  const params = new URLSearchParams(queryPart ?? '');
  const config = params.get('config') ?? 'default';
  const split = params.get('split') ?? 'train';
  const out: unknown[] = [];
  const cap = Math.min(want, 20000);
  for (let offset = 0; offset < cap; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(idPart ?? '')}`
      + `&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=100`;
    const res = await fetch(url, { headers: { 'User-Agent': 'haiguitang-tools' } });
    if (!res.ok) {
      if (offset === 0) throw new Error(`HF datasets-server ${res.status}：${url}`);
      break;
    }
    const body = await res.json() as { rows?: Array<{ row: unknown }> };
    const rows = body.rows ?? [];
    for (const r of rows) out.push(r.row);
    if (offset % 2000 === 0 && offset > 0) console.log(`  …已取 ${out.length} 行`);
    if (rows.length < 100) break;
  }
  return out;
}

/** 从 GitHub 取文件（Contents API，沙箱/国内相对可达） */
export async function fetchGithub(src: string): Promise<unknown> {
  const spec = src.slice(7);
  const [repoAndPath, ref] = spec.split('#');
  const parts = (repoAndPath ?? '').split('/');
  const repo = `${parts[0]}/${parts[1]}`;
  const path = parts.slice(2).join('/');
  if (!repo.includes('/') || !path) throw new Error('github 源格式应为 github:owner/repo/path[#ref]');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'haiguitang-tools' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}：${url}`);
  const body = await res.json() as { content?: string };
  if (!body.content) throw new Error('GitHub API 没有返回文件内容');
  return parseTextAsItems(Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8'));
}

/**
 * ModelScope（阿里）数据集源：`modelscope:<namespace>/<name>/<path>[#revision]`
 *
 * 为什么加它：国内访问快（实测 200ms 级），而且上面有现成的海龟汤数据集
 * （例：`modelscope:Narcissuses/Turtle-Bench/train_8k.json`，Apache-2.0）。
 * 注意 Turtle-Bench 是**判定评测集**：9457 行 = 507 道独立题 × 每题多条「猜测+对错标签」。
 */
export async function fetchModelScope(src: string): Promise<unknown[]> {
  const spec = src.slice('modelscope:'.length);
  const [pathPart, revision = 'master'] = spec.split('#');
  const parts = (pathPart ?? '').split('/');
  if (parts.length < 3) throw new Error('modelscope 源格式应为 modelscope:namespace/name/path[#revision]');
  const ns = parts[0]!;
  const name = parts[1]!;
  const file = parts.slice(2).join('/');
  const url = `https://modelscope.cn/api/v1/datasets/${ns}/${name}/repo?Revision=${revision}&FilePath=${encodeURIComponent(file)}`;
  console.log(`下载：modelscope:${ns}/${name}/${file}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'haiguitang-tools' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`ModelScope 下载失败 HTTP ${res.status}：${ns}/${name}/${file}`);
  return parseTextAsItems(await res.text());
}

/** 列出 ModelScope 数据集里的文件（用来确认有哪些数据文件） */
export async function listModelScopeFiles(ns: string, name: string, revision = 'master'): Promise<Array<{ path: string; size: number }>> {
  const res = await fetch(`https://modelscope.cn/api/v1/datasets/${ns}/${name}/repo/tree?Revision=${revision}&Recursive=true`, {
    headers: { 'User-Agent': 'haiguitang-tools' },
  });
  if (!res.ok) throw new Error(`ModelScope 文件列表失败 HTTP ${res.status}`);
  const body = await res.json() as { Data?: { Files?: Array<{ Path: string; Size: number }> } };
  return (body.Data?.Files ?? []).map((f) => ({ path: f.Path, size: f.Size }));
}

export async function fetchSource(src: string, opts: { want: number; hfEndpoint: string }): Promise<unknown> {
  if (src.startsWith('file:')) return readLocal(src);
  if (src.startsWith('modelscope:')) return fetchModelScope(src);
  if (src.startsWith('hf-file:')) return fetchHfFile(src, opts.hfEndpoint);
  if (src.startsWith('hf:')) return fetchHf(src, opts.want);
  if (src.startsWith('github:')) return fetchGithub(src);
  const res = await fetch(src, { headers: { 'User-Agent': 'haiguitang-tools' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${src}`);
  return parseTextAsItems(await res.text());
}

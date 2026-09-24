/**
 * 题库来源的统一取数层（导入与体检脚本共用）。
 *
 * 支持的源（**不含 HuggingFace** —— 国内直连基本不通，已按要求移除）：
 *   file:<路径>                        本地 JSON / JSONL（最稳：先把文件下下来）
 *   modelscope:<ns>/<name>/<path>[#rev]  ModelScope（阿里，国内 200ms 级；Turtle-Bench 就在这）
 *   github:<owner>/<repo>/<path>[#ref]  GitHub Contents API
 *   https://...                         直接 GET JSON
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RawItem {
  title?: string;
  surface: string;
  truth: string;
  /** 评测集常见的"玩家猜测 + 对错标签"（用于规则版事实点抽取） */
  guesses?: Array<{ text: string; label: string }>;
}
export type Adapter = (raw: unknown) => RawItem[];

/** 已知源题库的许可（未列出的必须在调用处显式确认） */
export const SOURCE_LICENSES: Record<string, string> = {
  // ModelScope：Turtle-Bench 是 Apache-2.0 的经典题库/判定评测集
  'modelscope:Narcissuses/Turtle-Bench': 'apache-2.0',
  'Narcissuses/Turtle-Bench': 'apache-2.0',
  // GitHub
  'github:KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
  'KONpiGG/astrbot_plugin_soupai': 'AGPL-3.0',
};

/** 从源字符串推断许可：先精确匹配，再退化到"仓库/数据集 id"匹配 */
export function licenseOf(source: string): string {
  if (SOURCE_LICENSES[source]) return SOURCE_LICENSES[source]!;
  const bare = source.replace(/^(github|modelscope):/, '').replace(/\/[^/]+\.(json|jsonl|csv|txt)$/i, '');
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
    const surface = [o.surface, o.puzzle, o.question, o.Riddle, o.riddle, o['汤面'], o['湯面']]
      .find((v) => typeof v === 'string' && (v as string).trim()) as string | undefined;
    const truth = [o.truth, o.answer, o.bottom, o.Solution, o.solution, o['汤底'], o['湯底']]
      .find((v) => typeof v === 'string' && (v as string).trim()) as string | undefined;
    if (!surface || !truth) continue;
    const guesses: Array<{ text: string; label: string }> = [];
    if (typeof o.user_guess === 'string' && o.user_guess.trim()) {
      guesses.push({ text: o.user_guess.trim(), label: String(o.label ?? '').trim() });
    }
    if (Array.isArray(o.guesses)) {
      for (const g of o.guesses) {
        if (g && typeof g === 'object') {
          const go = g as Record<string, unknown>;
          if (typeof go.text === 'string') guesses.push({ text: go.text, label: String(go.label ?? '') });
        }
      }
    }
    out.push({
      ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim() } : {}),
      surface: surface.trim(),
      truth: truth.trim(),
      ...(guesses.length ? { guesses } : {}),
    });
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
 * ModelScope（阿里）数据集源：`modelscope:<namespace>/<name>/<path>[#revision]`
 *
 * 例：`modelscope:Narcissuses/Turtle-Bench/train_8k.json`（Apache-2.0）
 * 注意它是**判定评测集**：9457 行 = 563 道独立题 × 每题约 18 条「猜测 + 对错标签」。
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

/** 列出 ModelScope 数据集里的文件（确认有哪些数据文件） */
export async function listModelScopeFiles(ns: string, name: string, revision = 'master'): Promise<Array<{ path: string; size: number }>> {
  const res = await fetch(`https://modelscope.cn/api/v1/datasets/${ns}/${name}/repo/tree?Revision=${revision}&Recursive=true`, {
    headers: { 'User-Agent': 'haiguitang-tools' },
  });
  if (!res.ok) throw new Error(`ModelScope 文件列表失败 HTTP ${res.status}`);
  const body = await res.json() as { Data?: { Files?: Array<{ Path: string; Size: number }> } };
  return (body.Data?.Files ?? []).map((f) => ({ path: f.Path, size: f.Size }));
}

/** 从 GitHub 取文件（Contents API） */
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

export async function fetchSource(src: string): Promise<unknown> {
  if (src.startsWith('file:')) return readLocal(src);
  if (src.startsWith('modelscope:')) return fetchModelScope(src);
  if (src.startsWith('github:')) return fetchGithub(src);
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { headers: { 'User-Agent': 'haiguitang-tools' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${src}`);
    return parseTextAsItems(await res.text());
  }
  throw new Error(`不支持的源：${src}\n可用：file: / modelscope: / github: / https://`);
}

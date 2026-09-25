/**
 * 判定口径与防越狱的服务端权威部分（《阶段2》§2.2、§3.2）。
 *
 * 本文件只做"规则能确定的事"，不产生任何面向玩家的自由文本：
 *  - L0 输入预检：命中即不调用模型（省成本 + 收敛注入面）
 *  - 边界口径：封闭世界假设、复合提问、开放提问、元提问
 *  - 输出校验（L3）：schema 严格校验 + 自洽性 + 泄露检查 + "无法回答不得当万能出口"
 */
import type { AnswerEnum, JudgeResult, PuzzleFact, ReasonCode } from './types.ts';
import { ANSWER_ENUM, REASON_CODES } from './types.ts';
import { normalize, normalizeLower, sharedNgram, similarity } from './text.ts';

export const REASON_TEXT: Record<ReasonCode, string> = {
  NONE: '',
  OUT_OF_SCOPE: '不属于本故事的世界',
  META_QUESTION: '询问主持人自身',
  LIST_REQUEST: '要求批量列举',
  SUBJECTIVE: '不可二值化',
  COMPOUND_SPLIT_REQUIRED: '一次只问一件事',
  INSTRUCTION_INJECTION: '检测到伪造指令',
  ENCODING_EVASION: '检测到编码绕过',
  SPOILER_REQUEST: '索取汤底',
};

/** 面向玩家的固定文案（由服务端模板给出，不来自模型）。 */
export const UI_NOTICE: Partial<Record<ReasonCode, string>> = {
  COMPOUND_SPLIT_REQUIRED: '一次只问一件事，请拆开再问。',
  LIST_REQUEST: '我不能帮你一次性列出所有事实，请一次问一件事。',
  META_QUESTION: '我只回答关于这个故事的问题。',
  SUBJECTIVE: '这个问题无法用是 / 否回答，请换一种问法。',
  OUT_OF_SCOPE: '这个问题不属于本故事的世界。',
};

export interface InputFeatures {
  /** 直接索取汤底/真相 */
  spoilerIntent: boolean;
  /** 询问主持人自身行为、判断依据、置信度 */
  metaCue: boolean;
  /** 要求批量列举 / 复述 */
  listCue: boolean;
  /** 开放式、不可二值化 */
  openEnded: boolean;
  /** 伪造系统指令 / 越狱话术 */
  injection: boolean;
  /** 编码或同形字绕过 */
  encodingEvasion: boolean;
  /** 零宽字符等不可见字符注入 */
  invisibleChars: boolean;
  /** 复合提问拆分后的子问题 */
  compound: string[];
}

export interface InputAnalysis {
  clean: string;
  lower: string;
  features: InputFeatures;
}

const SPOILER_NOUN = /(汤底|真相|答案|结局|谜底|凶手|案情|内情)/;
const SPOILER_VERB = /(是什么|是谁|是哪个|告诉我|给我|说出|讲出|念|背|揭示|公布|直接说|发给我|写出来)/;
const SPOILER_SUMMARY = /(概括|总结|讲讲|复述|一句话).{0,8}(真相|故事|汤底|答案|结局)/;
const META_CUE = /(你刚才|你是不是|你会不会|你会说|你回答|你的判断|判断依据|判断理由|置信|概率|犹豫|骗我|为什么这样回答|依据是什么|心里|你确定)/;
const LIST_CUE = /(列出|列举|逐条|全部|所有|汇总|有哪几条|有哪些|一一说明|都说出来|复述)/;
const OPEN_ENDED = /(为什么|怎么会|怎么回事|什么情况|发生了什么|到底发生|经过是|讲一下)/;
const INJECTION = /(忽略.{0,10}(以上|之前|所有).{0,10}(指令|规则|设定)|不受限制|没有限制|角色扮演|扮演|系统提示|系统消息|开发者模式|开发者指令|越狱|jailbreak|system\s*[:：]|im_start|im_end|assistant\s*[:：]|reveal_truth|"tool"|新指令|覆盖.{0,4}(规则|设定))/i;
const ENCODING = /(base64|rot13|十六进制|hex\s*编码|摩斯|凯撒|倒着写|反着写|拼音|谐音|火星文)/i;
const FULLWIDTH = /[\uff21-\uff5a\uff41-\uff5a]/;
const B64_BLOCK = /[A-Za-z0-9+/]{16,}={0,2}/;
const HEX_BLOCK = /\b[0-9a-fA-F]{16,}\b/;
const PINYIN_SPOILER = /(tangdi|daan|zhenxiang|jieju|xiongshou|xiongshuo)/i;
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\ufeff\u180e]/;

/** 复合提问拆分（结论不一致时由调用方返回 COMPOUND_SPLIT_REQUIRED）。 */
export function splitCompound(clean: string): string[] {
  return clean
    .split(/[，,、；;]|而且|并且|同时|然后|以及/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

/** 输入预检与特征提取（纯函数）。 */
export function analyzeInput(raw: string): InputAnalysis {
  const invisibleChars = INVISIBLE.test(String(raw ?? ''));
  const clean = normalize(raw);
  const lower = normalizeLower(raw);
  const compound = splitCompound(clean);
  const features: InputFeatures = {
    spoilerIntent: (SPOILER_NOUN.test(clean) && SPOILER_VERB.test(clean)) || SPOILER_SUMMARY.test(clean),
    metaCue: META_CUE.test(clean),
    listCue: LIST_CUE.test(clean),
    openEnded: OPEN_ENDED.test(clean) && !/(是不是|吗|是否|对不对|有没有)/.test(clean),
    injection: INJECTION.test(clean),
    encodingEvasion: ENCODING.test(clean) || FULLWIDTH.test(clean) || PINYIN_SPOILER.test(lower)
      || (B64_BLOCK.test(clean) && SPOILER_NOUN.test(clean)) || HEX_BLOCK.test(clean),
    invisibleChars,
    compound,
  };
  return { clean, lower, features };
}

/**
 * L0 拦截：返回非 null 表示"不调用模型即可定论"（answer_source = rule）。
 * 顺序即优先级：注入 → 编码 → 索取 → 元提问 → 列举。
 */
export function preflight(question: string): JudgeResult | null {
  const { features } = analyzeInput(question);
  const hit = (reasonCode: ReasonCode): JudgeResult => ({
    answer: 'unanswerable', reasonCode, matchedFactIds: [], source: 'rule',
  });
  if (features.injection) return hit('INSTRUCTION_INJECTION');
  if (features.encodingEvasion || features.invisibleChars) return hit('ENCODING_EVASION');
  if (features.spoilerIntent) return hit('SPOILER_REQUEST');
  if (features.metaCue) return hit('META_QUESTION');
  if (features.listCue) return hit('LIST_REQUEST');
  if (features.openEnded) return hit('SUBJECTIVE');
  return null;
}

/**
 * 由事实表裁决答案（**权威来源**）：模型只负责映射到事实点，答案由这里算。
 *
 * 三条规则（全部可机判，与模型无关）：
 *  · 一条都没命中 → irrelevant（封闭世界假设：问的要素在本题里没出现，**不是"否"**）
 *  · 命中的事实点里有真有假 → **partial（部分接近）**：玩家问的这件事"对了一半"
 *  · 全真 → yes；全假 → no
 *
 * `partial` 解决的实际问题：玩家常把两件事塞进一句话问，例如"他是不是因为内疚才下毒的？"——
 * 内疚成立、下毒不成立。以前只会命中成立的那条、答"是"，等于默认了不成立的那半句；
 * 现在如实回"部分接近"（只说是"一部分"，**不指出哪部分对**，否则就成了免费提示）。
 */
export function decideFromFacts(matched: readonly PuzzleFact[]): AnswerEnum {
  if (matched.length === 0) return 'irrelevant';
  const anyTrue = matched.some((f) => f.isTrue);
  const anyFalse = matched.some((f) => !f.isTrue);
  if (anyTrue && anyFalse) return 'partial';
  return anyTrue ? 'yes' : 'no';
}

export interface JudgeValidationCtx {
  /** 🔴 汤底原文，仅用于泄露检查，绝不外泄 */
  truth: string;
  facts: readonly PuzzleFact[];
  features: InputFeatures;
}

export type JudgeValidation =
  | { ok: true; result: JudgeResult }
  | { ok: false; reason: 'SCHEMA_INVALID' | 'LEAK_DETECTED' | 'INCONSISTENT' | 'UNANSWERABLE_ABUSE'; detail: string };

const ALLOWED_KEYS = new Set(['answer', 'reason_code', 'matched_fact_ids', 'explain']);

/** 补充说明的长度上限（字）：一句话，不能变成小作文 */
export const EXPLAIN_MAX_CHARS = 30;

/**
 * L3 输出校验（《阶段2》§2.2(c)）：模型返回后的四道检查。
 * 任一道不通过 → 调用方走失败兜底（重试 → 规则降级），**绝不把原始输出展示给玩家**。
 */
export function validateJudgeOutput(raw: unknown, ctx: JudgeValidationCtx): JudgeValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'SCHEMA_INVALID', detail: '不是 JSON 对象' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      // 任何额外字段（尤其是 explanation / text）都视为越界：模型由此可能夹带汤底
      return { ok: false, reason: 'SCHEMA_INVALID', detail: `存在越界字段：${key}` };
    }
  }
  const answer = obj.answer;
  if (typeof answer !== 'string' || !ANSWER_ENUM.includes(answer as AnswerEnum)) {
    return { ok: false, reason: 'SCHEMA_INVALID', detail: `answer 不在结论枚举内：${String(answer)}` };
  }
  const reasonCode = obj.reason_code ?? 'NONE';
  if (typeof reasonCode !== 'string' || !REASON_CODES.includes(reasonCode as ReasonCode)) {
    return { ok: false, reason: 'SCHEMA_INVALID', detail: `reason_code 不在白名单内：${String(reasonCode)}` };
  }
  const matchedRaw = obj.matched_fact_ids;
  if (!Array.isArray(matchedRaw) || matchedRaw.some((x) => typeof x !== 'string')) {
    return { ok: false, reason: 'SCHEMA_INVALID', detail: 'matched_fact_ids 必须是字符串数组' };
  }
  if (matchedRaw.length > 3) {
    return { ok: false, reason: 'SCHEMA_INVALID', detail: 'matched_fact_ids 超过 3 条' };
  }

  // 泄露检查：任何字段的字符串值都不得与汤底共享 8-gram，也不得近似抄写事实点原文
  for (const value of [answer, reasonCode, ...matchedRaw]) {
    if (typeof value !== 'string') continue;
    const shared = sharedNgram(value, ctx.truth, 8);
    if (shared) return { ok: false, reason: 'LEAK_DETECTED', detail: `输出与汤底共享片段：${shared}` };
  }
  const known = new Set(ctx.facts.map((f) => f.id));
  for (const id of matchedRaw) {
    if (!known.has(id)) return { ok: false, reason: 'INCONSISTENT', detail: `未知的事实点 id：${id}` };
  }

  // 自洽性：yes/no/partial 必须命中事实点；irrelevant 不得命中；unanswerable 必须给出非 NONE 的原因
  if ((answer === 'yes' || answer === 'no' || answer === 'partial') && matchedRaw.length === 0) {
    return { ok: false, reason: 'INCONSISTENT', detail: `${answer} 却未命中任何事实点` };
  }
  if (answer === 'partial' && matchedRaw.length < 2) {
    // "部分接近"至少要命中两条（一真一假）才有意义；只命中一条时由事实表裁决成 是/否
    return { ok: false, reason: 'INCONSISTENT', detail: 'partial 只命中了一条事实点（那是一件事，谈不上"部分"）' };
  }
  if (answer === 'irrelevant' && matchedRaw.length > 0) {
    return { ok: false, reason: 'INCONSISTENT', detail: 'irrelevant 却命中了事实点' };
  }
  if (answer === 'unanswerable' && reasonCode === 'NONE') {
    return { ok: false, reason: 'UNANSWERABLE_ABUSE', detail: 'unanswerable 未给出原因码' };
  }
  if (answer === 'unanswerable' && !reasonSupportedByFeatures(reasonCode as ReasonCode, ctx.features)) {
    // "无法回答"不得成为回避判定的万能出口
    return { ok: false, reason: 'UNANSWERABLE_ABUSE', detail: `原因码 ${reasonCode} 与输入特征不符` };
  }

  return {
    ok: true,
    result: {
      answer: answer as AnswerEnum,
      reasonCode: reasonCode as ReasonCode,
      matchedFactIds: matchedRaw as string[],
      source: 'model',
      explain: sanitizeExplain(obj.explain, answer as AnswerEnum, ctx),
    },
  };
}

/**
 * 判定的补充说明（explain）：帮玩家理解这个结论的**范围**，不给新信息。
 *
 * 设计变更（用户要求）：**各类结论都可以带说明**，而且服务端保证每条判定都有一句
 * （模型没给就由 contextExplain 用玩家自己的问法兜一句）。
 * 这里仍然是**只丢不杀**的清洗 —— 写得不合适时返回 null，绝不因为这一句把整次判定判失败。
 * 规则：
 *   · ≤ EXPLAIN_MAX_CHARS 字，且不得是问句（避免反问式提示）
 *   · 不得与汤底共享 8-gram、不得近似抄写事实点原文（isLeaky）
 *   · 不得出现引导式措辞（"接近了/再想想/注意…"）—— 那是提示，不是说明
 *   · 不得与 answer 自相矛盾（「否——…」配 answer=yes）
 */
export function sanitizeExplain(raw: unknown, answer: AnswerEnum, ctx: JudgeValidationCtx): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > EXPLAIN_MAX_CHARS) return null;
  if (/[?？]$/.test(text)) return null;
  // 结论前缀（「是——」「部分接近——」）是**允许的固定写法**，查引导式措辞时要先把它剥掉，
  // 否则「部分接近——只针对你问的这一半」会因为句首出现"接近"被整句丢掉。
  if (GUIDING_PHRASE.test(text.replace(EXPLAIN_VERDICT, ''))) return null;
  if (isLeaky(text, ctx.truth, ctx.facts)) return null;
  // 模型自己把结论说反了（answer=yes 却写「否——…」）：这句话不能用
  if (explainConflictsWithAnswer(text, answer)) return null;
  return text;
}

/**
 * 说明句里"结论性开头"的识别。
 *
 * 只认**明确下结论**的写法（「是——…」「否——…」「部分接近——…」「对的，…」「不是：…」），
 * 不碰「你问的『X』在本题设定里没有提到」这类中性说明 —— 后者没有下结论，谈不上说反。
 */
const EXPLAIN_VERDICT = /^[\s（(【\[]*(部分接近|部分|一半|是|否|对的|不对|不是)\s*[—\-–－:：,，]/;
const VERDICT_ANSWER: Record<string, AnswerEnum> = {
  是: 'yes', 对的: 'yes',
  否: 'no', 不对: 'no', 不是: 'no',
  部分接近: 'partial', 部分: 'partial', 一半: 'partial',
};

/** 说明句的结论性开头是否与 answer 相反。 */
export function explainConflictsWithAnswer(explain: string, answer: AnswerEnum): boolean {
  const m = EXPLAIN_VERDICT.exec(String(explain ?? ''));
  if (!m) return false;
  return VERDICT_ANSWER[m[1]!] !== answer;
}

/**
 * 过滤"说反了"的说明句：返回 null 表示调用方应改用 {@link contextExplain} 兜底。
 *
 * 存在的理由（线上真实出现过的一条记录）：
 * 模型返回 `answer=no` + `explain="否——你问的『…』与事实不符。"`，同时命中了**成立**的事实点；
 * 事实表复核把结论改成了「是」，但那句 explain 是模型按自己的「否」写的，于是玩家看到
 * 「主持人：是 … 否——…与事实不符」。结论以事实表为准，说反了的那句必须丢掉。
 */
export function coherentExplain(explain: unknown, answer: AnswerEnum): string | null {
  if (typeof explain !== 'string') return null;
  const text = explain.trim();
  if (!text) return null;
  return explainConflictsWithAnswer(text, answer) ? null : text;
}

/** 引导式措辞：这些是"提示"，不是"说明"，一律丢弃（丢了还有兜底句，不会让玩家看到空说明）。 */
const GUIDING_PHRASE = /(接近|快到了|再想想|仔细想|注意|暗示|提示你|方向|思路|加油|差一点|快了|有戏)/;

/**
 * 兜底说明：模型/规则/缓存都没给说明时，用**玩家自己的问法**回指一句。
 *
 * 为什么这样是安全的：引用的就是玩家刚说过的词，不含任何汤底信息，也不指出方向；
 * 玩家看到的仍然是"这个结论针对的是你问的哪一部分"。
 */
export function contextExplain(answer: AnswerEnum, question: string): string {
  const topic = topicFromQuestion(question);
  switch (answer) {
    case 'yes':
      return topic ? `是——只针对你问的「${topic}」。` : '是——只针对你问的这一句。';
    case 'no':
      return topic ? `否——你问的「${topic}」在本局设定里不成立。` : '否——你问的这一句在本局设定里不成立。';
    case 'partial':
      // 只说"一部分对"，**绝不指出哪一部分对** —— 那就是提示了
      return topic ? `部分接近——你问的「${topic}」只说对了一部分。` : '部分接近——你问的这件事只说对了一部分。';
    case 'irrelevant':
      return topic ? `你问的「${topic}」在本题设定里没有出现。` : '这个问题问的要素在本题设定里没有出现。';
    default:
      return topic ? `你问的「${topic}」没法用是/否回答。` : '这个问题没法用是/否回答。';
  }
}

/**
 * 样板说明：只是把结论换句话重说一遍、**不含任何增量信息**的句子。
 *
 * 典型就是「你问的『X』在本题设定里没有提到。」—— 而「无关」这个结论本身说的就是
 * "本题没有这个要素"，两句话是同一件事；记录里连着几行都是它，只会把真正有信息的说明淹掉。
 * 这里只认"本题设定里 + 没有提到/出现/提及"这一族，不碰有实际内容的说明。
 */
const BOILERPLATE_EXPLAIN = /(本题设定|本局设定|本故事|题目设定|这个题)[^。]{0,8}(没有|未|不)(提到|出现|提及|涉及|存在)/;

/** 是否属于"把结论重说一遍"的样板说明。 */
export function isBoilerplateExplain(explain: string): boolean {
  return BOILERPLATE_EXPLAIN.test(String(explain ?? ''));
}

/**
 * 一条判定最终展示/落库的说明句（**唯一出口**）。
 *
 * 优先级与取舍：
 *  1. 模型给了说明、且过了清洗（泄露/引导式/自相矛盾）→ 用它；
 *  2. 但如果是**样板说明**（"本题设定里没有提到"这类），丢掉：
 *     · `irrelevant`：与「无关」这个结论完全重复 → 这一行干脆不带说明（少一句废话）；
 *     · 其他结论：改用兜底句（例如「是——只针对你问的『X』。」），至少点明结论的范围；
 *  3. 模型没给（规则拦截 / 判定缓存命中 / 内置模拟主持人）→ `irrelevant` 仍然不带，
 *     其余用兜底句。
 *
 * 为什么 `irrelevant` 特殊：它的兜底句与样板说明是同一个意思（"本题没有这个要素"），
 * 留着只是把「无关」写两遍；而 是/否/部分接近/无法回答 的兜底句能说明**结论管的是问题里的哪一部分**。
 */
export function finalExplain(
  result: Pick<JudgeResult, 'answer' | 'explain'>,
  question: string,
): string | null {
  const clean = coherentExplain(result.explain, result.answer);
  if (clean && !isBoilerplateExplain(clean)) return clean;
  if (result.answer === 'irrelevant') return null;
  return contextExplain(result.answer, question);
}

/**
 * 从玩家的问题里抠一个短话题（只用于回指问题本身；剥掉"是不是/吗"这类疑问外壳）。
 *
 * 疑问外壳**直接删掉**（不是换成空格）：换成空格会留下「他 是顺手把钥匙放到沙发」这种
 * 带豁口的回指句（线上真实出现过这类兜底句），删掉才读得顺。
 * 上限 14 字：常见问句（含「他是…的」这类收尾）刚好能整句保留，不会被截在半截词上。
 */
export function topicFromQuestion(question: string): string {
  let s = normalize(question)
    .replace(/^(请问|那么|所以|那|嗯|我想问|想问)+/g, '')
    .replace(/(是不是|是否|有没有|会不会|能不能|可不可以|是不是说|吗|呢|吧)/g, '')
    .replace(/[?？。！!，,、；;：:（）()「」『』"'“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 14) s = s.slice(0, 14);
  return s;
}

/** 原因码必须与可机判的输入特征一致（否则视为滥用）。 */
export function reasonSupportedByFeatures(reasonCode: ReasonCode, f: InputFeatures): boolean {
  switch (reasonCode) {
    case 'META_QUESTION': return f.metaCue;
    case 'LIST_REQUEST': return f.listCue;
    case 'SUBJECTIVE': return f.openEnded;
    case 'COMPOUND_SPLIT_REQUIRED': return f.compound.length >= 2;
    case 'INSTRUCTION_INJECTION': return f.injection;
    case 'ENCODING_EVASION': return f.encodingEvasion || f.invisibleChars;
    case 'SPOILER_REQUEST': return f.spoilerIntent;
    case 'OUT_OF_SCOPE': return true; // 是否"世界外"需要事实集判断，无法由特征单独否决
    case 'NONE': return false;
    default: return false;
  }
}

/**
 * 文案/提示的泄露检查：与汤底共享 8-gram 或与**其他**事实点高度相似即视为泄露。
 *
 * 注意 `excludeFactId`：提示文案本身就来自某条事实点，
 * 不排除它的话相似度必然为 1.0，会把所有提示都误判为泄露。
 * 同理，如果该事实点已由汤面合法公开，也不算泄露。
 */
export function isLeaky(
  text: string,
  truth: string,
  facts: readonly PuzzleFact[],
  opts: { excludeFactId?: string; publicText?: string } = {},
): string | null {
  const publicText = opts.publicText ?? '';
  const shared = sharedNgram(text, truth, 8);
  if (shared && !publicText.includes(shared)) return `与汤底共享片段：${shared}`;
  for (const f of facts) {
    if (f.id === opts.excludeFactId) continue;
    if (publicText.includes(f.text)) continue;
    if (similarity(text, f.text) >= 0.95) return `与事实点 ${f.id} 几乎逐字相同`;
  }
  return null;
}

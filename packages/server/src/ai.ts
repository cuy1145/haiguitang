/**
 * AI 主持人代理（唯一的出网点）。
 *
 * 分工（《阶段2》§3.1）：模型只做「问题 → 事实点映射」，答案由 core 的事实表裁决。
 * 因此即使模型被越狱，也只能"错误映射"，无法产出汤底文本；而输出校验（L3）会拒收越界/泄露输出。
 *
 * 失败处理（《阶段4》§5、阶段2 §3.5）：
 *  - 可重试：超时/连接中断/408/425/429/5xx → 有限次退避重试（幂等：同一 turnSeq 只写一条判定）
 *  - 不可重试：401/403/402/400/404 → 立即终止 + 房主告警 + **绝不自动降级到站点额度**
 *  - 输出不合规/泄露 → 拒收并降级为"规则裁决"（不涉及额度）
 */
import {
  PROMPT_VERSION, REASON_CODES, analyzeInput, decideFromFacts, isLeaky, preflight, sharedNgram,
  similarity, stableHash, validateJudgeOutput,
} from '@ht/core';
import type { AnswerEnum, JudgeResult, Puzzle, ReasonCode } from '@ht/core';
import { mockJudge } from '@ht/core';
import type { Logger } from './log.ts';
import type { Store } from './store.ts';

export type AiErrorClass =
  | 'CONNECT_TIMEOUT' | 'READ_TIMEOUT' | 'CONN_RESET'
  | 'HTTP_401' | 'HTTP_403' | 'HTTP_402' | 'HTTP_400' | 'HTTP_404' | 'HTTP_408' | 'HTTP_425' | 'HTTP_429'
  | 'HTTP_5XX' | 'SCHEMA_INVALID' | 'LEAK_DETECTED' | 'INCONSISTENT' | 'UNANSWERABLE_ABUSE'
  | 'PROVIDER_REFUSAL' | 'UNKNOWN';

export interface JudgeRequest {
  roomId: string;
  matchId: string | null;
  turnSeq: number;
  question: string;
  puzzle: Puzzle;
  factSetVersion?: number;
  /** 出站调用用的凭据（服务端在调用前一刻解密，用后即弃） */
  credential?: { apiKey: string; baseUrl: string; model: string; provider: string } | null;
}

export type JudgeOutcome =
  | { kind: 'ok'; result: JudgeResult; latencyMs: number; tokensIn: number; tokensOut: number; attempts: number; usedSource: 'host_key' | 'site_fallback' | 'none' }
  | { kind: 'error'; errorClass: AiErrorClass; retryable: boolean; reasonCode: string; message: string; attempts: number };

export interface HostDeps {
  store: Store;
  logger: Logger;
  config: {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    model: string;
    key: string;
    timeoutMs: number;
    maxRetries: number;
  };
  /** 站点额度是否允许（月度上限 / 运维开关） */
  siteQuotaAllows: () => boolean;
  onCall?: (info: { source: string; ok: boolean; latencyMs: number; tokensIn: number; tokensOut: number; errorClass?: string }) => void;
}

// SCHEMA_INVALID 也重试：多数情况是输出被 max_tokens 截断或上游偶发返回散文，重试一次常常就正常了。
// 注意：L3 输出校验失败走的是另一条分支，那里显式 retryable:false（同一提示词重试大概率再犯）。
const RETRYABLE = new Set<AiErrorClass>(['CONNECT_TIMEOUT', 'READ_TIMEOUT', 'CONN_RESET', 'HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_5XX', 'SCHEMA_INVALID']);

export class HostService {
  private readonly deps: HostDeps;

  constructor(deps: HostDeps) {
    this.deps = deps;
  }

  get realModelEnabled(): boolean {
    return this.deps.config.enabled;
  }

  /**
   * 平台额度对应的凭据（站点自己的 Key）。
   * 与 `judge()` 里的站点回落用的是同一份配置，供"房主没填 Key 时用平台额度出题"使用。
   */
  siteCredential(): { apiKey: string; baseUrl: string; model: string; provider: string } | null {
    const { enabled, key, baseUrl, model, provider } = this.deps.config;
    if (!enabled || !key) return null;
    return { apiKey: key, baseUrl, model, provider };
  }

  /** 判定缓存键（与 core 的 verdictCacheKey 一致，只是拆开存三列）。 */
  private cacheParts(puzzleId: string, question: string, factSetVersion: number) {
    return {
      puzzleId,
      questionHash: stableHash(question.normalize('NFKC').replace(/\s+/g, ' ').trim()),
      promptVersion: PROMPT_VERSION,
      factSetVersion,
    };
  }

  /**
   * 执行一次判定。
   * 顺序：L0 预检（不花钱）→ 缓存 → 真实模型（如启用）→ 输出校验 → 规则兜底。
   */
  async judge(req: JudgeRequest): Promise<JudgeOutcome> {
    const factSetVersion = req.factSetVersion ?? 1;
    const parts = this.cacheParts(req.puzzle.id, req.question, factSetVersion);

    // ① L0 预检：命中即不调用模型，也就没有 token 成本
    const blocked = preflight(req.question);
    if (blocked) {
      this.deps.logger.info('judge_blocked', { room_id: req.roomId, turn_seq: req.turnSeq, code: blocked.reasonCode });
      return { kind: 'ok', result: blocked, latencyMs: 0, tokensIn: 0, tokensOut: 0, attempts: 0, usedSource: 'none' };
    }

    // ② 判定缓存：同一题目下同一问题永远同一结论
    const cached = this.deps.store.getVerdict(parts.puzzleId, parts.questionHash, parts.promptVersion, parts.factSetVersion);
    if (cached) {
      return {
        kind: 'ok',
        result: {
          answer: cached.answer as AnswerEnum,
          reasonCode: cached.reasonCode as ReasonCode,
          matchedFactIds: cached.matchedFactIds,
          source: 'cache',
        },
        latencyMs: 0, tokensIn: 0, tokensOut: 0, attempts: 0, usedSource: 'none',
      };
    }

    // ③ 选凭据：**房主自备 Key 优先**；房主没填才用平台额度（受月度上限约束）；
    //    两者都没有 → 内置规则主持人（离线可玩，语义与真实模型一致，只是不做语言理解）
    const hostCred = req.credential?.apiKey ? req.credential : null;
    const siteCred = this.deps.config.enabled && this.deps.config.key
      ? {
        apiKey: this.deps.config.key, baseUrl: this.deps.config.baseUrl,
        model: this.deps.config.model, provider: this.deps.config.provider,
      }
      : null;
    const cred = hostCred ?? (siteCred && this.deps.siteQuotaAllows() ? siteCred : null);
    if (!cred) {
      const result = mockJudge(req.question, { facts: req.puzzle.facts, factSetVersion, puzzleId: req.puzzle.id });
      this.deps.store.putVerdict({ ...parts, answer: result.answer, reasonCode: result.reasonCode, matchedFactIds: result.matchedFactIds, hitCount: 0, createdAt: Date.now() });
      return { kind: 'ok', result, latencyMs: 0, tokensIn: 0, tokensOut: 0, attempts: 0, usedSource: 'none' };
    }
    const usedSource: 'host_key' | 'site_fallback' = hostCred ? 'host_key' : 'site_fallback';

    // ④ 真实模型：带重试的调用 + L3 校验
    const maxAttempts = Math.max(1, 1 + this.deps.config.maxRetries);
    let lastError: JudgeOutcome & { kind: 'error' } = {
      kind: 'error', errorClass: 'UNKNOWN', retryable: false, reasonCode: 'UNKNOWN', message: '未执行', attempts: 0,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const call = await this.callModel(cred, req.question, req.puzzle);
      const latencyMs = Date.now() - started;

      if (!call.ok) {
        lastError = { kind: 'error', errorClass: call.errorClass, retryable: RETRYABLE.has(call.errorClass), reasonCode: call.errorClass, message: call.message, attempts: attempt };
        this.deps.onCall?.({ source: 'model', ok: false, latencyMs, tokensIn: 0, tokensOut: 0, errorClass: call.errorClass });
        this.deps.logger.warn('judge_call_failed', { room_id: req.roomId, turn_seq: req.turnSeq, code: call.errorClass, attempt, latency_ms: latencyMs });
        if (!lastError.retryable) return lastError;
        if (attempt < maxAttempts) await sleep(backoffMs(attempt));
        continue;
      }

      // L3 输出校验
      const features = analyzeInput(req.question).features;
      const validation = validateJudgeOutput(call.json, { truth: req.puzzle.truth.truth, facts: req.puzzle.facts, features });
      if (!validation.ok) {
        lastError = {
          kind: 'error',
          errorClass: validation.reason as AiErrorClass,
          retryable: false, // 同一提示词重试大概率再犯；直接走规则兜底
          reasonCode: validation.reason,
          message: validation.detail,
          attempts: attempt,
        };
        this.deps.onCall?.({ source: 'model', ok: false, latencyMs, tokensIn: call.tokensIn, tokensOut: call.tokensOut, errorClass: validation.reason });
        this.deps.logger.warn('judge_output_rejected', { room_id: req.roomId, turn_seq: req.turnSeq, code: validation.reason, reason: validation.detail, attempt });
        return lastError;
      }

      // 用事实表复核模型给出的 answer（模型只做映射，答案以事实表为准）
      const matched = req.puzzle.facts.filter((f) => validation.result.matchedFactIds.includes(f.id));
      const authoritative = decideFromFacts(matched);
      const finalAnswer = validation.result.answer === 'unanswerable' || validation.result.answer === 'irrelevant'
        ? validation.result.answer
        : authoritative;
      const result: JudgeResult = { ...validation.result, answer: finalAnswer };

      this.deps.store.putVerdict({ ...parts, answer: result.answer, reasonCode: result.reasonCode, matchedFactIds: result.matchedFactIds, hitCount: 0, createdAt: Date.now() });
      this.deps.onCall?.({ source: 'model', ok: true, latencyMs, tokensIn: call.tokensIn, tokensOut: call.tokensOut });
      this.deps.logger.info('judge_result', {
        room_id: req.roomId, turn_seq: req.turnSeq,
        answer: result.answer, reason_code: result.reasonCode, answer_source: 'model',
        credit_source: usedSource,
        latency_ms: latencyMs, attempt,
      });
      return { kind: 'ok', result, latencyMs, tokensIn: call.tokensIn, tokensOut: call.tokensOut, attempts: attempt, usedSource };
    }
    return lastError;
  }

  /** 规则兜底：模型不可用时，用事实表直接裁决（不涉及额度，不产生第二次判定）。 */
  ruleFallback(question: string, puzzle: Puzzle): JudgeResult {
    return mockJudge(question, { facts: puzzle.facts, puzzleId: puzzle.id });
  }

  // ---------------------------------------------------------------- 出题（AI 创作 / 补事实点）
  /**
   * 「要求模型返回严格 JSON」+ **自动重试**（判定那条路径早就有重试，出题这条路以前没有）。
   *
   * 为什么必须重试：`SCHEMA_INVALID`（模型偶发不按格式输出）/ 429 限流 / 5xx / 网络抖动
   * 都是**一次性的**，重试一次基本就好了。没有重试的话房主看到的就是"生成失败"，
   * 只能自己反复点，而且还会多消耗一次平台额度。重试上限沿用 AI_MAX_RETRIES。
   */
  private async callJsonWithRetry(
    cred: { apiKey: string; baseUrl: string; model: string; provider: string },
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<{ ok: true; raw: unknown; latencyMs: number } | { ok: false; errorClass: AiErrorClass; message: string }> {
    const maxRetries = Math.max(0, Number(this.deps.config.maxRetries ?? 0));
    let last: { ok: false; errorClass: AiErrorClass; message: string } = { ok: false, errorClass: 'UNKNOWN', message: '未执行' };
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const started = Date.now();
      const res = await this.callJson(cred, system, user, maxTokens);
      if (res.ok) return res;
      last = res;
      const retryable = RETRYABLE.has(res.errorClass);
      this.deps.logger.warn('json_call_failed', {
        code: res.errorClass, attempt, retryable, latency_ms: Date.now() - started,
      });
      if (!retryable || attempt > maxRetries) break;
      await new Promise((r) => setTimeout(r, 400 * attempt));   // 小退避：429 时别连着撞
    }
    return last;
  }

  /**
   * 让模型**创作**一道完整的新题（房主的「AI 创作」选项）。
   *
   * 与判定的区别：判定只做"问题 → 事实点映射"，这里要产出题面/汤底/事实点表三件套。
   * 事实点表最关键（它决定后续判定质量），所以提示词把"事实点怎么写"讲得很细；
   * 产出后由 core 的 checkAndNormalizePuzzle() 统一校验，不通过就整题作废、绝不入库。
   */
  async generatePuzzle(
    cred: { apiKey: string; baseUrl: string; model: string; provider: string },
    opts: { ratingMax?: 'L1' | 'L2' | 'L3'; difficultyMin?: number; difficultyMax?: number; avoidTitles?: string[] } = {},
  ): Promise<{ ok: true; raw: unknown; latencyMs: number } | { ok: false; errorClass: AiErrorClass; message: string }> {
    const system = [
      '你是一位海龟汤（情境推理游戏）出题人。请创作一道**全新的、自洽的**中文海龟汤，并给出严格 JSON。',
      '',
      '【什么是好的海龟汤】',
      '· 汤面：一段反常、诡异、缺少关键前提的小场景（10–200 字），读起来必须让人想问"为什么"。',
      '· 汤底：一句话能讲清但读者想不到的真相（10–400 字），必须能解释汤面里每一个反常之处。',
      '· **封闭世界**：真相只用到汤面里出现过的人、物、场景；不要引入汤面完全没提到的角色或地点。',
      '· 不许靠谐音、错别字、语言歧义、超自然力量、梦境幻觉作为唯一谜底（那属于脑筋急转弯，不是海龟汤）。',
      '',
      '【事实点表怎么写（最重要）】',
      '· 3–6 条原子事实，每条 2–40 字，只写"是/否"能判断的单一命题；不要写整段推理。',
      '· id 依次 f1, f2, f3…；tier 是揭示层级：1=表层（谁在哪做什么），2=中层（动机/关系），3=核心反转。',
      '· isTrue=true 表示这条在本题真相里成立；最多 2 条 isTrue=false 的"否定型"事实（用来让玩家排除常见误猜）。',
      '· required=true 的会进入"必需集"，玩家揭秘命中它们才算解出：请给 2–4 条，且都必须是 isTrue=true。',
      '· keys 是**玩家可能说出口**的 1–6 个短词（关键词兜底判定用），例如 ["灯塔","灯灭了","船难"]。',
      '· 事实点文本**不得与汤面重复**：汤面是题面，事实点是答案的组成部分。',
      '',
      '【输出格式（严格 JSON，不要任何多余文字）】',
      '{"title":"≤12 字标题","surface":"汤面","truth":"汤底","difficulty":1-5,"rating":"L1|L2|L3",',
      ' "tags":["本格","反转"],"sensitiveTags":["死亡"],"estMinutes":20,',
      ' "facts":[{"id":"f1","text":"…","isTrue":true,"tier":1,"required":true,"keys":["…"]}]}',
      '',
      '【内容红线】不得出现真实人物姓名、政治敏感内容、色情内容、可供模仿的危险操作。',
      '可以有悬疑与死亡元素（这是体裁的一部分），但不要血腥猎奇的细节描写。',
      opts.ratingMax ? `· 内容分级上限：${opts.ratingMax}（L1 最温和、L3 可含较强惊悚）` : '',
      opts.difficultyMin !== undefined ? `· 难度请落在 ${opts.difficultyMin}–${opts.difficultyMax} 之间` : '',
      opts.avoidTitles && opts.avoidTitles.length > 0 ? `· 不要与这些已有标题雷同：${opts.avoidTitles.slice(0, 20).join('、')}` : '',
      '',
      '现在开始：先在心里选定"一句话真相"，再倒推汤面，最后拆事实点。只输出 JSON。',
    ].filter(Boolean).join('\n');
    // 1800 而不是 1200：一整道题（汤面+汤底+事实点表）用 JSON 输出，被截断就会解析失败
    return this.callJsonWithRetry(cred, system, '请创作一道全新的海龟汤。', 1800);
  }

  /**
   * 给**已有**的汤面 + 汤底补出事实点表（把网上收集来的题目接进我们的判定引擎）。
   * 只补事实点、不改动原题文字，这样爬来的题保留原貌，同时能被判定使用。
   */
  async generateFacts(
    cred: { apiKey: string; baseUrl: string; model: string; provider: string },
    input: { surface: string; truth: string },
  ): Promise<{ ok: true; raw: unknown; latencyMs: number } | { ok: false; errorClass: AiErrorClass; message: string }> {
    const system = [
      '你是海龟汤题库的结构化助手。用户给你一道已有的海龟汤（汤面 + 汤底），',
      '你要把它拆成**事实点表**，供"是/否"判定使用。**不要改写汤面与汤底**。',
      '',
      '要求：',
      '· 3–8 条原子事实，每条 2–40 字，只写单一命题；id 依次 f1, f2, f3…',
      '· tier：1=表层事实，2=中层动机/关系，3=核心反转。',
      '· isTrue=true 表示汤底里成立；请额外给 1–2 条 isTrue=false 的常见误猜方向。',
      '· required=true 给 2–4 条且必须 isTrue=true：这些是"解开本题必须命中的关键点"。',
      '· keys：每条给 1–6 个玩家可能说出口的短关键词。',
      '· 事实点文本不得与汤面原文重复。',
      '',
      '输出严格 JSON：{"facts":[{"id":"f1","text":"…","isTrue":true,"tier":1,"required":true,"keys":["…"]}]}',
      '',
      '【繁体处理】如果汤面或汤底是**繁体中文**，请额外输出简体版本（只做繁简转换，不得改写内容）：',
      '{"facts":[…],"surface_simplified":"…","truth_simplified":"…"}',
      '本来就是简体时，省略这两个字段。',
      '',
      '【汤面】', input.surface,
      '【汤底】', input.truth,
    ].join('\n');
    return this.callJsonWithRetry(cred, system, '请输出事实点表 JSON。', 1200);
  }

  /**
   * 通用的「要求模型返回严格 JSON」调用（创作 / 补事实点共用）。
   * 与判定共用同一套超时、错误分类，以及能容忍围栏与截断的 JSON 解析。
   */
  private async callJson(
    cred: { apiKey: string; baseUrl: string; model: string; provider: string },
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<{ ok: true; raw: unknown; latencyMs: number } | { ok: false; errorClass: AiErrorClass; message: string }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(HostService.chatCompletionsUrl(cred.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.apiKey}` },
        body: JSON.stringify(buildJsonBody(cred, system, user, maxTokens)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const e = err as Error;
      return { ok: false, errorClass: e.name === 'AbortError' ? 'CONNECT_TIMEOUT' : 'CONN_RESET', message: e.message };
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      if (res.status === 401) return { ok: false, errorClass: 'HTTP_401', message: '鉴权失败（API Key 无效）' };
      if (res.status === 402) return { ok: false, errorClass: 'HTTP_402', message: '额度耗尽' };
      if (res.status === 429) return { ok: false, errorClass: 'HTTP_429', message: '上游限流' };
      if (res.status === 400) return { ok: false, errorClass: 'HTTP_400', message: '请求参数错误（检查模型名）' };
      if (res.status === 404) return { ok: false, errorClass: 'HTTP_404', message: '模型或 Base URL 不存在' };
      if (res.status >= 500) return { ok: false, errorClass: 'HTTP_5XX', message: `上游错误 ${res.status}` };
      return { ok: false, errorClass: 'UNKNOWN', message: `未预期的状态码 ${res.status}` };
    }
    let data: unknown;
    try { data = await res.json(); } catch { return { ok: false, errorClass: 'SCHEMA_INVALID', message: '响应不是 JSON' }; }
    const obj = data as { choices?: Array<{ message?: { content?: string; refusal?: string }; finish_reason?: string }> };
    if (obj.choices?.[0]?.message?.refusal) return { ok: false, errorClass: 'PROVIDER_REFUSAL', message: '上游拒绝回答（内容策略）' };
    const content = obj.choices?.[0]?.message?.content ?? '';
    const finishReason = obj.choices?.[0]?.finish_reason ?? '';
    const strict = extractJsonObject(content, { repair: false });   // 不做"补括号"的补救
    const jsonText = strict ?? extractJsonObject(content);
    if (!jsonText) {
      // finish_reason 必须带上：length = 被 max_tokens 截断（要提高上限），stop = 模型就是不肯按格式说
      return {
        ok: false,
        errorClass: 'SCHEMA_INVALID',
        message: `模型没有返回可解析的 JSON（finish_reason=${finishReason || '未知'}）：${leakSafePreview(content, '', 120)}`,
      };
    }
    // 只有靠"补括号"才解析成功、而上游明说被截断 → 这就是截断，别拿一个残缺对象去校验：
    // 出题 JSON 里 facts 排在最后，被切掉的正是最关键的字段，
    // 报"缺少 tier=1 的成立事实"会把人引到错误方向（真实故障：审计里那条 ai_puzzle_rejected）。
    if (!strict && finishReason === 'length') {
      return {
        ok: false,
        errorClass: 'SCHEMA_INVALID',
        message: `模型输出被 max_tokens 截断（finish_reason=length），JSON 不完整：${leakSafePreview(content, '', 120)}`,
      };
    }
    try {
      return { ok: true, raw: JSON.parse(jsonText), latencyMs };
    } catch {
      return { ok: false, errorClass: 'SCHEMA_INVALID', message: '模型输出的 JSON 无法解析' };
    }
  }

  /** 单次模型调用（含超时、错误分类、响应解析）。 */
  private async callModel(
    cred: { apiKey: string; baseUrl: string; model: string; provider: string },
    question: string,
    puzzle: Puzzle,
  ): Promise<{ ok: true; json: unknown; tokensIn: number; tokensOut: number } | { ok: false; errorClass: AiErrorClass; message: string }> {
    const url = HostService.chatCompletionsUrl(cred.baseUrl);
    const factList = puzzle.facts.map((f) => `${f.id}: ${f.text} (isTrue=${f.isTrue})`).join('\n');
    const system = [
      '你是海龟汤（情境推理游戏）的主持人。玩家只能得到「是 / 否 / 无关 / 无法回答」四类结论。',
      '你的唯一任务：把玩家的问题映射到给定的事实点，并返回严格 JSON。',
      '输出格式（只能包含这四个字段，禁止任何解释、禁止输出汤底）：',
      '{"answer":"yes|no|irrelevant|unanswerable","reason_code":"NONE|OUT_OF_SCOPE|META_QUESTION|LIST_REQUEST|SUBJECTIVE|COMPOUND_SPLIT_REQUIRED","matched_fact_ids":["f1"],"explain":"是——只针对你问的那一句。"}',
      '规则：',
      '1) 问题指向某条事实点且该事实成立 → answer=yes，matched_fact_ids 填该条 id；',
      '2) 指向的事实点不成立 → answer=no；',
      '3) 问题涉及汤底未提及、与真相无关的要素 → answer=irrelevant；',
      '4) 只有在问题询问你自身/判断依据/置信度（META_QUESTION）、要求批量列举（LIST_REQUEST）、开放式无法二值化（SUBJECTIVE）、或世界外（OUT_OF_SCOPE）时才用 unanswerable，并给出对应 reason_code；',
      '5) 绝不复述汤底，绝不在 JSON 之外输出任何文字。',
      '',
      '【explain（必填：每一类结论都要给，一句，不超过 25 个字）】',
      '· 作用：让玩家明白这个结论**针对的是他问题里的哪一部分**，而不是丢一个孤零零的"是/否"。',
      '· 写法：把玩家问题里的关键对象/说法复述进来，说清这个结论的适用范围。',
      '· 严禁引入汤底里没有的新信息：不得出现人名、数字、地点、原因、结局、动机等具体内容；',
      '  严禁复述或改述汤底与事实点原文；严禁写成"接近了/再想想/注意时间线"这类引导式提示，',
      '  严禁暗示下一步该问什么，严禁评价玩家的推理水平。',
      '· 反例（不许写）：「是因为他吃了同伴的肉才自杀的」「和那次海难有关」「再想想他为什么自责」「方向对了」。',
      '· 正例：「是——只针对你问的『门锁着』这一句。」「否——你问的『照片里的人』在本题设定里不出现。」',
      '  「你问的『天气』在本题设定里没有提到。」「这个问题要求列举，没法用是/否回答。」',
      '',
      '【本局汤底（仅供你判断，严禁输出）】',
      puzzle.truth.truth,
      '',
      '【事实点表】',
      factList,
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.apiKey}` },
        body: JSON.stringify(buildJudgeBody(cred, system, question)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const e = err as Error & { cause?: { code?: string } };
      const code = e.cause?.code ?? e.name;
      if (e.name === 'AbortError') return { ok: false, errorClass: 'CONNECT_TIMEOUT', message: '请求超时' };
      if (code === 'ECONNRESET' || code === 'EPIPE') return { ok: false, errorClass: 'CONN_RESET', message: '连接被重置' };
      return { ok: false, errorClass: 'CONNECT_TIMEOUT', message: e.message };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const status = res.status;
      if (status === 401) return { ok: false, errorClass: 'HTTP_401', message: '鉴权失败（API Key 无效）' };
      if (status === 403) return { ok: false, errorClass: 'HTTP_403', message: '无权限（模型或账号不可用）' };
      if (status === 402) return { ok: false, errorClass: 'HTTP_402', message: '额度耗尽，请充值或更换 Key' };
      if (status === 400) return { ok: false, errorClass: 'HTTP_400', message: '请求参数错误（检查模型名）' };
      if (status === 404) return { ok: false, errorClass: 'HTTP_404', message: '模型或 Base URL 不存在' };
      if (status === 408) return { ok: false, errorClass: 'HTTP_408', message: '上游超时' };
      if (status === 425) return { ok: false, errorClass: 'HTTP_425', message: '上游要求重试' };
      if (status === 429) return { ok: false, errorClass: 'HTTP_429', message: '上游限流' };
      if (status >= 500) return { ok: false, errorClass: 'HTTP_5XX', message: `上游错误 ${status}` };
      return { ok: false, errorClass: 'UNKNOWN', message: `未预期的状态码 ${status}` };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, errorClass: 'SCHEMA_INVALID', message: '响应不是 JSON' };
    }
    const obj = data as {
      choices?: Array<{ message?: { content?: string; refusal?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (obj.choices?.[0]?.message?.refusal) {
      return { ok: false, errorClass: 'PROVIDER_REFUSAL', message: '上游拒绝回答（内容策略）' };
    }
    const content = obj.choices?.[0]?.message?.content ?? '';
    const finishReason = obj.choices?.[0]?.finish_reason ?? '';
    const jsonText = extractJsonObject(content);
    if (!jsonText) {
      // 诊断信息要能定位问题，但**绝不能把汤底写进日志/审计**：预览先过泄露检查
      const preview = leakSafePreview(content, puzzle.truth.truth);
      this.deps.logger.warn('judge_output_parse_failed', {
        finish_reason: finishReason, content_len: content.length, preview,
      });
      if (!content.trim()) {
        return {
          ok: false, errorClass: 'SCHEMA_INVALID',
          message: `模型没有返回内容（finish_reason=${finishReason || '未知'}，通常是输出被 max_tokens 截断或模型不支持该参数）`,
        };
      }
      return { ok: false, errorClass: 'SCHEMA_INVALID', message: `模型输出不是可解析的 JSON（finish_reason=${finishReason || '未知'}）：${preview}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, errorClass: 'SCHEMA_INVALID', message: '模型输出不是可解析的 JSON（补救解析后仍然失败）' };
    }
    // 额外兜底：原始文本绝不能包含汤底片段（即使解析成功也要拦）
    // 例外：explain（补充说明）属于"锦上添花"，违规时只丢掉这一句，绝不因此中断整局。
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const objOut = parsed as Record<string, unknown>;
      if (typeof objOut.explain === 'string') {
        const why = isLeaky(objOut.explain, puzzle.truth.truth, puzzle.facts);
        if (why) {
          this.deps.logger.info('judge_explain_dropped', { reason: why });
          delete objOut.explain;
        }
      }
    }
    const sanitizedText = JSON.stringify(parsed);
    const leak = sharedNgram(sanitizedText, puzzle.truth.truth, 8);
    if (leak) return { ok: false, errorClass: 'LEAK_DETECTED', message: `输出与汤底共享片段：${leak}` };

    return {
      ok: true,
      json: parsed,
      tokensIn: obj.usage?.prompt_tokens ?? 0,
      tokensOut: obj.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * 连接测试（《阶段4》§2.3）：一次极小调用。
   * 429 视为"凭证有效但当前限流"（通过但打标记）；401/403/404/400 拒绝；5xx/超时拒绝但可重试。
   */
  async connectionTest(input: { apiKey: string; baseUrl: string; model: string }): Promise<{ ok: boolean; reasonCode: string; message: string; latencyMs: number }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(8000, this.deps.config.timeoutMs));
    try {
      const res = await fetch(HostService.chatCompletionsUrl(input.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (res.ok) return { ok: true, reasonCode: 'SUCCESS', message: '校验通过', latencyMs };
      const status = res.status;
      if (status === 429) return { ok: true, reasonCode: 'RATE_LIMITED_AT_SUBMIT', message: '凭证有效，但当前被上游限流（对局中可能失败；系统不会自动改用平台额度）', latencyMs };
      if (status === 401) return { ok: false, reasonCode: 'AUTH_FAILED', message: '鉴权失败：API Key 无效或已被撤销', latencyMs };
      if (status === 403) return { ok: false, reasonCode: 'PERMISSION_DENIED', message: '无权限：该账号不可访问此模型', latencyMs };
      if (status === 402) return { ok: false, reasonCode: 'QUOTA_EXHAUSTED', message: '额度不足：请充值或更换 Key', latencyMs };
      if (status === 404) return { ok: false, reasonCode: 'MODEL_OR_BASE_URL_NOT_FOUND', message: '模型名或 Base URL 不存在', latencyMs };
      if (status === 400) return { ok: false, reasonCode: 'INVALID_REQUEST', message: '请求参数不被接受（检查模型名）', latencyMs };
      if (status >= 500) return { ok: false, reasonCode: 'UPSTREAM_UNAVAILABLE', message: `上游不可用（${status}），请稍后重试`, latencyMs };
      return { ok: false, reasonCode: 'REJECTED', message: `未预期的状态码 ${status}`, latencyMs };
    } catch (e) {
      const err = e as Error;
      const reasonCode = err.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR';
      return { ok: false, reasonCode, message: reasonCode === 'UPSTREAM_TIMEOUT' ? '校验超时（8 秒）' : err.message, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拼接 Chat Completions 端点：Base URL 会自动补上 `/chat/completions`。
   * 容忍尾部斜杠；若调用方已经写全了后缀，则不重复追加（避免出现 /chat/completions/chat/completions）。
   */
  static chatCompletionsUrl(baseUrl: string): string {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) return '';
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  /** 简易 Base URL 校验（SSRF 防护，见《阶段4》§2.4）：仅 https、不得含 userinfo/query/fragment、不得为内网/回环。 */
  static validateBaseUrl(raw: string): { ok: true; host: string; url: string } | { ok: false; reason: string } {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: 'BASE_URL_INVALID' };
    }
    if (u.protocol !== 'https:') return { ok: false, reason: 'BASE_URL_MUST_BE_HTTPS' };
    if (u.username || u.password) return { ok: false, reason: 'BASE_URL_MUST_NOT_CONTAIN_CREDENTIALS' };
    if (u.search || u.hash) return { ok: false, reason: 'BASE_URL_MUST_NOT_CONTAIN_QUERY_OR_FRAGMENT' };
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'BASE_URL_PRIVATE_HOST' };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      const isPrivate = a === 10 || a === 127 || (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
      if (isPrivate) return { ok: false, reason: 'BASE_URL_PRIVATE_ADDRESS' };
    }
    return { ok: true, host: u.host, url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
  }

  /** 提示文案的兜底泄露检查（提示由服务端模板渲染，这里做最后一道校验）。 */
  static isHintLeaky(text: string, puzzle: Puzzle): string | null {
    const shared = sharedNgram(text, puzzle.truth.truth, 8);
    if (shared) return `与汤底共享片段：${shared}`;
    for (const f of puzzle.facts) {
      if (similarity(text, f.text) >= 0.95) return `与事实点 ${f.id} 几乎逐字相同`;
    }
    return null;
  }
}

/**
 * 从模型输出里尽力取出一个 JSON 对象。
 *
 * 线上真实故障（审计里能看到 SCHEMA_INVALID / "模型输出不是可解析的 JSON"）几乎都是这类原因：
 *   · 输出被 ```json 围栏包着，或前后带一句"好的，判定如下："
 *   · 输出被 max_tokens 截断，只差最后一个 } 或一个引号
 * 这里逐级放宽：整体 → 去掉围栏 → 第一个 { 到最后一个 } → 补齐未闭合的引号/括号。
 * 兜底解析出来的对象仍要过 L3 校验（枚举、白名单、越界字段），所以放宽解析不会放宽安全性。
 */
export function extractJsonObject(raw: string, opts: { repair?: boolean } = {}): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const unfenced = text.replace(/```[a-zA-Z]*/g, '').trim();
  for (const candidate of [text, unfenced]) {
    if (isJsonObject(candidate)) return candidate;
  }
  const start = unfenced.indexOf('{');
  if (start < 0) return null;
  const end = unfenced.lastIndexOf('}');
  const slice = end > start ? unfenced.slice(start, end + 1) : unfenced.slice(start);
  if (isJsonObject(slice)) return slice;
  if (opts.repair === false) return null;              // 只认"结构本来就完整"的输出
  const repaired = repairTruncatedJson(slice);
  if (repaired && isJsonObject(repaired)) return repaired;
  return null;
}

function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** 截断补救：补上未闭合的引号与括号，能救回"就差最后一个 }"的情况。 */
function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inString) return null;   // 结构本来就完整 → 不是截断问题
  let out = text.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');
  if (inString) out += '"';
  while (stack.length > 0) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

/** 日志预览：截到 160 字符；若与汤底共享 8-gram 片段则整体打码（日志里也不能出现汤底）。 */
export function leakSafePreview(text: string, truth: string, max = 160): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  if (truth && sharedNgram(cut, truth, 8)) return '<已屏蔽：预览与汤底重合>';
  return cut;
}

/**
 * 是否 DeepSeek 官方端点（只有它需要/支持 `thinking` 参数，别的兼容服务可能因未知字段直接 400）。
 */
export function isDeepSeekHost(baseUrl: string): boolean {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

/**
 * 构造判定请求体。
 *
 * ⚠️ 线上真实故障（D1 审计里的 SCHEMA_INVALID / "模型输出不是可解析的 JSON"）根因就在这：
 *   DeepSeek 的 **思考模式默认开启且 effort=high**（官方文档《思考模式》），思维链会先吃掉
 *   max_tokens 预算，导致 `content` 被截断甚至为空 —— 而思维链在 `reasoning_content` 里，不在 content。
 *   判定任务只是"问题 → 事实点"的映射，不需要思考模式，所以对 DeepSeek 显式关掉；
 *   同时把 max_tokens 提到 400（原来是 120，连正常 JSON 都可能放不下）。
 */
export function buildJudgeBody(
  cred: { baseUrl: string; model: string },
  system: string,
  question: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cred.model,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ question }) },
    ],
  };
  if (isDeepSeekHost(cred.baseUrl)) {
    body.thinking = { type: 'disabled' };
    body.reasoning_effort = 'low';   // 双保险：即使上游忽略 thinking，也不让它按 high 思考
  }
  return body;
}

/**
 * 通用的 JSON 请求体（判定 / 出题 / 补事实点共用同一套参数策略）。
 * 与 buildJudgeBody 一样：对 DeepSeek 关闭思考模式，避免思维链把输出预算吃光。
 */
export function buildJsonBody(
  cred: { baseUrl: string; model: string },
  system: string,
  user: string,
  maxTokens: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cred.model,
    temperature: 0.8,          // 出题需要一点创造性（判定那边固定 0）
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (isDeepSeekHost(cred.baseUrl)) {
    body.thinking = { type: 'disabled' };
    body.reasoning_effort = 'low';
  }
  return body;
}

function backoffMs(attempt: number): number {
  return attempt === 1 ? 500 : 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export { REASON_CODES };


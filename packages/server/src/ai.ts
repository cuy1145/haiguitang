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
  PROMPT_VERSION, REASON_CODES, analyzeInput, decideFromFacts, preflight, sharedNgram,
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

const RETRYABLE = new Set<AiErrorClass>(['CONNECT_TIMEOUT', 'READ_TIMEOUT', 'CONN_RESET', 'HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_5XX']);

export class HostService {
  private readonly deps: HostDeps;

  constructor(deps: HostDeps) {
    this.deps = deps;
  }

  get realModelEnabled(): boolean {
    return this.deps.config.enabled;
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
      '输出格式（只能包含这三个字段，禁止任何解释、禁止输出汤底）：',
      '{"answer":"yes|no|irrelevant|unanswerable","reason_code":"NONE|OUT_OF_SCOPE|META_QUESTION|LIST_REQUEST|SUBJECTIVE|COMPOUND_SPLIT_REQUIRED","matched_fact_ids":["f1"]}',
      '规则：',
      '1) 问题指向某条事实点且该事实成立 → answer=yes，matched_fact_ids 填该条 id；',
      '2) 指向的事实点不成立 → answer=no；',
      '3) 问题涉及汤底未提及、与真相无关的要素 → answer=irrelevant；',
      '4) 只有在问题询问你自身/判断依据/置信度（META_QUESTION）、要求批量列举（LIST_REQUEST）、开放式无法二值化（SUBJECTIVE）、或世界外（OUT_OF_SCOPE）时才用 unanswerable，并给出对应 reason_code；',
      '5) 绝不复述汤底，绝不在 JSON 之外输出任何文字。',
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
        body: JSON.stringify({
          model: cred.model,
          temperature: 0,
          max_tokens: 120,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ question }) },
          ],
        }),
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
    const obj = data as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (obj.choices?.[0]?.message?.refusal) {
      return { ok: false, errorClass: 'PROVIDER_REFUSAL', message: '上游拒绝回答（内容策略）' };
    }
    const content = obj.choices?.[0]?.message?.content ?? '';
    const jsonText = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, errorClass: 'SCHEMA_INVALID', message: '模型输出不是可解析的 JSON' };
    }
    // 额外兜底：原始文本绝不能包含汤底片段（即使解析成功也要拦）
    const leak = sharedNgram(jsonText, puzzle.truth.truth, 8);
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

function backoffMs(attempt: number): number {
  return attempt === 1 ? 500 : 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export { REASON_CODES };


/**
 * 凭据选择顺序（回归测试）
 *
 * 背景：服务端**没有**配置平台额度（AI_KEY 为空）时，房主自己提交的 API Key
 * 必须仍然生效——否则房主填了 Key 也会被静默降级成"内置模拟主持人"。
 *
 * 这里不联网：Base URL 指向 127.0.0.1:1（必然连接失败）。因此
 *   · 若房主凭据被采纳 → 判定返回 kind='error'（走过了真实调用路径）
 *   · 若被忽略并降级 → 返回 kind='ok' + 模拟主持人结论
 * 用这个可观测差异来判断凭据有没有被用上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { HostService } = await import('../../packages/server/src/ai.ts');
const { extractJsonObject, leakSafePreview, buildJudgeBody, isDeepSeekHost } = await import('../../packages/server/src/ai.ts');
const { leakPuzzle } = await import('../fixtures/puzzle.ts');
const makePuzzle = () => leakPuzzle();

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** 只用到 getVerdict / putVerdict 的最小仓储 */
function makeStore() {
  const map = new Map<string, unknown>();
  return {
    map,
    getVerdict(puzzleId: string, questionHash: string, promptVersion: string, factSetVersion: number) {
      return map.get([puzzleId, questionHash, promptVersion, factSetVersion].join('|')) ?? null;
    },
    putVerdict(row: Record<string, unknown>) {
      map.set([row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion].join('|'), row);
    },
  };
}

function makeHost(opts: { platformEnabled: boolean }) {
  const store = makeStore();
  const host = new HostService({
    store: store as never,
    logger: noopLogger,
    config: {
      enabled: opts.platformEnabled,
      provider: 'openai-compatible',
      baseUrl: 'https://platform.invalid/v1',
      model: 'platform-model',
      key: opts.platformEnabled ? 'sk-platform' : '',
      timeoutMs: 1500,
      maxRetries: 0,
    },
    siteQuotaAllows: () => true,
  });
  return { host, store };
}

const hostCredential = {
  apiKey: 'sk-host', baseUrl: 'https://127.0.0.1:1', model: 'deepseek-flash', provider: 'openai-compatible',
};

test('C1: 服务端未配置模型额度时，房主自备 Key 仍然会被使用（不再降级成模拟主持人）', async () => {
  const { host } = makeHost({ platformEnabled: false });
  const puzzle = makePuzzle();
  const outcome = await host.judge({
    roomId: 'r1', matchId: 'm1', turnSeq: 1, question: '他是因为看到了什么才这样做的吗？', puzzle,
    credential: hostCredential,
  });
  assert.equal(outcome.kind, 'error', '应当真的尝试调用房主提供的模型地址，而不是返回模拟结论');
});

test('C2: 既没有平台额度、房主也没填 Key → 回落内置模拟主持人（离线可玩）', async () => {
  const { host } = makeHost({ platformEnabled: false });
  const puzzle = makePuzzle();
  const outcome = await host.judge({
    roomId: 'r1', matchId: 'm1', turnSeq: 1, question: '他是因为看到了什么才这样做的吗？', puzzle,
    credential: null,
  });
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.kind === 'ok' && outcome.usedSource, 'none');
});

test('C3: 平台额度与房主 Key 同时存在 → 房主 Key 优先', async () => {
  const { host } = makeHost({ platformEnabled: true });
  const puzzle = makePuzzle();
  const outcome = await host.judge({
    roomId: 'r1', matchId: 'm1', turnSeq: 1, question: '他是因为看到了什么才这样做的吗？', puzzle,
    credential: hostCredential,
  });
  // 房主地址不可达 → 报错；若误用平台地址也会报错，但两者错误信息不同，这里只断言"没有降级成模拟"
  assert.equal(outcome.kind, 'error');
});

test('C4: 平台额度存在但房主未填 Key → 走平台额度（site_fallback），不降级', async () => {
  const { host } = makeHost({ platformEnabled: true });
  const puzzle = makePuzzle();
  const outcome = await host.judge({
    roomId: 'r1', matchId: 'm1', turnSeq: 1, question: '他是因为看到了什么才这样做的吗？', puzzle,
    credential: null,
  });
  assert.equal(outcome.kind, 'error', '应当尝试调用平台模型（不可达 → error），而不是直接用模拟主持人');
});

test('C5: 平台额度被月度上限挡住（siteQuotaAllows=false）→ 回落模拟主持人', async () => {
  const store = makeStore();
  const host = new HostService({
    store: store as never,
    logger: noopLogger,
    config: {
      enabled: true, provider: 'openai-compatible', baseUrl: 'https://platform.invalid/v1',
      model: 'platform-model', key: 'sk-platform', timeoutMs: 1500, maxRetries: 0,
    },
    siteQuotaAllows: () => false,
  });
  const outcome = await host.judge({
    roomId: 'r1', matchId: 'm1', turnSeq: 1, question: '他是因为看到了什么才这样做的吗？', puzzle: makePuzzle(),
    credential: null,
  });
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.kind === 'ok' && outcome.usedSource, 'none');
});

test('C6: chatCompletionsUrl 自动补后缀且不重复追加', () => {
  assert.equal(HostService.chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(HostService.chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(HostService.chatCompletionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(HostService.chatCompletionsUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/chat/completions');
  assert.equal(HostService.chatCompletionsUrl('  '), '');
});

/**
 * 线上故障回归：审计里出现过 SCHEMA_INVALID / "模型输出不是可解析的 JSON"，
 * 整局因此被中断。原因是模型输出带了围栏/前后文字/被截断，而旧代码只会
 * 朴素地 JSON.parse(content)。下面覆盖这些真实形态。
 */
test('C7: 模型输出带 ```json 围栏 → 仍能解析', () => {
  const out = extractJsonObject('```json\n{"answer":"yes","reason_code":"NONE","matched_fact_ids":["f1"]}\n```');
  assert.ok(out, '应当能取出 JSON');
  assert.deepEqual(JSON.parse(out), { answer: 'yes', reason_code: 'NONE', matched_fact_ids: ['f1'] });
});

test('C8: 模型输出前后带解释文字 → 取出其中的 JSON 对象', () => {
  const out = extractJsonObject('好的，判定如下：\n{"answer":"no","reason_code":"NONE","matched_fact_ids":[]}\n希望有帮助。');
  assert.ok(out, '应当能取出 JSON');
  assert.deepEqual(JSON.parse(out), { answer: 'no', reason_code: 'NONE', matched_fact_ids: [] });
});

test('C9: 输出被 max_tokens 截断（缺右括号）→ 补救解析', () => {
  const out = extractJsonObject('{"answer":"irrelevant","reason_code":"OUT_OF_SCOPE","matched_fact_ids":[]');
  assert.ok(out, '应当能补救出 JSON');
  assert.deepEqual(JSON.parse(out), { answer: 'irrelevant', reason_code: 'OUT_OF_SCOPE', matched_fact_ids: [] });
});

test('C10: 完全不是 JSON（纯文本 / 空）→ 返回 null，交给上层报 SCHEMA_INVALID', () => {
  assert.equal(extractJsonObject('我觉得这个问题与真相无关。'), null);
  assert.equal(extractJsonObject(''), null);
  assert.equal(extractJsonObject('   \n '), null);
  assert.equal(extractJsonObject('[1,2,3]'), null, '数组不算对象');
});

test('C11: 日志预览不得泄露汤底（与汤底重合时整体打码）', () => {
  const puzzle = makePuzzle();
  const leaky = leakSafePreview(puzzle.truth.truth.slice(0, 120), puzzle.truth.truth);
  assert.equal(leaky, '<已屏蔽：预览与汤底重合>');
  const safe = leakSafePreview('{"answer":"yes","reason_code":"NONE"}', puzzle.truth.truth);
  assert.equal(safe, '{"answer":"yes","reason_code":"NONE"}');
  assert.equal(leakSafePreview('', puzzle.truth.truth), '');
});

/**
 * 线上故障的根因回归：DeepSeek 思考模式默认开启（effort=high），思维链会吃掉 max_tokens，
 * 导致 content 为空/截断 → SCHEMA_INVALID 中断对局。所以判定请求必须显式关闭思考模式。
 */
test('C12: 判定请求对 DeepSeek 显式关闭思考模式，并给足输出预算', () => {
  const body = buildJudgeBody({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'SYS', '问题');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 400);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(JSON.parse((body.messages as Array<{ content: string }>)[1]!.content).question, '问题');
});

test('C13: 非 DeepSeek 端点不附带 thinking 字段（避免不认识的参数被 400）', () => {
  assert.equal(isDeepSeekHost('https://api.deepseek.com'), true);
  assert.equal(isDeepSeekHost('https://api.deepseek.com/v1'), true);
  assert.equal(isDeepSeekHost('https://notdeepseek.com'), false);
  assert.equal(isDeepSeekHost('https://api.openai.com/v1'), false);
  assert.equal(isDeepSeekHost('https://proxy.example.com/deepseek.com'), false);
  const body = buildJudgeBody({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' }, 'SYS', 'q');
  assert.equal('thinking' in body, false);
  assert.equal('reasoning_effort' in body, false);
});


/**
 * AI 出题链路的单元测试（**不联网**）。
 *
 * 做法：把 globalThis.fetch 换成一个只负责"回放预设响应"的桩，
 * 这样能真实覆盖 提示词 → 请求体 → 解析 → 校验 的整条链路，
 * 又能断言一些线上看不到的东西（例如 DeepSeek 必须关闭思考模式、response_format 必须是 json_object）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { HostService, buildJsonBody } = await import('../../packages/server/src/ai.ts');
const { checkAndNormalizePuzzle } = await import('../../packages/core/src/puzzle-check.ts');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const noopStore = { getVerdict: () => null, putVerdict: () => {} } as never;

function makeHost(timeoutMs = 3000, maxRetries = 0) {
  return new HostService({
    store: noopStore,
    logger: noopLogger,
    config: {
      enabled: true, provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', key: 'sk-test', timeoutMs, maxRetries,
    },
    siteQuotaAllows: () => true,
  });
}

/** 用一个固定内容替换全局 fetch，并记录最后一次请求 */
function stubFetch(content: string): { calls: Array<{ url: string; body: Record<string, unknown> }>; restore: () => void } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const VALID_PUZZLE = JSON.stringify({
  title: '空碗',
  surface: '他在面馆点了一碗面，一口没吃就付钱离开了，回家后却笑了。为什么？',
  truth: '他刚从监狱出来，二十年前他就是在这家面馆被抓走的。今天他终于吃上了同一碗面，确认自己真的自由了。',
  difficulty: 3,
  rating: 'L2',
  tags: ['反转'],
  sensitiveTags: [],
  estMinutes: 15,
  facts: [
    { id: 'f1', text: '他刚从监狱出来', isTrue: true, tier: 1, required: true, keys: ['监狱', '出狱'] },
    { id: 'f2', text: '二十年前他在面馆被抓', isTrue: true, tier: 2, required: true, keys: ['被抓', '二十年前'] },
    { id: 'f3', text: '他确认自己自由了', isTrue: true, tier: 3, required: true, keys: ['自由'] },
    { id: 'f4', text: '面里被下了毒', isTrue: false, tier: 1, required: false, keys: ['下毒'] },
  ],
});

test('G1: 出题请求体正确（json_object + DeepSeek 关闭思考模式 + 温度可创作）', () => {
  const body = buildJsonBody({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, 'SYS', 'USER', 1800);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 1800);
  assert.equal(body.temperature, 0.8, '出题需要一点创造性');
  assert.equal((body.messages as Array<{ role: string }>).length, 2);
  // 非 DeepSeek 端点不得带 thinking
  const other = buildJsonBody({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, 'SYS', 'USER', 800);
  assert.equal('thinking' in other, false);
});

test('G7: 出题失败会自动重试（SCHEMA_INVALID / 限流都是一次性的，别让房主反复手点）', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const replies = ['抱歉，我不能创作这类内容。', VALID_PUZZLE];   // 第一次不按格式，第二次正常
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    calls.push(String(url));
    const content = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 1);        // maxRetries=1
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, true, !res.ok ? `${res.errorClass}: ${res.message}` : '');
    assert.equal(calls.length, 2, '第一次失败后必须自动重试一次');
  } finally {
    globalThis.fetch = original;
  }
});

test('G8: 重试用尽后仍失败 → 错误消息要带 finish_reason（截断 vs 模型不听话，能一眼区分）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"title":"半截' }, finish_reason: 'length' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 0);
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorClass, 'SCHEMA_INVALID');
      assert.match(res.message, /finish_reason=length/, `要能看出是被 max_tokens 截断：${res.message}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('G2: 模型返回合法 JSON → generatePuzzle 解析成功，且能被校验器接受', async () => {
  const stub = stubFetch(VALID_PUZZLE);
  try {
    const host = makeHost();
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, true, !res.ok ? res.message : '');
    const checked = checkAndNormalizePuzzle(res.ok ? res.raw : null, { idPrefix: 'ai' });
    assert.equal(checked.ok, true, !checked.ok ? JSON.stringify(checked.issues) : '');
    if (checked.ok) {
      assert.equal(checked.puzzle.title, '空碗');
      assert.equal(checked.puzzle.facts.length, 4);
    }
    assert.match(stub.calls[0]!.url, /\/chat\/completions$/, '请求地址必须自动补 /chat/completions');
  } finally {
    stub.restore();
  }
});

test('G3: 模型输出带 ```json 围栏 / 前后解释文字 → 仍能解析', async () => {
  const stub = stubFetch('好的，这是题目：\n```json\n' + VALID_PUZZLE + '\n```\n希望你喜欢。');
  try {
    const host = makeHost();
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, true, !res.ok ? res.message : '');
  } finally {
    stub.restore();
  }
});

test('G4: 模型返回纯文本（没有 JSON）→ 明确失败，消息里带预览', async () => {
  const stub = stubFetch('抱歉，我不能创作这类内容。');
  try {
    const host = makeHost();
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorClass, 'SCHEMA_INVALID');
      assert.ok(res.message.includes('抱歉'), '错误消息应带模型输出预览，便于排查');
    }
  } finally {
    stub.restore();
  }
});

test('G5: 上游 401 / 429 / 5xx → 分类正确（供 UI 给出人话提示）', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, expected] of [[401, 'HTTP_401'], [429, 'HTTP_429'], [503, 'HTTP_5XX']] as const) {
      globalThis.fetch = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      const host = makeHost();
      const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.errorClass, expected, `HTTP ${status} 应归类为 ${expected}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('G6: generateFacts 只补事实点（用于导入网上收集的题目）', async () => {
  const stub = stubFetch(JSON.stringify({
    facts: [
      { id: 'f1', text: '她多年前在海上遇难', isTrue: true, tier: 1, required: true, keys: ['遇难'] },
      { id: 'f2', text: '丈夫把食物让给了她', isTrue: true, tier: 2, required: true, keys: ['丈夫'] },
      { id: 'f3', text: '她当时以为那是海龟汤', isTrue: true, tier: 2, required: true, keys: ['海龟汤'] },
    ],
  }));
  try {
    const host = makeHost();
    const res = await host.generateFacts(
      { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' },
      { surface: '她在餐厅点了一碗海龟汤，喝了一口就哭了。为什么？', truth: '多年前遇难时丈夫把自己的肉煮给她喝。' },
    );
    assert.equal(res.ok, true, !res.ok ? res.message : '');
    const facts = (res.ok ? res.raw : {}) as { facts?: unknown[] };
    assert.equal(Array.isArray(facts.facts), true);
    // 提示词里必须带上原题（否则模型无从拆解）
    assert.ok(String(stub.calls[0]!.body.messages ? JSON.stringify(stub.calls[0]!.body.messages) : '').includes('海龟汤'));
  } finally {
    stub.restore();
  }
});

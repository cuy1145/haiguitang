/**
 * AI 出题链路的单元测试（**不联网**）。
 *
 * 做法：把 globalThis.fetch 换成一个只负责"回放预设响应"的桩，
 * 这样能真实覆盖 提示词 → 请求体 → 解析 → 校验 的整条链路，
 * 又能断言一些线上看不到的东西（例如 DeepSeek 必须关闭思考模式、response_format 必须是 json_object）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { HostService, buildJsonBody, extractJsonObject } = await import('../../packages/server/src/ai.ts');
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

test('G8: 重试用尽后仍失败 → 截断单独归类，且消息里能一眼看出是截断', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"title":"半截' }, finish_reason: 'length' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 0);
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      // 截断以前混在 SCHEMA_INVALID 里，房主只能看到"没按要求返回 JSON"，看不出是预算不够
      assert.equal(res.errorClass, 'OUTPUT_TRUNCATED');
      assert.match(res.message, /finish_reason=length/, `要能看出是被 max_tokens 截断：${res.message}`);
      assert.match(res.message, /max_tokens/, '消息里要提到预算上限，便于房主换更短的模型');
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

test('G9: 思考模式的模型只回 reasoning_content → 归类为 THINKING_ONLY（能直接告诉房主换模型）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{
      message: { content: '', reasoning_content: '让我想想……玩家问的是门是不是锁着的，我需要对照事实点……' },
      finish_reason: 'length',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 0);
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', provider: 'openai-compatible' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorClass, 'THINKING_ONLY', `应当单独识别"只回思考过程"：${res.message}`);
      assert.match(res.message, /思考/, '消息里要说清是思考模式的问题');
      assert.match(res.message, /deepseek-flash/, '要给出可执行的下一步（换非思考模型）');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('G10: 判定被截断 → OUTPUT_TRUNCATED，且**重试时自动加大 max_tokens**', async () => {
  const budgets: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { max_tokens?: number };
    budgets.push(Number(body.max_tokens ?? 0));
    // 第一次故意截断，第二次正常返回 → 验"加大预算之后就成功了"
    const truncated = budgets.length === 1;
    return new Response(JSON.stringify({
      choices: [{
        message: { content: truncated ? '{"answer":"yes","reason_code":"NONE","matched_fact_ids":["f1"],"explain":"是——' : JSON.stringify({ answer: 'yes', reason_code: 'NONE', matched_fact_ids: ['f1'], explain: '是——只针对你问的这一句。' }) },
        finish_reason: truncated ? 'length' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 1);            // 允许重试一次
    const checked = checkAndNormalizePuzzle(JSON.parse(VALID_PUZZLE), { idPrefix: 'g' });
    assert.equal(checked.ok, true);
    const puzzle = checked.ok ? checked.puzzle : null;
    assert.ok(puzzle);
    const out = await host.judge({
      roomId: 'r1', matchId: null, turnSeq: 1, question: '门当时是锁着的吗？', puzzle: puzzle!,
      credential: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' },
    });
    assert.equal(out.kind, 'ok', out.kind === 'error' ? `${out.errorClass}: ${out.message}` : '');
    assert.equal(budgets.length, 2, '应当重试一次');
    assert.ok(budgets[1]! > budgets[0]!, `重试必须加大输出预算（${budgets.join(' → ')}）`);
  } finally {
    globalThis.fetch = original;
  }
});

test('G11: 正文里混着示例 JSON（思考外溢）→ 取第一个能解析的对象，而不是"第一个 { 到最后一个 }"', () => {
  const raw = '我先列个格式示例：{"answer":"yes"} 然后给出真正的结果：'
    + '{"answer":"no","reason_code":"NONE","matched_fact_ids":["f2"],"explain":"否——你问的『照片』在本题设定里不成立。"}';
  const got = extractJsonObject(raw);
  assert.ok(got, '应当能取出一个对象');
  const parsed = JSON.parse(got!) as { answer?: string; matched_fact_ids?: string[] };
  assert.equal(parsed.answer, 'no', `要取到真正的那个对象，而不是示例：${got}`);
  assert.deepEqual(parsed.matched_fact_ids, ['f2']);
  // 围栏 + 前后散文 + 截断（结尾少一个 }）仍要能救回来
  const fenced = '好的：\n```json\n{"answer":"yes","reason_code":"NONE","matched_fact_ids":["f1"],"explain":"是——只针对你问的那一句。"';
  const got2 = extractJsonObject(fenced);
  assert.ok(got2, '截断（差一个 }）应当被补救');
  assert.equal((JSON.parse(got2!) as { answer?: string }).answer, 'yes');
});

test('G12: 多余字段（explanation / reasoning / thought）一律判为越界，绝不进判定', async () => {
  const { validateJudgeOutput, analyzeInput } = await import('../../packages/core/src/verdict.ts');
  const checked = checkAndNormalizePuzzle(JSON.parse(VALID_PUZZLE), { idPrefix: 'g' });
  assert.equal(checked.ok, true);
  const puzzle = checked.ok ? checked.puzzle : null;
  assert.ok(puzzle);
  const features = analyzeInput('门当时是锁着的吗？').features;
  for (const extra of [{ explanation: '因为……' }, { reasoning: '思路……' }, { thought: '思考……' }]) {
    const v = validateJudgeOutput(
      { answer: 'yes', reason_code: 'NONE', matched_fact_ids: ['f1'], ...extra },
      { truth: puzzle!.truth.truth, facts: puzzle!.facts, features },
    );
    assert.equal(v.ok, false, `越界字段必须整条拒绝：${JSON.stringify(extra)}`);
    if (!v.ok) assert.equal(v.reason, 'SCHEMA_INVALID');
  }
});

test('G9x: 出题路径的截断错误也单独分类（不再混进 SCHEMA_INVALID）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"title":"半截' }, finish_reason: 'length' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    const host = makeHost(3000, 0);
    const res = await host.generatePuzzle({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.errorClass, 'OUTPUT_TRUNCATED');
      assert.match(res.message, /截断/);
    }
  } finally {
    globalThis.fetch = original;
  }
});


test('G13: 模型判 no 却命中成立的事实点 → 结论以事实表为准（yes），且不会留下「否——」的自相矛盾说明', async () => {
  // 线上真实出现过的一条记录：问题「他是否是顺手把钥匙放到沙发下的」，
  // 模型返回 answer=no + explain="否——…与事实不符。"，matched_fact_ids=["f2"]，
  // 而 f2 是成立的事实点 → 事实表复核改判 yes，模型那句「否——」被原样留着，
  // 公共记录就变成「主持人：是 … 否——…与事实不符」。
  const stub = stubFetch(JSON.stringify({
    answer: 'no', reason_code: 'NONE', matched_fact_ids: ['f1'],
    explain: '否——你问的『从监狱出来』与事实不符。',
  }));
  try {
    const host = makeHost(3000, 0);
    const checked = checkAndNormalizePuzzle(JSON.parse(VALID_PUZZLE), { idPrefix: 'g' });
    assert.equal(checked.ok, true);
    const puzzle = checked.ok ? checked.puzzle : null;
    const out = await host.judge({
      roomId: 'r1', matchId: null, turnSeq: 1, question: '他是不是刚从监狱出来？', puzzle: puzzle!,
      credential: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' },
    });
    assert.equal(out.kind, 'ok', out.kind === 'error' ? `${out.errorClass}: ${out.message}` : '');
    if (out.kind !== 'ok') return;
    // ① 结论以事实表为准：f1 成立 → yes
    assert.equal(out.result.answer, 'yes');
    // ② 模型原本的答案被留痕（否则事后无法判断是模型判错还是系统判错）
    assert.equal(out.result.answerModel, 'no');
    // ③ 说反了的那句必须丢掉（rooms.ts 会用 contextExplain 兜一句）
    assert.equal(out.result.explain, null);
  } finally {
    stub.restore();
  }
});

test('G14: 模型与事实表结论一致时不留痕（answerModel=null），说明句照常保留', async () => {
  const stub = stubFetch(JSON.stringify({
    answer: 'yes', reason_code: 'NONE', matched_fact_ids: ['f1'],
    explain: '是——只针对你问的『监狱』这一句。',
  }));
  try {
    const host = makeHost(3000, 0);
    const checked = checkAndNormalizePuzzle(JSON.parse(VALID_PUZZLE), { idPrefix: 'g' });
    const puzzle = checked.ok ? checked.puzzle : null;
    const out = await host.judge({
      roomId: 'r1', matchId: null, turnSeq: 1, question: '他是不是刚从监狱出来？', puzzle: puzzle!,
      credential: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'openai-compatible' },
    });
    assert.equal(out.kind, 'ok', out.kind === 'error' ? `${out.errorClass}: ${out.message}` : '');
    if (out.kind !== 'ok') return;
    assert.equal(out.result.answer, 'yes');
    assert.equal(out.result.answerModel ?? null, null, '没有分歧就不该留痕');
    assert.equal(out.result.explain, '是——只针对你问的『监狱』这一句。');
  } finally {
    stub.restore();
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


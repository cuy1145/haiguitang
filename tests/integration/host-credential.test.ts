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

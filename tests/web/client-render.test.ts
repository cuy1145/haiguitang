/**
 * 客户端渲染的回归测试（**没有浏览器，用最小 DOM 桩跑真实脚本**）。
 *
 * 为什么需要它：前端每 1.2 秒轮询一次，`render()` 是整页 `innerHTML` 重建。
 * 一旦"状态指纹"里混进了每轮都在变的字段（`room.serverTime`），
 * 指纹就永远不同 → 整页（含弹窗）每轮重建一次 → 弹窗入场动画反复重播，看起来就是**闪回**。
 * 这个 bug 已经出现过一次，所以用测试钉死：
 *   · 只有 serverTime 变化 → 指纹必须**不变**（不重渲染）
 *   · 真实状态变化 → 指纹必须**变化**（要重渲染）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 最小 DOM/浏览器桩：只提供 index.html 内联脚本启动时真正会碰到的那些东西 */
function loadClientScript() {
  const html = readFileSync(join(root, 'packages/web/public/index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 里应当有内联脚本');
  const script = m![1]!;

  const el = (): Record<string, unknown> => ({
    innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    firstChild: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    contains: () => false, focus() {}, setSelectionRange() {}, querySelectorAll: () => [],
    closest: () => null, getAttribute: () => null, setAttribute() {}, addEventListener() {}, onclick: null,
  });
  const document = {
    activeElement: null as unknown,
    title: '',
    querySelector: () => el(),
    querySelectorAll: () => [],
    getElementById: () => el(),
    createElement: () => el(),
    addEventListener() {},
    body: { appendChild() {}, removeChild() {} },
    visibilityState: 'visible',
  };
  const sandbox = {
    document,
    window: { getSelection: () => null, isSecureContext: false },
    location: { origin: 'https://example.com', search: '' },
    navigator: { clipboard: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => fn(),
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => 'x' },
    URLSearchParams, Response, confirm: () => true,
  } as Record<string, unknown>;
  sandbox.globalThis = sandbox;

  runInContext(script + '\n;globalThis.__probe = { stateFingerprint, S };', createContext(sandbox));
  return sandbox.__probe as {
    stateFingerprint: () => string;
    S: Record<string, unknown>;
  };
}

/** 一份"等待开局"的房间视图 */
function baseRoom(serverTime: number) {
  return {
    id: 'r1', code: 'ABC123', status: 'waiting', pauseReason: null, hostId: 'm1',
    config: { hintsEnabled: false, ratingMax: 'L2', difficultyMin: 1, difficultyMax: 5 },
    configVersion: 1, stateVersion: 5, eventSeq: 9, serverTime, roundNo: 1,
    turn: { seq: 0, memberId: null, phase: 'IDLE', deadlineAt: 0, graceDeadlineAt: 0, outcome: null, lateSubmit: false },
    members: [{ id: 'm1', name: '房主', isHost: true, ready: false, conn: 'connected', activity: 'active', score: 0, stateLabel: '在线' }],
    puzzle: null, vote: null, ai: { state: 'OK', reasonCode: null, blockedAt: null },
    credit: { mode: 'host_key', reason: 'LOCKED_ACTIVE', grantLeft: 0 },
    transfer: { state: 'idle', fromId: null, toId: null },
    result: null, canRevealTruth: false, revealedFacts: [],
    factTotal: 0, requiredFactTotal: 0, readyCount: 0, readyEligible: 1,
  };
}

test('W1: 只有 serverTime 变化时指纹不变（否则弹窗每 1.2 秒重建一次 = 闪回）', () => {
  const { stateFingerprint, S } = loadClientScript();
  S.screen = 'room';
  S.keyModal = true;                       // 打开"添加 API Key"弹窗
  S.drafts = { keyBase: 'https://api.deepseek.com', keyModel: 'deepseek-flash', keyValue: 'sk-abc' };
  S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  const first = stateFingerprint();

  S.view = { room: baseRoom(1_234_567), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  assert.equal(stateFingerprint(), first, 'serverTime 每轮都变，必须被剔除出指纹');
});

test('W2: 真实状态变化时指纹必须变化（否则界面不更新）', () => {
  const { stateFingerprint, S } = loadClientScript();
  S.screen = 'room';
  S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  const first = stateFingerprint();

  S.notice = '有人加入了';
  assert.notEqual(stateFingerprint(), first, 'notice 变化应当触发重渲染');

  const second = stateFingerprint();
  (S.view as { room: ReturnType<typeof baseRoom> }).room.readyCount = 1;   // 有人举手
  assert.notEqual(stateFingerprint(), second, '房间里的人数/准备状态变化应当触发重渲染');
});

test('W3: 弹窗的可见状态在指纹里；但 API Key 明文刻意不进指纹', () => {
  const { stateFingerprint, S } = loadClientScript();
  S.screen = 'room';
  S.keyModal = true;
  S.drafts = { keyBase: 'https://api.deepseek.com', keyModel: 'deepseek-flash', keyValue: 'sk-abc' };
  S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  const first = stateFingerprint();

  S.keyTest = { ok: true, message: '校验通过', latencyMs: 120, url: 'https://api.deepseek.com/chat/completions' };
  assert.notEqual(stateFingerprint(), first, '测试连接的结果要能显示出来');

  const second = stateFingerprint();
  S.keyMask = 'sk-****abcd';
  assert.notEqual(stateFingerprint(), second, '掩码要能显示出来');

  // Key 明文**故意**不参与指纹：打字时不该触发重渲染（值靠 S.drafts 回填就够）
  const third = stateFingerprint();
  (S.drafts as Record<string, string>).keyValue = 'sk-abcdef';
  assert.equal(stateFingerprint(), third, 'API Key 明文不应进入指纹（否则每次按键都会重渲染弹窗）');
  assert.ok(!stateFingerprint().includes('sk-abcdef'), '指纹里不应出现密钥明文');
});

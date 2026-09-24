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

  runInContext(script + '\n;globalThis.__probe = { stateFingerprint, viewRoom, S };', createContext(sandbox));
  return sandbox.__probe as {
    stateFingerprint: () => string;
    viewRoom: () => string;
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

/* ============================================================================
 * W4：移动端布局契约
 *
 * 手机上的痛点是「题目在最上面、输入框被记录推到最下面」，来回滚才能边看题边打字。
 * 修法是：≤900px 时两栏容器用 display:contents 摘壳，每张卡片成为 .grid 直接子项，
 * 再用 order 排成「发言者 → 汤面 → 该你问 → 输入框」。这些类是 CSS 排序的唯一抓手，
 * 谁把它们改名/删掉，手机布局就会静默退化 —— 所以在这里钉死。
 * ==========================================================================*/
function playingRoom(serverTime: number, canSubmit: boolean) {
  const room = baseRoom(serverTime) as Record<string, unknown>;
  room.status = 'playing';
  room.puzzle = {
    id: 'p1', title: '雨夜', surface: '一个人在雨里笑。', rating: 'L1', difficulty: 2,
    estMinutes: 5, tags: [], sensitiveTags: [], attribution: null,
  };
  room.turn = { seq: 1, memberId: 'm1', phase: 'ACTIVE', deadlineAt: serverTime + 40_000, graceDeadlineAt: 0, outcome: null, lateSubmit: false };
  const you = { memberId: 'm1', isHost: true, canSubmit, canHintT12: false, canHintT3: false, guessLeft: 1 };
  return { room, you };
}

test('W4: 手机上「汤面 → 记录 → 输入框」必须紧挨着（类名 + 排序契约）', () => {
  const html = readFileSync(join(root, 'packages/web/public/index.html'), 'utf8');
  // 1) 卡片类名齐全（CSS 靠它们排序）
  assert.match(html, /<div class="card puzzle-card">/, '汤面卡片需要 puzzle-card 类');
  assert.match(html, /class="card composer\$\{composerSticky \? ' sticky' : ''\}"/, '提问卡片需要 composer 类');
  assert.match(html, /<div class="card records">/, '记录卡片需要 records 类');
  assert.match(html, /<div class="col-side">[\s\S]*<div class="col-main">/, '两栏容器需要 col-side / col-main 类');
  assert.match(html, /<div class="speakerbox">/, '发言者条需要 speakerbox 类（手机上要单独置顶）');
  assert.match(html, /<div class="memlist">/, '玩家名单需要 memlist 类（手机上要沉底）');
  assert.match(html, /\.col-main,\.col-side\{display:contents\}/, '≤900px 必须摘掉两栏外壳，卡片才能单独排序');

  // 2) 排序选择器必须是**类名选择器**，不能是 .grid> 子选择器。
  //    display:contents 只改盒模型，DOM 树上卡片仍是 .col-main 的子节点，
  //    `.grid>.composer` 一个都匹配不到 —— 曾经因此让 order 全部静默失效。
  const mobile = html.slice(html.indexOf('@media(max-width:900px)'), html.indexOf('.row{display:flex'));
  assert.ok(mobile.includes('.col-main,.col-side{display:contents}'), '取到的应该是移动端布局块');
  assert.doesNotMatch(mobile, /\.grid>/, '移动端排序规则不能用 .grid> 子选择器（display:contents 后匹配不到）');

  const order = (cls: string) => {
    const m = mobile.match(new RegExp(`(?:^|[,\\s])${cls.replace('.', '\\.')}\\{order:(\\d+)\\}`));
    assert.ok(m, `缺少排序规则：${cls}`);
    return Number(m![1]);
  };
  const speaker = order('.speakerbox');
  const puzzle = order('.puzzle-card');
  const yours = order('.your-turn');
  const records = order('.records');
  const composer = order('.composer');
  const stats = order('.stats');
  assert.ok(speaker < puzzle, '发言者/倒计时必须在汤面之前');
  assert.ok(puzzle < yours && yours < records, '汤面 → 该你问 → 记录 必须连在一起');
  assert.ok(records < composer, '记录（刚判完的答案）要贴着输入框，边看判定边打字');
  assert.ok(composer < stats, '统计/汤主是次要信息，排在输入框之后');
  assert.ok(order('.roomcard') > stats && order('.memlist') > stats && order('.creditcard') > stats,
    '房间 / 玩家名单 / 额度来源属于参考信息，全部沉到最底部');

  // 3) 汤面卡片：手机上把「提示 / 提交推理·揭秘」抬到卡片顶部 ——
  //    吸附的输入框会盖住卡片末尾，操作按钮放下面等于被永久遮住。
  assert.match(mobile, /\.puzzle-card \.actions\{order:-1/,
    '提示/揭秘按钮要在移动端排到卡片顶部（否则被吸附的输入框盖住）');
});

test('W4b: 对局中手机端输入框吸附底部；等待/结束时不吸附（不挡内容）', () => {
  const { viewRoom, S } = loadClientScript();
  S.screen = 'room';
  S.questions = [];
  S.log = [];
  S.drafts = {};
  S.config = { realModelEnabled: true, vaultEnabled: true };
  S.pendingTimeline = [];

  const my = playingRoom(1000, true);
  S.view = { room: my.room, you: my.you, candidates: [] };
  assert.match(viewRoom(), /class="card composer sticky"/, '轮到我发言 → 输入框吸附在屏幕底部');

  // 对局进行中就吸附：别人发言时也想边看记录边预输入
  const other = playingRoom(1000, false);
  S.view = { room: other.room, you: other.you, candidates: [] };
  assert.match(viewRoom(), /class="card composer sticky"/, '对局进行中 → 保持吸附，随时能打字');

  // 等待开局 / 已结束：输入框留在文档流里（吸附会白占屏幕）
  S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  assert.match(viewRoom(), /class="card composer"/, '还没开局 → 不吸附');
  assert.doesNotMatch(viewRoom(), /class="card composer sticky"/);

  S.drafts = { ask: '它是不是在哭？' };
  assert.match(viewRoom(), /class="card composer sticky"/, '等待中已经写了草稿 → 吸附，别把已输入的内容收走');
});

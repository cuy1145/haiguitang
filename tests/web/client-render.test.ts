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
interface HarnessOpts {
  /** 可控的 fetch：竞态测试要在"请求已发出、响应还没回来"的窗口里做文章 */
  fetchImpl?: (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function loadClientScript(opts: HarnessOpts = {}) {
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
  const store = new Map<string, string>();
  const sandbox = {
    document,
    window: { getSelection: () => null, isSecureContext: false },
    location: { origin: 'https://example.com', search: '' },
    navigator: { clipboard: null },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: opts.fetchImpl ?? (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => fn(),
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => 'x' },
    URLSearchParams, Response, confirm: () => true,
  } as Record<string, unknown>;
  sandbox.globalThis = sandbox;

  runInContext(script + `
;globalThis.__probe = {
  stateFingerprint, viewRoom, S,
  pollOnce, sendAction, send, leaveRoom, startPolling, stopPolling, roomGone, joinOrCreate, applyViewPayload,
  token, setToken: (t) => saveSession('r1', 'm1', t), epoch: () => sessionEpoch, pollTimer: () => pollTimer,
};`, createContext(sandbox));
  // ready() 必须用**宿主机**的定时器：沙箱里的 setTimeout 是桩，永远不会回调（否则测试会挂住）。
  (sandbox.__probe as Record<string, unknown>).ready = () => new Promise<void>((r) => setTimeout(r, 0));
  return sandbox.__probe as {
    stateFingerprint: () => string;
    viewRoom: () => string;
    S: Record<string, any>;
    pollOnce: () => Promise<void>;
    sendAction: (action: unknown, opts?: unknown) => Promise<any>;
    send: (frame: { t: string; hidden?: boolean }) => void;
    leaveRoom: () => Promise<void>;
    startPolling: () => void;
    stopPolling: () => void;
    roomGone: (message?: string) => void;
    joinOrCreate: () => Promise<void>;
    applyViewPayload: (data: unknown) => void;
    token: () => string | null;
    setToken: (t: string) => void;
    ready: () => Promise<void>;
    epoch: () => number;
    pollTimer: () => number | null;
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

/* ============================================================================
 * W5–W7：退出房间时的竞态
 *
 * 现象（用户报的）：单人房间里点「离开」，有时会报一个 404，然后必须刷新页面才能继续。
 *
 * 机制：轮询是每 1.2 秒一发。点「离开」时很可能正好有一个 `/api/rooms/state` 在飞，
 * 而"最后一人离开"会让服务端**立刻物理清理房间**（删 sessions/rooms/questions…）。
 * 于是这个在飞的请求会出现两种结果，两种都会把已离开的用户坑住：
 *   · 认证已经过了、房间刚好被删 → 404 ROOM_NOT_FOUND → 客户端写"连接中断（HTTP 404），正在重试…"，
 *     而轮询已经停了，这句话永远挂在那儿；
 *   · 请求比清理先完成 → 200 + 旧房间快照 → applyViewPayload 又把页面拉回房间，
 *     令牌已清，任何操作都失败 —— 只能刷新。
 * 另外 clearSession() 没有清 S.connected，离开后在入口页打个字就会触发
 * "上报活动" → 没有令牌 → 页面上冒出"会话已失效，请重新加入房间"。
 *
 * 修法：会话代次 sessionEpoch。所有异步回调回来时对不上代次就整包丢弃；
 *      轮询拿到 404 视为"房间没了"，回入口页并给一句说明，而不是无限重试。
 * ==========================================================================*/

test('W5: 离开房间后，迟到的轮询响应不得把页面拉回房间（竞态）', async () => {
  let resolvePoll: ((r: Response) => void) | null = null;
  let pollStarted = false;
  const fetchImpl = (url: string) => {
    if (url.includes('/api/rooms/state')) {
      pollStarted = true;
      return new Promise<Response>((res) => { resolvePoll = res; });   // 挂在网络上，先不回来
    }
    return Promise.resolve(jsonRes({ ok: true }));                     // leave 动作
  };
  const c = loadClientScript({ fetchImpl });
  await c.ready();
  c.setToken('tok-race');                                // 已经在房间里（避免启动流程干扰）
  c.S.screen = 'room';
  c.S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };

  const pending = c.pollOnce();
  assert.equal(pollStarted, true, '轮询应当已经发出');
  await c.leaveRoom();                                   // 用户点「离开」
  assert.equal(c.S.screen, 'entry');
  const epochAfterLeave = c.epoch();

  // 迟到的 200 响应（带着旧房间快照）现在才回来
  resolvePoll!(jsonRes({ view: { room: baseRoom(1), you: { memberId: 'm1', canSubmit: true } }, seq: 9 }));
  await pending;

  assert.equal(c.S.screen, 'entry', '迟到的快照不能把页面拉回房间');
  assert.equal(c.S.error, '', '也不该写任何错误');
  assert.ok(!c.token(), '会话要清干净');
  assert.equal(c.epoch(), epochAfterLeave, '丢包不应改变会话代次');
});

test('W6: 房间被服务端清理（404）→ 回入口页 + 一句说明，而不是永远"连接中断"', async () => {
  let stateCalls = 0;
  const fetchImpl = async (url: string) => {
    if (url.includes('/api/rooms/state')) { stateCalls++; return jsonRes({ error: 'ROOM_NOT_FOUND' }, 404); }
    return jsonRes({ ok: true });
  };
  const c = loadClientScript({ fetchImpl });
  await c.ready();
  c.setToken('tok-gone');
  c.S.screen = 'room';
  c.S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };
  c.startPolling();
  await new Promise((r) => setTimeout(r, 0));            // 让首轮轮询跑完

  assert.equal(stateCalls, 1);
  assert.equal(c.S.screen, 'entry', '房间没了就回入口页');
  assert.ok(!c.token(), '会话要清掉（服务端已经没有这条会话了）');
  assert.equal(c.S.error, '', '这不算"连接中断"，不该吓用户');
  assert.match(String(c.S.notice), /已结束|已清理/, '要给一句人话说明');
  assert.equal(c.pollTimer(), null, '轮询必须停下，不能对着 404 无限重试');
});

test('W6b: 404 但只是路由不存在（前后端版本不匹配）→ 照实报连接问题，不许悄悄踢人回入口页', async () => {
  const fetchImpl = async () => jsonRes({ error: 'NOT_FOUND', path: '/api/rooms/state' }, 404);
  const c = loadClientScript({ fetchImpl });
  await c.ready();
  c.setToken('tok-mismatch');
  c.S.screen = 'room';
  c.S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };

  await c.pollOnce();

  assert.equal(c.S.screen, 'room', '路由不存在不等于房间没了，不能把人踢出去');
  assert.ok(c.token(), '会话也不该被清掉');
  assert.match(String(c.S.error), /404/, '要如实报出来，便于排查版本不匹配');
});

test('W7: 离开房间后不再上报活动/心跳（旧令牌不许再发请求）', async () => {
  const sent: string[] = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    sent.push(String(init?.body ?? url));
    return jsonRes({ ok: true });
  };
  const c = loadClientScript({ fetchImpl });
  await c.ready();
  c.setToken('tok-quiet');
  c.S.screen = 'room';
  c.S.connected = true;
  await c.leaveRoom();
  sent.length = 0;

  // 入口页打字/切后台都会走到这两个上报
  c.send({ t: 'activity' });
  c.send({ t: 'heartbeat' });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(sent, [], '旧会话不该再发任何请求');
  assert.equal(c.S.error, '', '更不该冒出"会话已失效"这种噪音');
  assert.equal(c.S.connected, false, '离开后连接状态要复位');
});

/* ============================================================================
 * W9：汤底公示（被猜出后对所有人公开）+ 回到选题
 * 这些是纯客户端的状态机：谁都能猜到"被猜出时要弹窗、返回后别再弹"。
 * ==========================================================================*/
function solvedRoom(serverTime: number) {
  const room = playingRoom(serverTime, false).room as Record<string, any>;
  room.status = 'settled';
  room.result = { result: 'solved', reason: '有人还原了真相' };
  room.truth = '多年前他和同伴在海上遇难漂流，同伴给他端来一碗"海龟汤"。';
  room.truthNote = '本局已被玩家猜出：汤底对所有人公开';
  room.canGuess = false;
  return room;
}

test('W9: 被猜出后自动弹一次汤底公示；返回后不再重复弹；下一局复位', () => {
  const { S, viewRoom, stateFingerprint } = loadClientScript();
  S.screen = 'room';
  S.questions = []; S.log = []; S.drafts = {}; S.pendingTimeline = [];
  S.config = { realModelEnabled: true, vaultEnabled: true };

  // 1) 还没结束：没有公示、也不弹窗
  const playing = playingRoom(1000, false);
  S.view = { room: playing.room, you: playing.you, candidates: [] };
  assert.equal(S.truthModal, false);
  assert.doesNotMatch(viewRoom(), /truthcard/, '进行中不得出现汤底公示');

  // 2) 被猜出：applyViewPayload 会弹一次
  const probe = loadClientScript();
  probe.S.screen = 'room';
  probe.S.questions = []; probe.S.log = []; probe.S.drafts = {}; probe.S.pendingTimeline = [];
  probe.S.config = { realModelEnabled: true, vaultEnabled: true };
  probe.applyViewPayload({ view: { room: solvedRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] }, timeline: [], questions: [] });
  assert.equal(probe.S.truthModal, true, '被猜出的那一刻要自动弹窗（所有人）');
  const html = probe.viewRoom();
  assert.match(html, /truthcard/, '页面上有汤底公示卡片');
  assert.match(html, /汤底揭晓/, '弹窗里有汤底揭晓');
  assert.match(html, /同伴给他端来一碗/, '弹窗里是汤底原文');
  assert.match(html, /btnTruthNext/, '房主有「回到选题」按钮');
  assert.match(html, /btnNextRound/, '结束卡片上也有「回到选题」入口');

  // 3) 点「返回」后：同一局不再自动弹（否则用户关不掉）
  probe.S.truthModal = false;
  probe.S.truthDismissedKey = `${probe.S.view.room.id}:${probe.S.view.room.roundNo}`;
  probe.applyViewPayload({ view: { room: solvedRoom(1200), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] }, timeline: [], questions: [] });
  assert.equal(probe.S.truthModal, false, '点过返回之后不能再弹出来');
  assert.match(probe.viewRoom(), /truthcard/, '但卡片还在（还能回看汤底）');

  // 4) 房主「回到选题」→ 房间回到 waiting，公示收起、下一局可以重新弹
  const reopened = { ...solvedRoom(1400), status: 'waiting', result: null, truth: null, truthNote: null, puzzle: null };
  probe.applyViewPayload({ view: { room: reopened, you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] }, timeline: [], questions: [] });
  assert.equal(probe.S.truthDismissedKey, '', '回到大厅后复位，下一局被猜出时还能弹');
  assert.doesNotMatch(probe.viewRoom(), /truthcard/, '下一局的等待状态里没有上一局的汤底公示');

  // 弹窗开关必须进指纹，否则弹出来也不会重渲染（闪回 bug 的反面）
  S.truthModal = false;
  const before = stateFingerprint();
  S.truthModal = true;
  assert.notEqual(stateFingerprint(), before, 'truthModal 必须在状态指纹里');
});

test('W8: 离开后可以立刻重开房间：入口页不该残留旧会话的报错', async () => {
  // 服务端：离开时最后一次轮询撞上"房间已被清理"（404），随后新建房间正常
  let left = false;
  let created = false;
  let resolveLatePoll: ((r: Response) => void) | null = null;
  let createCalls = 0;
  const newView = { room: baseRoom(2000), you: { memberId: 'm9', isHost: true, canSubmit: false }, candidates: [] };
  const fetchImpl = (url: string, init?: { method?: string; body?: string }) => {
    const body = String(init?.body ?? '');
    if (url.includes('/api/rooms/state')) {
      if (!left) return new Promise<Response>((res) => { resolveLatePoll = res; });   // 在飞的轮询
      if (created) return Promise.resolve(jsonRes({ view: newView, seq: 3, timeline: [], questions: [] }));
      return Promise.resolve(jsonRes({ error: 'ROOM_NOT_FOUND' }, 404));
    }
    if (body.includes('leave')) { left = true; return Promise.resolve(jsonRes({ ok: true, purged: true })); }
    if (init?.method === 'POST' && /\/api\/rooms$/.test(url)) {                        // 重新建房
      createCalls++;
      created = true;
      return Promise.resolve(jsonRes({ roomId: 'r9', memberId: 'm9', token: 'tok-new', view: newView }));
    }
    return Promise.resolve(jsonRes({ ok: true }));                                    // /api/config、/api/session
  };
  const c = loadClientScript({ fetchImpl });
  await c.ready();
  c.setToken('tok-old');
  c.S.screen = 'room';
  c.S.view = { room: baseRoom(1000), you: { memberId: 'm1', isHost: true, canSubmit: false }, candidates: [] };

  const inflight = c.pollOnce();
  await c.leaveRoom();
  resolveLatePoll!(jsonRes({ error: 'ROOM_NOT_FOUND' }, 404));   // 迟到的 404 现在才回来
  await inflight;
  assert.equal(c.S.error, '', '离开后不该留下"HTTP 404"这类报错');
  assert.equal(c.S.screen, 'entry');

  // 用户直接在入口页点「创建 / 加入」重开房间 —— 不该被上一次会话的错误挡住
  await c.joinOrCreate();
  assert.equal(createCalls, 1, '应当真的发出了建房请求');
  assert.equal(c.S.screen, 'room', '要能直接进新房间');
  assert.equal(c.S.error, '', '不能带着上一次的错误');
  assert.equal(c.S.notice, '', '也不能带着上一次的说明');
  assert.ok(c.token(), '要有新令牌');
});

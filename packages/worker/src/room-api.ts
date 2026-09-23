/**
 * 房间 API（方案 A：D1 + 惰性推进 + 轮询，无 Durable Objects）。
 *
 * 每个请求的固定流程（对应 docs/CF-WITHOUT-DO.md §2）：
 *
 *   ① 预读快照（D1）→ 构造请求级仓储 D1RoomStore
 *   ② 构造 RoomRuntime（复用 Node 版同一份代码），并挂一个**收集器会话**：
 *        runtime.broadcast() 原本把帧推给 WebSocket，这里改为收集到数组，
 *        于是"事件流"自动落成 D1 的 room_events —— rooms.ts 一行都不用改
 *   ③ 惰性推进：循环 tickOnce() 直到 stateVersion 不再变化（等价于"每秒 tick"）
 *   ④ 执行本次动作（submit/hint/guess/vote/config/房主操作…）
 *   ⑤ 单事务批次写回（房间行 CAS + 全部派生写入以新版本为条件）；冲突则重放（最多 3 次）
 *
 * 为什么正确：核心规则全是阈值型纯函数（now >= deadline），所以"按需补算"与"实时 tick"结果等价；
 * 顺序固定为 tickTurn → presenceTick → 移交 → 投票截止 → 中断超时自动投票（与 Node 版 tick 顺序一致）。
 */
import {
  DEFAULT_CONFIG, PRESETS, validateConfig, getMember, toPublicPuzzle,
} from '@ht/core';
import type { CoreMember, GameConfig, Puzzle } from '@ht/core';
import { RoomRuntime } from '../../server/src/rooms.ts';
import { HostService } from '../../server/src/ai.ts';
import type { Env } from './index.ts';
import {
  D1RoomStore, flushRoomStore, fetchEventsSince, findRoomByCode, loadSnapshot, lookupSession,
  roomCodeTaken, saveSession, purgeRoom,
} from './store-d1.ts';
import { ConsoleLogger } from './log.ts';
import { WebCryptoVault } from './vault.ts';
import { generateCode, json, messageOf, newId, randomToken, readJson, sanitizeNickname, sha256Hex } from './http.ts';

const logger = new ConsoleLogger('info');

/**
 * 房主自备 Key 的默认提供方（DeepSeek 官方 OpenAI 兼容端点）。
 * 仅用于**预填**表单，房主可以在弹窗里改成 DeepSeek / OpenAI / 任意兼容端点。
 * 凭据现在保存**完整 Base URL**（含路径，如 https://api.openai.com/v1），
 * 所以这里带不带路径都可以，前端预设会写全。
 */
export const DEFAULT_HOST_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_HOST_MODEL = 'deepseek-flash';

// ---------------------------------------------------------------- 公共入口
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/health' || path === '/api/config') return json({ error: 'NOT_FOUND' }, 404); // 由 index.ts 处理

  // ---- 无需登录 ----
  if (request.method === 'POST' && path === '/api/rooms') return createRoom(request, env);
  const joinMatch = /^\/api\/rooms\/([A-Za-z0-9]{4,8})\/join$/.exec(path);
  if (request.method === 'POST' && joinMatch) return joinRoom(request, env, joinMatch[1]!.toUpperCase());

  // ---- 需要登录（会话令牌 → 房间 + 成员）----
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'UNAUTHORIZED', message: '会话无效或已过期，请重新加入房间' }, 401);
  const { roomId, memberId } = auth;

  if (request.method === 'GET' && path === '/api/session') {
    return withRoom(env, roomId, async (runtime) => json({
      roomId, memberId, view: viewFor(runtime, memberId),
      events: [],
    }));
  }
  if (request.method === 'GET' && path === '/api/rooms/state') {
    // 前端轮询用这一个端点：一次拿到【视图快照 + 时间线 + 公共提问记录 + 自 since 起的新事件 + 最新 seq】
    const since = Number(url.searchParams.get('since') ?? 0);
    return withRoom(env, roomId, async (runtime, store) => json({
      view: viewFor(runtime, memberId),
      timeline: await loadTimeline(env, roomId),
      // 公共提问 / 对话记录：所有人都能看到的问答流水（不含事实点、不含汤底）
      questions: publicQuestionLog(runtime, store.listQuestions(roomId)),
      seq: runtime.room.eventSeq,
      stateVersion: runtime.room.stateVersion,
      events: since > 0
        ? [...(await fetchEventsSince(env.DB, roomId, since)), ...store.emittedEvents.filter((e) => e.seq > since)]
        : store.emittedEvents,
    }), { withQuestions: true });
  }
  if (request.method === 'GET' && path === '/api/rooms/events') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return withRoom(env, roomId, async (runtime, store) => json({
      since,
      seq: runtime.room.eventSeq,
      stateVersion: runtime.room.stateVersion,
      events: [...(await fetchEventsSince(env.DB, roomId, since)), ...store.emittedEvents.filter((e) => e.seq > since)],
    }));
  }
  if (request.method === 'POST' && path === '/api/rooms/actions') {
    return handleAction(request, env, roomId, memberId);
  }
  if (request.method === 'GET' && path === '/api/recap') {
    return withRoom(env, roomId, async (runtime) => {
      const recap = runtime.recap(memberId);
      if (!recap.ok) return json({ error: recap.code }, recap.code === 'UNAUTHORIZED' || recap.code === 'NOT_HOST' ? 403 : 409);
      return json(recap.view);
    }, { withQuestions: true });
  }
  if (path === '/api/credentials/test' && request.method === 'POST') return testCredential(request, env, roomId, memberId);
  if (path === '/api/credentials' && request.method === 'POST') return submitCredential(request, env, roomId, memberId);
  if (path === '/api/credentials' && request.method === 'DELETE') {
    return withRoom(env, roomId, async (runtime) => {
      const result = runtime.revokeKey(memberId);
      return json(result.ok ? { ok: true } : { error: result.code }, result.ok ? 200 : 400);
    });
  }

  return json({ error: 'NOT_FOUND', path }, 404);
}

// ---------------------------------------------------------------- 请求级运行时
interface RoomScoped { store: D1RoomStore; runtime: RoomRuntime }

/**
 * 载入 → 补算 → 执行 → CAS 写回；冲突时重放（最多 3 次）。
 * fn 内的一切 RoomRuntime 调用都在请求级仓储上生效，最后统一提交。
 */
async function withRoom(
  env: Env,
  roomId: string,
  fn: (runtime: RoomRuntime, store: D1RoomStore) => Promise<Response>,
  opts: { withQuestions?: boolean } = {},
): Promise<Response> {
  const vault = new WebCryptoVault(env.MASTER_KEY ?? null);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const snapshot = await loadSnapshot(env.DB, roomId, opts);
    if (!snapshot) return json({ error: 'ROOM_NOT_FOUND' }, 404);

    const store = new D1RoomStore(env.DB, snapshot);
    const host = new HostService({
      store,
      logger,
      config: {
        enabled: Boolean(env.AI_KEY && env.AI_BASE_URL && env.AI_MODEL),
        provider: env.AI_PROVIDER ?? 'openai-compatible',
        baseUrl: env.AI_BASE_URL ?? '',
        model: env.AI_MODEL ?? '',
        key: env.AI_KEY ?? '',
        timeoutMs: Number(env.AI_TIMEOUT_MS ?? 20000),
        maxRetries: Number(env.AI_MAX_RETRIES ?? 2),
      },
      siteQuotaAllows: () => {
        const cap = Number(env.SITE_MONTHLY_CALL_CAP ?? 0);
        return cap <= 0 || snapshot.usage.siteCalls < cap;
      },
    });

    const runtime = new RoomRuntime(snapshot.room, {
      store,
      logger,
      host,
      siteQuotaAllows: () => {
        const cap = Number(env.SITE_MONTHLY_CALL_CAP ?? 0);
        return cap <= 0 || snapshot.usage.siteCalls < cap;
      },
      grantBudgetCalls: Number(env.SITE_GRANT_BUDGET_CALLS ?? 200),
      grantMaxPerMatch: Number(env.SITE_GRANT_MAX_PER_MATCH ?? 2),
      grantCooldownSec: Number(env.SITE_GRANT_COOLDOWN_SEC ?? 600),
      decrypt: async (cred) => {
        if (!cred.blob) throw new Error('NO_BLOB');
        return vault.decrypt(cred.blob, cred.id, cred.ownerPlayerId, cred.roomId);
      },
      now: () => Date.now(),
      newId,
      rand: Math.random,
    });

    // 恢复候选题目列表：无状态请求下 RoomRuntime 内存里的 candidates 每次都是空的，
    //   · 等待开局 → 按房间筛选条件给出可选题目（房主可从中指定）
    //   · 选题投票进行中 → 用投票记录里持久化的 puzzleIds（否则客户端看不到候选卡片）
    if (snapshot.room.status === 'waiting') {
      runtime.setCandidates(store.listPuzzles({
        ratingMax: snapshot.room.config.ratingMax,
        difficultyMin: snapshot.room.config.difficultyMin,
        difficultyMax: snapshot.room.config.difficultyMax,
      }).slice(0, 8).map((p) => p.id));
    } else if (snapshot.room.vote && snapshot.room.vote.type === 'puzzle_choice' && snapshot.room.vote.status === 'open') {
      runtime.setCandidates([...snapshot.room.vote.puzzleIds]);
    }

    // 收集器会话：把 broadcast 出来的帧收集起来（原本推给 WebSocket）。
    // 注意：**在收到帧的当下就登记到事件表缓冲**——这样动作响应里能直接带上本次事件，
    // 客户端拿到响应即可渲染，无需再多一次轮询。若本次 CAS 失败，这些缓冲会随事务一起丢弃。
    const frames: Array<{ t: string; seq?: number; kind?: string; payload?: unknown; text?: string; stateVersion?: number }> = [];
    const detach = runtime.attachSession('__http__', {
      send: (frame) => {
        const f = frame as { t?: string; seq?: number; kind?: string; payload?: unknown; text?: string; stateVersion?: number };
        frames.push(f as never);
        if (f.t === 'event' && typeof f.seq === 'number') {
          store.recordEvent(f.seq, String(f.kind ?? 'event'), f.payload ?? {}, String(f.text ?? ''), Number(f.stateVersion ?? 0), Date.now());
        }
      },
    });

    let response: Response;
    try {
      // ③ 惰性推进：循环补算，直到状态稳定（等价于"每秒 tick"）
      for (let i = 0; i < 8; i++) {
        const before = runtime.room.stateVersion;
        await runtime.tickOnce();
        if (runtime.room.stateVersion === before) break;
      }
      // ④ 执行本次动作
      response = await fn(runtime, store);
    } finally {
      detach();
    }

    // 房间已在本次请求里被物理清理（最后一人离开）→ 不再写回、不再重试
    if (store.purged) return response;

    // 事件流已在收集器里登记进 store 缓冲（见上），这里只需提交事务
    const flush = await flushRoomStore(env.DB, store);
    if (flush.ok) return response;
    logger.warn('room_cas_conflict', { room_id: roomId, attempt, expected: store.expectedStateVersion });
  }
  return json({ error: 'CONFLICT', message: '房间状态正在被其他操作更新，请重试' }, 409);
}

// ---------------------------------------------------------------- 动作分发
async function handleAction(request: Request, env: Env, roomId: string, memberId: string): Promise<Response> {
  const body = await readJson(request);
  const type = String(body.type ?? '');
  return withRoom(env, roomId, async (runtime, store) => {
    const now = Date.now();
    switch (type) {
      case 'heartbeat':
      case 'activity':
        await runtime.reportSignal(memberId, type === 'activity' ? 'activity' : 'heartbeat', body.hidden === true);
        return ok(store);
      case 'submit': {
        const result = await runtime.submit(memberId, String(body.text ?? ''), String(body.clientSubmitId ?? newId('sub')), Number(body.turnSeq ?? -1));
        return result.ok ? ok(store) : fail(result.code, store);
      }
      case 'hint': {
        const result = await runtime.requestHint(memberId, Number(body.tier ?? 1) as 1 | 2 | 3);
        return result.ok ? ok(store, result.data) : fail(result.code, store);
      }
      case 'guess': {
        const result = await runtime.submitGuess(memberId, String(body.text ?? ''));
        return result.ok ? ok(store, result.data) : fail(result.code, store);
      }
      case 'vote': {
        const result = await runtime.castVote(memberId, String(body.choice ?? 'abstain'));
        return result.ok ? ok(store) : fail(result.code, store);
      }
      case 'config': {
        const result = await runtime.updateConfig(memberId, (body.patch ?? {}) as Partial<GameConfig>, Number(body.expectedVersion ?? -1));
        return result.ok ? ok(store) : fail(result.code, store, result.detail);
      }
      case 'start': {
        const result = await runtime.startMatch(memberId, body.mode === 'vote' ? 'vote' : 'pick', typeof body.puzzleId === 'string' ? body.puzzleId : undefined);
        return result.ok ? ok(store) : fail(result.code, store);
      }
      case 'skip_turn': { const r = await runtime.skipTurn(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'end_match': { const r = await runtime.endMatch(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'resume_transfer': { const r = await runtime.resumeTransfer(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'return_host': { const r = await runtime.returnHost(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'decline_return': { const r = await runtime.declineReturn(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'reenable_key': {
        const r = await runtime.reenableKey(memberId, body.yes === true);
        return r.ok ? ok(store, r.data) : fail(r.code, store);
      }
      case 'revoke_key': { const r = runtime.revokeKey(memberId); return r.ok ? ok(store) : fail(r.code, store); }
      case 'leave': {
        await runtime.removeMember(memberId);
        // 最后一名成员离开 → 视为过期房间，随请求直接清理（含密钥密文），不留残留数据
        if (runtime.room.members.length === 0) {
          await flushRoomStore(env.DB, store);   // 先把"成员已移除"落库，再整体删除
          store.purged = true;
          await purgeRoom(env.DB, roomId);
          logger.info('room_purged_on_leave', { room_id: roomId });
          return json({ ok: true, purged: true, events: [] });
        }
        return ok(store);
      }
      default:
        return json({ error: 'UNKNOWN_ACTION', type, message: `未知动作：${type}` }, 400);
    }
    void now;
  });
}

/**
 * 按「查看者」过滤候选题目（信息暴露面控制）：
 *  · 房主指定模式（等待开局）：候选题**只有房主能看到** —— 成员不必看到房主在挑什么
 *  · 投票选汤（vote 进行中）：所有人能看到候选题并投票
 * 在**服务端**过滤而不是前端隐藏：非房主的响应里根本不包含候选题数据。
 */
function viewFor(runtime: RoomRuntime, memberId: string): ReturnType<RoomRuntime['view']> {
  const view = runtime.view(memberId);   // 注意：这里必须是 runtime.view，不能是 viewFor（否则无限递归）
  const room = runtime.room;
  const isHost = room.hostId === memberId;
  const voteOpen = Boolean(room.vote && room.vote.type === 'puzzle_choice' && room.vote.status === 'open');
  if (!isHost && !voteOpen) {
    delete (view as { candidates?: unknown }).candidates;
  }
  return view;
}

function ok(store: D1RoomStore, data?: unknown): Response {
  return json({ ok: true, ...(data ? { data } : {}), events: store.emittedEvents, notice: '' });
}

function fail(code: string, store: D1RoomStore, detail?: unknown): Response {
  return json({ ok: false, error: code, message: messageOf(code), ...(detail ? { detail } : {}), events: store.emittedEvents }, 400);
}

// ---------------------------------------------------------------- 建房 / 加入
export function defaultConfigFor(preset: string, patch?: Partial<GameConfig>): GameConfig {
  const base = { ...(PRESETS[preset as keyof typeof PRESETS] ?? DEFAULT_CONFIG) };
  if (patch) Object.assign(base, patch);
  return base;
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const nickname = sanitizeNickname(body.nickname);
  const preset = typeof body.preset === 'string' && body.preset in PRESETS ? body.preset : 'standard';
  const config = defaultConfigFor(preset, body.config as Partial<GameConfig> | undefined);
  const validation = validateConfig(config);
  if (!validation.ok) return json({ error: 'INVALID_CONFIG', fields: validation.errors }, 400);

  const roomId = newId('room');
  let code = generateCode();
  for (let i = 0; i < 8 && await roomCodeTaken(env.DB, code); i++) code = generateCode();

  const now = Date.now();
  const room = emptyRoomRow(roomId, code, config, now);
  await env.DB.prepare(
    `INSERT INTO rooms(id, code, status, pause_reason, host_member_id, config_json, config_version, state_version, event_seq,
       puzzle_id, round_no, turn_json, revealed_facts_json, hint_json, vote_json, ai_json, credit_json, transfer_json,
       result_json, turn_order_json, turn_index, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    room.id, room.code, room.status, null, null, JSON.stringify(room.config), 1, 0, 0,
    null, 1, JSON.stringify(room.turn), '[]', JSON.stringify(room.hint), null,
    JSON.stringify(room.ai), JSON.stringify(room.credit), JSON.stringify(room.transfer),
    null, '[]', 0, now, now,
  ).run();

  const joined = await joinAsPlayer(env, roomId, nickname, false, true);
  if ('error' in joined) return json({ error: joined.error }, 409);
  return json({ roomId, code, memberId: joined.memberId, token: joined.token, view: joined.view });
}

async function joinRoom(request: Request, env: Env, code: string): Promise<Response> {
  const roomId = await findRoomByCode(env.DB, code);
  if (!roomId) return json({ error: 'ROOM_NOT_FOUND', message: '房间不存在或已结束' }, 404);
  const body = await readJson(request);
  const nickname = sanitizeNickname(body.nickname);
  const spectator = body.spectator === true;
  const joined = await joinAsPlayer(env, roomId, nickname, spectator, false);
  if ('error' in joined) return json({ error: joined.error }, 409);
  return json({ roomId, code, memberId: joined.memberId, token: joined.token, view: joined.view });
}

async function joinAsPlayer(
  env: Env,
  roomId: string,
  nickname: string,
  spectator: boolean,
  isHost: boolean,
): Promise<{ memberId: string; token: string; view: unknown } | { error: string }> {
  const memberId = newId('m');
  const playerId = newId('p');
  const token = randomToken();
  const now = Date.now();

  let failure: string | null = null;
  const response = await withRoom(env, roomId, async (runtime) => {
    const room = runtime.room;
    const players = room.members.filter((m) => m.role !== 'spectator').length;
    if (!spectator && players >= 12) { failure = 'ROOM_FULL'; return json({ error: 'ROOM_FULL' }, 409); }
    if (room.status === 'settled' || room.status === 'destroyed') { failure = 'ROOM_CLOSED'; return json({ error: 'ROOM_CLOSED' }, 409); }

    const member: CoreMember = {
      id: memberId, playerId, name: nickname, isBot: false,
      role: spectator ? 'spectator' : (isHost || room.members.length === 0 ? 'host' : 'member'),
      joinSeq: room.members.reduce((max, m) => Math.max(max, m.joinSeq), 0) + 1,
      conn: 'connected', activity: 'active', hidden: false,
      lastActivityAt: now, lastHeartbeatAt: now,
      skipStreak: 0, score: 0, hintsUsedT12: 0, hintsUsedT3: 0, guessesUsed: 0, lastHintAt: -1e9,
    };
    await runtime.addMember(member);
    return json({ ok: true });
  });

  if (failure) return { error: failure };
  if (response.status !== 200) return { error: 'JOIN_FAILED' };
  await saveSession(env.DB, await sha256Hex(token), roomId, memberId);

  const viewResponse = await withRoom(env, roomId, async (runtime) => json({ view: viewFor(runtime, memberId) }));
  const viewBody = await viewResponse.json() as { view?: unknown };
  return { memberId, token, view: viewBody.view ?? null };
}

// ---------------------------------------------------------------- 凭据（房主自备 Key）

/**
 * 「测试连接」：只验证 Key / Base URL / 模型名是否可用，**不保存任何东西**。
 *
 * 为什么要单独有这个端点：
 *   · 原端点把「测试」和「入库」绑在一起，失败时用户只看到一句错误，无法判断是哪一项写错了；
 *   · 这里把真实请求地址（Base URL 自动补 /chat/completions 后的结果）、状态码分类、耗时都回给前端，
 *     前端就能显示"✅ 通过 / ❌ 失败 + 原因"。
 * 安全边界：仅房主可调用；Base URL 走同一套 SSRF 校验；请求体固定且极小。
 */
async function testCredential(request: Request, env: Env, roomId: string, memberId: string): Promise<Response> {
  const body = await readJson(request);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_HOST_MODEL;
  const baseUrlRaw = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : DEFAULT_HOST_BASE_URL;
  if (!apiKey) return json({ ok: false, error: 'MISSING_API_KEY', message: '请先填写 API Key' }, 400);

  const baseUrl = HostService.validateBaseUrl(baseUrlRaw);
  if (!baseUrl.ok) {
    return json({
      ok: false, error: baseUrl.reason, message: 'Base URL 不合法（必须是 https 公网地址，且不能带 query/fragment）',
    }, 200);   // 测试结果一律 200，用 ok 字段表达成败，前端才好展示
  }
  const url = HostService.chatCompletionsUrl(baseUrl.url);

  return withRoom(env, roomId, async (runtime, store) => {
    if (runtime.room.hostId !== memberId) {
      return json({ error: 'NOT_HOST', message: '只有房主可以测试自备 Key' }, 403);
    }
    const host = new HostService({
      store, logger,
      config: {
        enabled: true, provider: 'openai-compatible', baseUrl: baseUrl.url, model, key: apiKey,
        timeoutMs: Number(env.AI_TIMEOUT_MS ?? 20000), maxRetries: 0,
      },
      siteQuotaAllows: () => true,
    });
    const test = await host.connectionTest({ apiKey, baseUrl: baseUrl.url, model });
    logger.info('credential_test', { room_id: roomId, ok: test.ok, reason: test.reasonCode, latency_ms: test.latencyMs });
    return json({
      ok: test.ok, error: test.ok ? null : test.reasonCode, reasonCode: test.reasonCode,
      message: test.message, latencyMs: test.latencyMs, url, model,
      stored: false,
    });
  });
}

async function submitCredential(request: Request, env: Env, roomId: string, memberId: string): Promise<Response> {
  const vault = new WebCryptoVault(env.MASTER_KEY ?? null);
  if (!vault.enabled) {
    return json({ error: 'VAULT_DISABLED', message: '服务端未配置 MASTER_KEY，房主自备 Key 功能已关闭（不会明文存储）' }, 503);
  }
  const body = await readJson(request);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const provider = typeof body.provider === 'string' ? body.provider : 'openai-compatible';
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (env.AI_MODEL ?? DEFAULT_HOST_MODEL);
  const baseUrlRaw = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : (env.AI_BASE_URL ?? DEFAULT_HOST_BASE_URL);
  if (!apiKey || !model || !baseUrlRaw) return json({ error: 'MISSING_FIELDS', message: 'apiKey / baseUrl / model 必填' }, 400);
  const baseUrl = HostService.validateBaseUrl(baseUrlRaw);
  if (!baseUrl.ok) return json({ error: baseUrl.reason }, 400);

  return withRoom(env, roomId, async (runtime, store) => {
    const host = new HostService({
      store, logger,
      config: { enabled: true, provider, baseUrl: baseUrl.url, model, key: apiKey, timeoutMs: Number(env.AI_TIMEOUT_MS ?? 20000), maxRetries: 0 },
      siteQuotaAllows: () => true,
    });
    const test = await host.connectionTest({ apiKey, baseUrl: baseUrl.url, model });
    if (!test.ok) {
      return json({
        error: test.reasonCode, message: test.message, latencyMs: test.latencyMs,
        url: HostService.chatCompletionsUrl(baseUrl.url), model,
      }, 400);
    }

    const member = getMember(runtime.room, memberId);
    if (!member) return json({ error: 'UNAUTHORIZED' }, 401);
    const credId = newId('cred');
    const blob = await vault.encrypt(apiKey, credId, member.playerId, roomId);
    const now = Date.now();
    store.insertCredential({
      id: credId, ownerPlayerId: member.playerId, roomId, provider, model,
      // 存**完整 Base URL**（含路径，如 https://api.openai.com/v1）：OpenAI 等兼容端点必须带 /v1。
      // 该值在提交时已过 SSRF 校验（仅 https、无 query/fragment、非内网）。
      baseUrlHost: baseUrl.url,
      state: 'active', mask: vault.maskOf(apiKey), fingerprint: await vault.fingerprintOf(apiKey),
      blob: { cipher: blob.cipher as never, iv: blob.iv as never, tag: blob.tag as never, keyId: blob.keyId },
      ttlExpiresAt: now + 24 * 3600 * 1000, suspendReason: null, destroyedReason: null, createdAt: now, lastUsedAt: null,
    });
    runtime.setKeyState(memberId, 'active', vault.maskOf(apiKey));
    store.audit({ action: 'credential_submitted', roomId, subject: credId, result: test.reasonCode });

    // 换上可用的 Key 后，若对局正因 AI 中断而暂停，就立刻解除暂停继续玩
    // （否则房主修好了 Key 也永远卡在"等待房主处理"）
    const restored = await runtime.restoreAfterKeyUpdate(memberId);

    // 房主完成有效处理 → 若存在额度降级投票则立即作废
    await runtime.enqueue(() => {
      const room = runtime.room;
      if (room.vote && room.vote.type === 'fallback_credit' && room.vote.status === 'open') {
        runtime.room = { ...room, vote: { ...room.vote, status: 'rejected', result: '房主已提交新的 API Key，投票作废' } };
        runtime.persist();
      }
    });
    return json({
      ok: true,
      credential: { id: credId, provider, model, baseUrl: baseUrl.url, baseUrlHost: baseUrl.host, mask: vault.maskOf(apiKey), state: 'active', rateLimitedAtSubmit: test.reasonCode === 'RATE_LIMITED_AT_SUBMIT' },
      resumedBlockedMatch: restored.ok ? (restored.data?.resumed ?? false) : false,
      message: test.message,
    });
  });
}

// ---------------------------------------------------------------- 鉴权与工具
async function authenticate(request: Request, env: Env): Promise<{ roomId: string; memberId: string } | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (new URL(request.url).searchParams.get('token') ?? '');
  if (!token) return null;
  return lookupSession(env.DB, await sha256Hex(token));
}

async function loadTimeline(env: Env, roomId: string): Promise<Array<{ seq: number; kind: string; text: string; at: number; memberId: string | null }>> {
  const rows = await env.DB.prepare(
    "SELECT seq, kind, text, created_at, payload_json FROM room_events WHERE room_id = ? AND text != '' ORDER BY seq DESC LIMIT 200",
  ).bind(roomId).all<{ seq: number; kind: string; text: string; created_at: number; payload_json: string | null }>();
  return (rows.results ?? []).reverse().map((r) => {
    // 事件帧的 payload 里带着成员 id（用于把"谁做的"显示出来）；解析失败就当匿名
    let memberId: string | null = null;
    try {
      const payload = JSON.parse(String(r.payload_json ?? '{}')) as { memberId?: unknown };
      if (typeof payload?.memberId === 'string') memberId = payload.memberId;
    } catch { /* 忽略：payload 不是 JSON 时按匿名处理 */ }
    return { seq: Number(r.seq), kind: String(r.kind), text: String(r.text), at: Number(r.created_at), memberId };
  });
}

/**
 * 公共提问记录（所有人都能看到的问答流水）。
 *
 * 只做**白名单投影**：matchedFactIds（命中了哪些事实点）与任何汤底信息一律不下发——
 * 那属于"汤底/事实表"，只能通过 GET /api/recap 在结算后按门禁揭晓。
 * 这里给的 answer / reasonCode / source 本来就是对局中所有人可见的信息。
 */
function publicQuestionLog(
  runtime: RoomRuntime,
  questions: Array<{
    turnSeq: number; memberId: string; text: string; answer: string;
    reasonCode: string; source: string; late: boolean; explain?: string | null; createdAt: number;
  }>,
): Array<{
  turnSeq: number; memberId: string; memberName: string; text: string;
  answer: string; reasonCode: string; source: string; late: boolean; explain: string | null; at: number;
}> {
  const nameOf = (id: string): string => getMember(runtime.room, id)?.name ?? '已离开的玩家';
  return questions.map((q) => ({
    turnSeq: q.turnSeq, memberId: q.memberId, memberName: nameOf(q.memberId),
    text: q.text, answer: q.answer, reasonCode: q.reasonCode, source: q.source,
    late: q.late === true, explain: q.explain ?? null, at: q.createdAt,
  }));
}

function emptyRoomRow(id: string, code: string, config: GameConfig, now: number): {
  id: string; code: string; status: string; config: GameConfig;
  turn: unknown; hint: { tier3Used: number }; ai: unknown; credit: unknown; transfer: unknown;
} {
  return {
    id, code, status: 'waiting', config,
    turn: { seq: 0, memberId: null, phase: 'IDLE', startedAt: 0, deadlineAt: 0, graceDeadlineAt: 0, outcome: null, lateSubmit: false },
    hint: { tier3Used: 0 },
    ai: { state: 'OK', reasonCode: null, blockedAt: null },
    credit: { mode: 'host_key', reason: 'LOCKED_ACTIVE', grantLeft: 0, grantId: null },
    transfer: { state: 'idle', suspectAt: 0, fromId: null, toId: null, count: 0, cooldownUntil: 0 },
  };
}

export { toPublicPuzzle };
export type { Puzzle };

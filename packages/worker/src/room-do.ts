/**
 * 房间 Durable Object —— 生产运行时里"一个房间"的载体。
 *
 * 为什么这个映射非常自然（也是把规划从"自托管单实例"改成 CF 的核心收益）：
 *  · **串行化**：DO 天生单线程、单实例、强一致 —— 我原来自研的"房间级 Promise 队列"由运行时免费提供，
 *    而且更强：跨网络、跨重启、跨任意数量的并发客户端都成立
 *  · **定时器**：DO alarm 取代 setInterval（可休眠、可重试、按房间独立调度）
 *  · **持久化**：DO 自带 SQLite（`ctx.storage.sql`），本次实现把 Node 版的表结构原样搬过来
 *  · **WebSocket**：用 Hibernation API —— 无消息时 DO 可以休眠（不计时长），连接仍然保持
 *
 * 规则与编排**不在这里**：全部复用 `@ht/core` 与 `packages/server/src/rooms.ts` 的 RoomRuntime，
 * 本文件只做"运行时适配"（存储、定时、连接、AI 与密钥的运行期实现）。
 */
import { DEFAULT_CONFIG, PRESETS, validateConfig } from '@ht/core';
import type { GameConfig } from '@ht/core';
import { RoomRuntime, type SessionLike } from '../../server/src/rooms.ts';
import { HostService } from '../../server/src/ai.ts';
import type { Env } from './index.ts';
import { DoStore } from './store-do.ts';
import { ConsoleLogger } from './log.ts';
import { WebCryptoVault } from './vault.ts';
import { json, messageOf, newId, readJson, sanitizeNickname, securityHeaders, sha256Hex } from './http.ts';

/** 每个房间的出厂配置（房主可在开局前后调整；预设来自 core，不重复定义）。 */
export function defaultConfigFor(preset: string, patch?: Partial<GameConfig>): GameConfig {
  const base = { ...(PRESETS[preset as keyof typeof PRESETS] ?? DEFAULT_CONFIG) };
  if (patch) Object.assign(base, patch);
  return base;
}

export class RoomDurableObject implements DurableObject {
  private readonly roomId: string;
  private readonly store: DoStore;
  private readonly logger = new ConsoleLogger('info');
  private readonly vault: WebCryptoVault;
  private readonly host: HostService;
  private runtime: RoomRuntime | null = null;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.roomId = ctx.id.name ?? `room_${ctx.id.toString().slice(0, 8)}`;
    this.store = new DoStore(ctx.storage.sql, this.roomId);
    this.vault = new WebCryptoVault(env.MASTER_KEY ?? null);
    const logger = this.logger;
    this.host = new HostService({
      store: this.store,
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
        if (cap <= 0) return true;
        return this.store.usage('site', Date.now()).calls < cap;
      },
    });
  }

  /** 惰性重建运行时：DO 可能被回收，状态从 SQLite 恢复（内存态仅作缓存）。 */
  private ensureRuntime(): RoomRuntime {
    if (this.runtime) return this.runtime;
    const loaded = this.store.loadRoom(this.roomId);
    const room = loaded ?? {
      ...emptyRoomFor(this.roomId, this.store),
    };
    this.runtime = new RoomRuntime(room, {
      store: this.store,
      logger: this.logger,
      host: this.host,
      siteQuotaAllows: () => true,
      grantBudgetCalls: Number(this.env.SITE_GRANT_BUDGET_CALLS ?? 200),
      grantMaxPerMatch: Number(this.env.SITE_GRANT_MAX_PER_MATCH ?? 2),
      grantCooldownSec: Number(this.env.SITE_GRANT_COOLDOWN_SEC ?? 600),
      decrypt: async (cred) => {
        if (!cred.blob) throw new Error('NO_BLOB');
        return this.vault.decrypt(cred.blob, cred.id, cred.ownerPlayerId, cred.roomId);
      },
      now: () => Date.now(),
      newId,
      rand: Math.random,
    });
    return this.runtime;
  }

  // ---------------------------------------------------------------- HTTP（内部接口 + WS 升级）
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runtime = this.ensureRuntime();

    try {
      if (url.pathname === '/ws') return await this.handleUpgrade(request, runtime);

      const memberId = request.headers.get('x-ht-member') ?? '';
      const body = request.method === 'POST' || request.method === 'DELETE' ? await readJson(request) : {};

      switch (`${request.method} ${url.pathname}`) {
        case 'POST /internal/join': {
          const member = body.member as Parameters<typeof runtime.addMember>[0];
          if (!member) return json({ error: 'MEMBER_REQUIRED' }, 400);
          await runtime.addMember(member);
          await this.scheduleNextAlarm();
          return json({ ok: true, view: runtime.view(member.id) });
        }
        case 'POST /internal/leave':
          await runtime.removeMember(memberId);
          return json({ ok: true });
        case 'GET /internal/session':
          return json({ roomId: this.roomId, memberId, view: runtime.view(memberId) });
        case 'GET /internal/recap': {
          const recap = runtime.recap(memberId);
          if (!recap.ok) return json({ error: recap.code }, recap.code === 'UNAUTHORIZED' ? 403 : 409);
          return json(recap.view);
        }
        case 'POST /internal/credentials': {
          const result = await this.submitCredential(memberId, body);
          return json(result.body, result.status);
        }
        case 'DELETE /internal/credentials': {
          const result = runtime.revokeKey(memberId);
          return json(result.ok ? { ok: true } : { error: result.code }, result.ok ? 200 : 400);
        }
        case 'GET /internal/state':
          return json({
            roomId: this.roomId, status: runtime.room.status, stateVersion: runtime.room.stateVersion,
            eventSeq: runtime.room.eventSeq, turn: runtime.room.turn, ai: runtime.room.ai,
            credit: runtime.room.credit, transfer: runtime.room.transfer,
            members: runtime.room.members.map((m) => ({ id: m.id, name: m.name, conn: m.conn, activity: m.activity, role: m.role, keyState: runtime.keyStateOf(m.id).state })),
          });
        case 'POST /internal/seed-room': {
          // Library DO 建房后调用：写入房间码与出厂配置
          const config = defaultConfigFor(String(body.preset ?? 'standard'), body.config as Partial<GameConfig> | undefined);
          const validation = validateConfig(config);
          if (!validation.ok) return json({ error: 'INVALID_CONFIG', fields: validation.errors }, 400);
          runtime.room = {
            ...runtime.room,
            code: String(body.code ?? runtime.room.code),
            config,
            configVersion: runtime.room.configVersion + 1,
            updatedAt: Date.now(),
          };
          runtime.persist();
          return json({ ok: true });
        }
        default:
          return json({ error: 'NOT_FOUND' }, 404);
      }
    } catch (err) {
      this.logger.error('do_http_error', { room_id: this.roomId, path: url.pathname, code: (err as Error).message });
      return json({ error: 'INTERNAL', message: (err as Error).message }, 500);
    }
  }

  // ---------------------------------------------------------------- WebSocket（Hibernation）
  private async handleUpgrade(request: Request, runtime: RoomRuntime): Promise<Response> {
    const memberId = request.headers.get('x-ht-member') ?? '';
    if (!memberId) return json({ error: 'UNAUTHORIZED' }, 401);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 用 hibernation：无消息时 DO 可休眠，连接仍保持
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ memberId });

    const session: SessionLike = { send: (frame) => { try { server.send(JSON.stringify(frame)); } catch { /* 连接已断 */ } } };
    runtime.attachSession(memberId, session);
    await runtime.markOnline(memberId);

    session.send({
      t: 'hello',
      you: { memberId, roomId: this.roomId },
      serverTime: Date.now(),
      view: runtime.view(memberId),
    });
    this.logger.info('ws_connected', { room_id: this.roomId });
    await this.scheduleNextAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const runtime = this.ensureRuntime();
    const attachment = ws.deserializeAttachment() as { memberId?: string } | null;
    const memberId = attachment?.memberId ?? '';
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ t: 'error', id: 'unknown', ok: false, code: 'BAD_JSON', message: '无法解析的消息' }));
      return;
    }
    const id = typeof frame.id === 'string' ? frame.id : newId('msg');
    const reply = (ok: boolean, code?: string, data?: unknown): void => {
      if (ok) ws.send(JSON.stringify({ t: 'ack', id, ok: true, ...(data ? { data } : {}) }));
      else ws.send(JSON.stringify({ t: 'error', id, ok: false, code: code ?? 'ERROR', message: messageOf(code ?? 'ERROR') }));
    };

    try {
      switch (frame.t) {
        case 'ping': reply(true); break;
        case 'heartbeat':
        case 'activity':
          await runtime.reportSignal(memberId, frame.t as 'heartbeat' | 'activity', frame.hidden === true);
          reply(true);
          break;
        case 'snapshot':
          ws.send(JSON.stringify({ t: 'snapshot', serverTime: Date.now(), view: runtime.view(memberId) }));
          break;
        case 'submit': {
          const result = await runtime.submit(memberId, String(frame.text ?? ''), String(frame.clientSubmitId ?? newId('sub')), Number(frame.turnSeq ?? -1));
          await this.scheduleNextAlarm();
          if (result.ok) reply(true); else reply(false, result.code);
          break;
        }
        case 'hint': {
          const result = await runtime.requestHint(memberId, Number(frame.tier ?? 1) as 1 | 2 | 3);
          if (result.ok) reply(true, undefined, result.data); else reply(false, result.code);
          break;
        }
        case 'guess': {
          const result = await runtime.submitGuess(memberId, String(frame.text ?? ''));
          if (result.ok) reply(true, undefined, result.data); else reply(false, result.code);
          break;
        }
        case 'vote': {
          const result = await runtime.castVote(memberId, String(frame.choice ?? 'abstain'));
          if (result.ok) reply(true); else reply(false, result.code);
          break;
        }
        case 'config': {
          const result = await runtime.updateConfig(memberId, (frame.patch ?? {}) as Partial<GameConfig>, Number(frame.expectedVersion ?? -1));
          if (result.ok) reply(true); else reply(false, result.code, result.detail);
          break;
        }
        case 'start': {
          const result = await runtime.startMatch(memberId, frame.mode === 'vote' ? 'vote' : 'pick', typeof frame.puzzleId === 'string' ? frame.puzzleId : undefined);
          await this.scheduleNextAlarm();
          if (result.ok) reply(true); else reply(false, result.code);
          break;
        }
        case 'resume_transfer': { const r = await runtime.resumeTransfer(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        case 'return_host': { const r = await runtime.returnHost(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        case 'decline_return': { const r = await runtime.declineReturn(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        case 'reenable_key': {
          const r = await runtime.reenableKey(memberId, frame.yes === true);
          if (r.ok) reply(true, undefined, r.data); else reply(false, r.code);
          break;
        }
        case 'revoke_key': { const r = runtime.revokeKey(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        case 'skip_turn': { const r = await runtime.skipTurn(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        case 'end_match': { const r = await runtime.endMatch(memberId); reply(r.ok, r.ok ? undefined : r.code); break; }
        default:
          reply(false, 'UNKNOWN_FRAME');
      }
    } catch (err) {
      this.logger.error('ws_frame_error', { room_id: this.roomId, code: (err as Error).message, frame: frame.t });
      reply(false, 'INTERNAL', { message: (err as Error).message });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const runtime = this.ensureRuntime();
    const attachment = ws.deserializeAttachment() as { memberId?: string } | null;
    const memberId = attachment?.memberId;
    if (!memberId) return;
    runtime.detachSession(memberId, ws);
    await runtime.markOffline(memberId);
    await this.scheduleNextAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error', false);
  }

  // ---------------------------------------------------------------- 定时推进（alarm 取代 setInterval）
  async alarm(): Promise<void> {
    const runtime = this.ensureRuntime();
    await runtime.tickOnce();
    await this.scheduleNextAlarm();
  }

  /**
   * 调度下一次 tick：
   *  · 进行中 / 挂起（可能有人回来）→ 1 秒后继续
   *  · 等待中 / 已结束 → 不再调度（DO 可以彻底休眠，不计费）
   */
  private async scheduleNextAlarm(): Promise<void> {
    const room = this.runtime?.room;
    if (!room) return;
    const needsTicking = room.status === 'playing' || room.status === 'suspended' || room.vote?.status === 'open';
    if (needsTicking) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  // ---------------------------------------------------------------- 房主自备 Key（连接测试 + 加密入库）
  private async submitCredential(memberId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (!this.vault.enabled) {
      return { status: 503, body: { error: 'VAULT_DISABLED', message: '服务端未配置 MASTER_KEY，房主自备 Key 功能已关闭（不会明文存储）' } };
    }
    const runtime = this.ensureRuntime();
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const provider = typeof body.provider === 'string' ? body.provider : 'openai-compatible';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (this.env.AI_MODEL ?? '');
    const baseUrlRaw = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : (this.env.AI_BASE_URL ?? '');
    if (!apiKey || !model || !baseUrlRaw) return { status: 400, body: { error: 'MISSING_FIELDS', message: 'provider / apiKey / baseUrl / model 必填' } };

    const baseUrl = HostService.validateBaseUrl(baseUrlRaw);
    if (!baseUrl.ok) return { status: 400, body: { error: baseUrl.reason } };

    const test = await this.host.connectionTest({ apiKey, baseUrl: baseUrl.url, model });
    if (!test.ok) {
      this.store.audit({ action: 'credential_submit_failed', roomId: this.roomId, subject: test.reasonCode });
      return { status: 400, body: { error: test.reasonCode, message: test.message, latencyMs: test.latencyMs } };
    }

    const member = runtime.room.members.find((m) => m.id === memberId);
    if (!member) return { status: 401, body: { error: 'UNAUTHORIZED' } };

    const credId = newId('cred');
    const blob = await this.vault.encrypt(apiKey, credId, member.playerId, this.roomId);
    const now = Date.now();
    this.store.insertCredential({
      id: credId, ownerPlayerId: member.playerId, roomId: this.roomId, provider, model,
      baseUrlHost: baseUrl.host, state: 'active', mask: this.vault.maskOf(apiKey),
      fingerprint: await this.vault.fingerprintOf(apiKey),
      blob: { cipher: blob.cipher as never, iv: blob.iv as never, tag: blob.tag as never, keyId: blob.keyId },
      ttlExpiresAt: now + 24 * 3600 * 1000, suspendReason: null, destroyedReason: null, createdAt: now, lastUsedAt: null,
    });
    runtime.setKeyState(memberId, 'active', this.vault.maskOf(apiKey));
    this.store.audit({ action: 'credential_submitted', roomId: this.roomId, subject: credId, result: test.reasonCode });

    // 房主完成有效处理 → 若存在额度降级投票则立即作废
    await runtime.enqueue(() => {
      const room = runtime.room;
      if (room.vote && room.vote.type === 'fallback_credit' && room.vote.status === 'open') {
        runtime.room = { ...room, vote: { ...room.vote, status: 'rejected', result: '房主已提交新的 API Key，投票作废' } };
        runtime.persist();
      }
      runtime.broadcastSnapshot();
    });
    return {
      status: 200,
      body: {
        ok: true,
        credential: { id: credId, provider, model, baseUrlHost: baseUrl.host, mask: this.vault.maskOf(apiKey), state: 'active', rateLimitedAtSubmit: test.reasonCode === 'RATE_LIMITED_AT_SUBMIT' },
        message: test.message,
      },
    };
  }
}

/** 房间不存在时创建一个空白房间（配置由 /internal/seed-room 覆盖）。 */
function emptyRoomFor(roomId: string, store: DoStore): Parameters<typeof RoomRuntime.prototype.persist> extends never ? never : {
  id: string; code: string; status: 'waiting'; pauseReason: null; hostId: null; members: never[]; turnOrder: string[];
  turnIndex: number; roundNo: number;
  turn: { seq: number; memberId: null; phase: 'IDLE'; startedAt: number; deadlineAt: number; graceDeadlineAt: number; outcome: null; lateSubmit: boolean };
  config: GameConfig; configVersion: number; stateVersion: number; eventSeq: number; puzzleId: null;
  revealedFacts: string[]; hint: { tier3Used: number }; vote: null;
  ai: { state: 'OK'; reasonCode: null; blockedAt: null };
  credit: { mode: 'host_key'; reason: 'LOCKED_ACTIVE'; grantLeft: number; grantId: null };
  transfer: { state: 'idle'; suspectAt: number; fromId: null; toId: null; count: number; cooldownUntil: number };
  result: null; createdAt: number; updatedAt: number;
} {
  const now = Date.now();
  void store;
  return {
    id: roomId, code: '', status: 'waiting', pauseReason: null, hostId: null, members: [], turnOrder: [],
    turnIndex: 0, roundNo: 1,
    turn: { seq: 0, memberId: null, phase: 'IDLE', startedAt: 0, deadlineAt: 0, graceDeadlineAt: 0, outcome: null, lateSubmit: false },
    config: { ...DEFAULT_CONFIG }, configVersion: 1, stateVersion: 0, eventSeq: 0, puzzleId: null,
    revealedFacts: [], hint: { tier3Used: 0 }, vote: null,
    ai: { state: 'OK', reasonCode: null, blockedAt: null },
    credit: { mode: 'host_key', reason: 'LOCKED_ACTIVE', grantLeft: 0, grantId: null },
    transfer: { state: 'idle', suspectAt: 0, fromId: null, toId: null, count: 0, cooldownUntil: 0 },
    result: null, createdAt: now, updatedAt: now,
  };
}

export { sanitizeNickname, sha256Hex, securityHeaders };

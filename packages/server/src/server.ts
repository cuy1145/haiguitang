/**
 * HTTP + WebSocket 服务层。
 *
 * 分工：
 *  - HTTP：建房、加入、提交/撤销自备 Key、复盘、健康检查、托管前端页面
 *  - WebSocket：对局内的实时动作与广播（提交、提示、揭秘、投票、房主操作、参数变更）
 *
 * 安全约束（每条都有对应测试）：
 *  - 一切输出都经过 core/dto.ts 的白名单投影 + assertNoLeak 兜底
 *  - Key 明文只在「入站提交」与「出站调用前一刻」存在，接口只回掩码
 *  - /debug/* 仅在 DEV_TOOLS=1 且监听回环地址时挂载
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_CONFIG, PRESETS, getMember, validateConfig } from '@ht/core';
import type { CoreMember, GameConfig } from '@ht/core';
import type { ServerConfig } from './config.ts';
import type { Logger } from './log.ts';
import { hashIp, memberRef } from './log.ts';
import type { Store } from './store.ts';
import { Vault } from './vault.ts';
import type { CredentialRecord } from './vault.ts';
import { HostService } from './ai.ts';
import { RoomRegistry, type RoomRuntime, type RuntimeDeps, type SessionLike } from './rooms.ts';
import type { ClientFrame, ServerFrame } from './protocol.ts';
import { MAX_PLAYERS, MAX_SPECTATORS, MIN_PLAYERS } from '@ht/core';

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  logger: Logger;
  vault: Vault;
  host: HostService;
  now: () => number;
  newId: (prefix: string) => string;
  rand: () => number;
  /** 静态资源目录（前端产物） */
  webDir: string;
  /** 是否自动跑定时器（测试中关闭，改由测试手动 tick） */
  autoTick: boolean;
}

interface AuthContext {
  memberId: string;
  roomId: string;
}

export class App {
  readonly registry: RoomRegistry;
  private readonly deps: AppDeps;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private timer: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<WebSocket, { memberId: string; roomId: string; detach: () => void }>();
  private ticking = false;

  constructor(deps: AppDeps) {
    this.deps = deps;
    const runtimeDeps: RuntimeDeps = {
      store: deps.store,
      logger: deps.logger,
      host: deps.host,
      siteQuotaAllows: () => {
        const cap = deps.config.site.monthlyCallCap;
        if (cap <= 0) return true;
        return deps.store.usage('site', deps.now()).calls < cap;
      },
      grantBudgetCalls: deps.config.site.grantBudgetCalls,
      grantMaxPerMatch: deps.config.site.grantMaxPerMatch,
      grantCooldownSec: deps.config.site.grantCooldownSec,
      decrypt: (cred: CredentialRecord) => {
        if (!cred.blob) throw new Error('NO_BLOB');
        return deps.vault.decrypt(cred.blob, cred.id, cred.ownerPlayerId, cred.roomId);
      },
      now: deps.now,
      newId: deps.newId,
      rand: deps.rand,
    };
    this.registry = new RoomRegistry(runtimeDeps);
    this.httpServer = createServer((req, res) => { void this.handleHttp(req, res); });
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => { void this.handleSocket(ws, url); });
    });
  }

  // ---------------------------------------------------------------- 生命周期
  async listen(): Promise<{ port: number; url: string }> {
    // 端口占用策略：未显式指定则 +1 递增尝试；显式指定则明确报错（见《阶段5》§6.1）
    const explicit = Boolean(process.env.PORT);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < (explicit ? 1 : 11); attempt++) {
      const port = this.deps.config.port + attempt;
      try {
        await new Promise<void>((res, rej) => {
          const onError = (err: Error): void => { this.httpServer.off('listening', onOk); rej(err); };
          const onOk = (): void => { this.httpServer.off('error', onError); res(); };
          this.httpServer.once('error', onError);
          this.httpServer.once('listening', onOk);
          this.httpServer.listen(port, this.deps.config.host);
        });
        if (this.deps.autoTick) {
          this.timer = setInterval(() => { void this.tick(); }, 250);
          this.timer.unref?.();
        }
        const address = this.httpServer.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        return { port: actualPort, url: `http://${this.deps.config.host}:${actualPort}` };
      } catch (e) {
        lastError = e as Error;
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    if (explicit) throw new Error(`端口 ${this.deps.config.port} 已被占用（显式指定端口时不自动换端口）`);
    throw lastError ?? new Error('无法启动服务');
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ws of this.sessions.keys()) { try { ws.close(); } catch { /* ignore */ } }
    await new Promise<void>((res) => this.wss.close(() => res()));
    await new Promise<void>((res) => this.httpServer.close(() => res()));
    this.deps.store.enableWALCheckpoint();
  }

  /** 定时推进：所有房间各投递一次任务（串行内部保证）。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now();
      for (const room of this.registry.all()) await room.tickOnce();
      this.registry.sweepLifecycle(now);
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- HTTP
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const ip = req.socket.remoteAddress;
    try {
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, url, ip);
        return;
      }
      if (url.pathname.startsWith('/debug/')) {
        await this.handleDebug(req, res, url);
        return;
      }
      await this.serveStatic(res, url.pathname);
    } catch (err) {
      this.deps.logger.error('http_error', { path: url.pathname, code: (err as Error).message });
      json(res, 500, { error: 'INTERNAL', message: (err as Error).message });
    }
    void ip;
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ip: string | undefined): Promise<void> {
    const now = this.deps.now();

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const integrity = this.deps.store.integrityCheck();
      json(res, 200, {
        ok: integrity.ok,
        rooms: this.registry.size,
        vault: this.deps.vault.enabled,
        realModel: this.deps.host.realModelEnabled,
        siteUsage: this.deps.store.usage('site', now),
        db: { integrity: integrity.detail },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      json(res, 200, {
        presets: PRESETS,
        defaultConfig: DEFAULT_CONFIG,
        maxPlayers: MAX_PLAYERS,
        minPlayers: MIN_PLAYERS,
        maxSpectators: MAX_SPECTATORS,
        vaultEnabled: this.deps.vault.enabled,
        realModelEnabled: this.deps.host.realModelEnabled,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(req);
      const nickname = sanitizeNickname(body.nickname);
      const preset = typeof body.preset === 'string' && body.preset in PRESETS ? body.preset as keyof typeof PRESETS : 'standard';
      const base: GameConfig = { ...PRESETS[preset] };
      if (body.config && typeof body.config === 'object') {
        const patch = body.config as Partial<GameConfig>;
        const validation = validateConfig({ ...base, ...patch });
        if (!validation.ok) { json(res, 400, { error: 'INVALID_CONFIG', fields: validation.errors }); return; }
        Object.assign(base, patch);
      }
      const runtime = this.registry.create(base, now);
      const joined = await this.joinRoom(runtime, nickname, false);
      if ('error' in joined) { json(res, 409, { error: joined.error }); return; }
      this.deps.logger.info('room_created', { room_id: runtime.room.id, member_ref: memberRef(joined.member.id), ip_hash: hashIp(ip, 'ht') });
      json(res, 200, { roomId: runtime.room.id, code: runtime.room.code, memberId: joined.member.id, token: joined.token, view: runtime.view(joined.member.id) });
      return;
    }

    const joinMatch = /^\/api\/rooms\/([A-Z0-9]{4,8})\/join$/.exec(url.pathname);
    if (req.method === 'POST' && joinMatch) {
      const runtime = this.registry.byCode(joinMatch[1]!);
      if (!runtime) { json(res, 404, { error: 'ROOM_NOT_FOUND' }); return; }
      const body = await readJson(req);
      const nickname = sanitizeNickname(body.nickname);
      const spectator = body.spectator === true && runtime.room.config.allowSpectator;
      const result = await this.joinRoom(runtime, nickname, spectator);
      if ('error' in result) { json(res, 409, { error: result.error }); return; }
      json(res, 200, { roomId: runtime.room.id, code: runtime.room.code, memberId: result.member.id, token: result.token, view: runtime.view(result.member.id) });
      return;
    }

    const auth = this.authenticate(req);
    if (!auth) { json(res, 401, { error: 'UNAUTHORIZED' }); return; }
    const runtime = this.registry.get(auth.roomId);
    if (!runtime) { json(res, 404, { error: 'ROOM_NOT_FOUND' }); return; }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      json(res, 200, { roomId: auth.roomId, memberId: auth.memberId, view: runtime.view(auth.memberId) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/recap') {
      const recap = runtime.recap(auth.memberId);
      if (!recap.ok) { json(res, recap.code === 'UNAUTHORIZED' ? 403 : 409, { error: recap.code }); return; }
      // 复盘含汤底：单独再断言一次"响应里除 truth 字段外不含汤底片段"
      json(res, 200, recap.view);
      return;
    }

    if (url.pathname === '/api/credentials' && req.method === 'POST') {
      await this.submitCredential(req, res, runtime, auth, ip);
      return;
    }

    if (url.pathname === '/api/credentials' && req.method === 'DELETE') {
      const result = runtime.revokeKey(auth.memberId);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.code });
      return;
    }

    json(res, 404, { error: 'NOT_FOUND' });
  }

  /** 提交自备 Key：先做连接测试，通过才落库并"锁定生效"。 */
  private async submitCredential(req: IncomingMessage, res: ServerResponse, runtime: RoomRuntime, auth: AuthContext, ip: string | undefined): Promise<void> {
    if (!this.deps.vault.enabled) {
      json(res, 503, { error: 'VAULT_DISABLED', message: '服务端未配置 MASTER_KEY，房主自备 Key 功能已关闭（不会明文存储）' });
      return;
    }
    const body = await readJson(req);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const provider = typeof body.provider === 'string' ? body.provider : 'openai-compatible';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : this.deps.config.ai.model;
    const baseUrlRaw = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : this.deps.config.ai.baseUrl;
    if (!apiKey || !model || !baseUrlRaw) { json(res, 400, { error: 'MISSING_FIELDS', message: 'provider / apiKey / baseUrl / model 必填' }); return; }
    const baseUrl = HostService.validateBaseUrl(baseUrlRaw);
    if (!baseUrl.ok) { json(res, 400, { error: baseUrl.reason }); return; }

    const test = await this.deps.host.connectionTest({ apiKey, baseUrl: baseUrl.url, model });
    if (!test.ok) {
      // 校验失败：立即销毁，不留下无用密文
      this.deps.store.audit({ action: 'credential_submit_failed', roomId: runtime.room.id, subject: test.reasonCode, ipHash: hashIp(ip, 'ht') });
      json(res, 400, { error: test.reasonCode, message: test.message, latencyMs: test.latencyMs });
      return;
    }

    const member = getMember(runtime.room, auth.memberId);
    if (!member) { json(res, 401, { error: 'UNAUTHORIZED' }); return; }
    const credId = this.deps.newId('cred');
    const blob = this.deps.vault.encrypt(apiKey, credId, member.playerId, runtime.room.id);
    const now = this.deps.now();
    this.deps.store.insertCredential({
      id: credId,
      ownerPlayerId: member.playerId,
      roomId: runtime.room.id,
      provider,
      model,
      baseUrlHost: baseUrl.host,
      state: 'active',
      mask: this.deps.vault.maskOf(apiKey),
      fingerprint: this.deps.vault.fingerprintOf(apiKey),
      blob,
      ttlExpiresAt: now + 24 * 3600 * 1000,
      suspendReason: null,
      destroyedReason: null,
      createdAt: now,
      lastUsedAt: null,
    });
    runtime.setKeyState(auth.memberId, 'active', this.deps.vault.maskOf(apiKey));
    this.deps.store.audit({ action: 'credential_submitted', roomId: runtime.room.id, subject: credId, result: test.reasonCode, ipHash: hashIp(ip, 'ht') });
    // 房主完成有效处理 → 若存在额度降级投票则立即作废（呼应《阶段4》§8.2）
    await runtime.enqueue(() => {
      const room = runtime.room;
      if (room.vote && room.vote.type === 'fallback_credit' && room.vote.status === 'open') {
        runtime['room'] = { ...room, vote: { ...room.vote, status: 'rejected', result: '房主已提交新的 API Key，投票作废' } };
      }
      runtime.persist();
      runtime.broadcast((mid) => ({ t: 'snapshot', serverTime: this.deps.now(), view: runtime.view(mid) }));
    });
    json(res, 200, {
      ok: true,
      credential: { id: credId, provider, model, baseUrlHost: baseUrl.host, mask: this.deps.vault.maskOf(apiKey), state: 'active', rateLimitedAtSubmit: test.reasonCode === 'RATE_LIMITED_AT_SUBMIT' },
      message: test.message,
    });
  }

  // ---------------------------------------------------------------- 静态资源
  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const full = resolve(join(this.deps.webDir, safe));
    if (!full.startsWith(resolve(this.deps.webDir))) { json(res, 403, { error: 'FORBIDDEN' }); return; }
    try {
      const info = await stat(full);
      if (!info.isFile()) throw new Error('not a file');
      const data = await readFile(full);
      res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      json(res, 404, { error: 'NOT_FOUND' });
    }
  }

  // ---------------------------------------------------------------- WS
  private async handleSocket(ws: WebSocket, url: URL): Promise<void> {
    const token = url.searchParams.get('token') ?? '';
    const member = this.memberByToken(token);
    if (!member) {
      ws.send(JSON.stringify({ t: 'error', id: 'hello', ok: false, code: 'UNAUTHORIZED', message: '无效的会话凭证，请重新加入房间' } satisfies ServerFrame));
      ws.close();
      return;
    }
    const runtime = this.registry.get(member.roomId);
    if (!runtime) {
      ws.send(JSON.stringify({ t: 'error', id: 'hello', ok: false, code: 'ROOM_NOT_FOUND', message: '房间不存在或已结束' } satisfies ServerFrame));
      ws.close();
      return;
    }

    const session: SessionLike = { send: (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); } };
    // 先注册消息处理器与关闭处理器，再做任何 await：
    // 否则中途抛错会让连接处于"已连上但收不到任何响应"的状态。
    const detach = runtime.attachSession(member.memberId, session);
    this.sessions.set(ws, { memberId: member.memberId, roomId: member.roomId, detach });
    ws.on('message', (raw) => { void this.handleFrame(ws, runtime, member.memberId, raw.toString()); });
    ws.on('close', () => {
      detach();
      this.sessions.delete(ws);
      void runtime.markOffline(member.memberId);
    });

    session.send({ t: 'hello', you: { memberId: member.memberId, roomId: member.roomId }, serverTime: this.deps.now(), view: runtime.view(member.memberId) } satisfies ServerFrame);
    await runtime.markOnline(member.memberId);
    this.deps.logger.info('ws_connected', { room_id: member.roomId, member_ref: memberRef(member.memberId) });
  }

  private async handleFrame(ws: WebSocket, runtime: RoomRuntime, memberId: string, raw: string): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
      this.reply(ws, 'unknown', false, 'BAD_JSON', '无法解析的消息');
      return;
    }
    const id = 'id' in frame && typeof frame.id === 'string' ? frame.id : randomUUID();
    try {
      switch (frame.t) {
        case 'ping':
          this.reply(ws, id, true);
          break;
        case 'heartbeat':
        case 'activity': {
          await runtime.reportSignal(memberId, frame.t as 'heartbeat' | 'activity', frame.hidden === true);
          this.reply(ws, id, true);
          break;
        }
        case 'snapshot':
          ws.send(JSON.stringify({ t: 'snapshot', serverTime: this.deps.now(), view: runtime.view(memberId) } satisfies ServerFrame));
          break;
        case 'submit': {
          const result = await runtime.submit(memberId, frame.text, frame.clientSubmitId, frame.turnSeq);
          if (result.ok) this.reply(ws, id, true);
          else this.reply(ws, id, false, result.code, undefined);
          break;
        }
        case 'hint': {
          const result = await runtime.requestHint(memberId, frame.tier);
          if (result.ok) this.reply(ws, id, true, undefined, result.data as Record<string, unknown> | undefined);
          else this.reply(ws, id, false, result.code);
          break;
        }
        case 'guess': {
          const result = await runtime.submitGuess(memberId, frame.text);
          if (result.ok) this.reply(ws, id, true, undefined, result.data as Record<string, unknown> | undefined);
          else this.reply(ws, id, false, result.code);
          break;
        }
        case 'vote': {
          const result = await runtime.castVote(memberId, frame.choice);
          if (result.ok) this.reply(ws, id, true);
          else this.reply(ws, id, false, result.code);
          break;
        }
        case 'config': {
          const result = await runtime.updateConfig(memberId, frame.patch, frame.expectedVersion);
          if (result.ok) this.reply(ws, id, true);
          else this.reply(ws, id, false, result.code, result.detail as Record<string, unknown> | undefined);
          break;
        }
        case 'start': {
          const result = await runtime.startMatch(memberId, frame.mode, frame.puzzleId);
          if (result.ok) this.reply(ws, id, true);
          else this.reply(ws, id, false, result.code);
          break;
        }
        case 'resume_transfer': {
          const result = await runtime.resumeTransfer(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        case 'return_host': {
          const result = await runtime.returnHost(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        case 'decline_return': {
          const result = await runtime.declineReturn(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        case 'reenable_key': {
          const result = await runtime.reenableKey(memberId, frame.yes);
          if (result.ok) this.reply(ws, id, true, undefined, result.data as Record<string, unknown> | undefined);
          else this.reply(ws, id, false, result.code);
          break;
        }
        case 'revoke_key': {
          const result = runtime.revokeKey(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        case 'skip_turn': {
          const result = await runtime.skipTurn(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        case 'end_match': {
          const result = await runtime.endMatch(memberId);
          this.reply(ws, id, result.ok, result.ok ? undefined : result.code);
          break;
        }
        default:
          this.reply(ws, id, false, 'UNKNOWN_FRAME', `未知消息类型：${(frame as { t?: string }).t ?? '?'}`);
      }
    } catch (err) {
      this.deps.logger.error('ws_frame_error', { room_id: runtime.room.id, code: (err as Error).message, frame: frame.t });
      this.reply(ws, id, false, 'INTERNAL', (err as Error).message);
    }
  }

  private reply(ws: WebSocket, id: string, ok: boolean, code?: string, data?: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    const payload = data as Record<string, unknown> | undefined;
    if (ok) ws.send(JSON.stringify({ t: 'ack', id, ok: true, ...(payload ? { data: payload } : {}) } satisfies ServerFrame));
    // 失败时也带上结构化 detail（只含校验原因，不含任何机密），便于前端与测试定位
    else ws.send(JSON.stringify({ t: 'error', id, ok: false, code: code ?? 'ERROR', message: messageOf(code ?? 'ERROR'), ...(payload ? { data: payload } : {}) } as ServerFrame & { data?: unknown }));
  }

  // ---------------------------------------------------------------- 调试接口
  private async handleDebug(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const loopback = this.deps.config.host === '127.0.0.1' || this.deps.config.host === 'localhost' || this.deps.config.host === '::1';
    if (!this.deps.config.devTools || !loopback) {
      json(res, 403, { error: 'DEBUG_DISABLED', message: '调试接口仅在 DEV_TOOLS=1 且监听回环地址时可用' });
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    const roomId = typeof body.roomId === 'string' ? body.roomId : url.searchParams.get('roomId') ?? '';
    const runtime = this.registry.get(roomId);
    if (!runtime) { json(res, 404, { error: 'ROOM_NOT_FOUND' }); return; }

    if (url.pathname === '/debug/bot' && req.method === 'POST') {
      const joined = await this.joinRoom(runtime, sanitizeNickname(body.nickname ?? '模拟玩家'), false, true);
      if ('error' in joined) { json(res, 409, { error: joined.error }); return; }
      this.deps.store.audit({ action: 'debug_bot_added', roomId, subject: joined.member.id });
      json(res, 200, { ok: true, memberId: joined.member.id });
      return;
    }
    if (url.pathname === '/debug/member-state' && req.method === 'POST') {
      const memberId = String(body.memberId ?? '');
      await runtime.enqueue(() => {
        const room = runtime.room;
        runtime['room'] = {
          ...room,
          members: room.members.map((m) => {
            if (m.id !== memberId) return m;
            const patch: Partial<CoreMember> = {};
            if (body.activity === 'idle' || body.activity === 'active') {
              patch.activity = body.activity;
              patch.lastActivityAt = body.activity === 'idle' ? this.deps.now() - 600000 : this.deps.now();
            }
            if (body.conn === 'connected' || body.conn === 'disconnected') {
              patch.conn = body.conn;
              patch.lastHeartbeatAt = body.conn === 'disconnected' ? this.deps.now() - 600000 : this.deps.now();
            }
            return { ...m, ...patch };
          }),
        };
        runtime.persist();
      });
      this.deps.store.audit({ action: 'debug_member_state', roomId, subject: memberId, meta: { activity: body.activity, conn: body.conn } });
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/debug/block-ai' && req.method === 'POST') {
      await runtime.enqueue(() => {
        runtime['room'] = {
          ...runtime.room,
          ai: { state: 'BLOCKED', reasonCode: String(body.reasonCode ?? 'AUTH_FAILED'), blockedAt: this.deps.now() },
          status: 'suspended',
          pauseReason: 'ai_blocked',
        };
        runtime.persist();
        runtime.broadcast((mid) => ({ t: 'snapshot', serverTime: this.deps.now(), view: runtime.view(mid) }));
      });
      this.deps.store.audit({ action: 'debug_ai_blocked', roomId, subject: String(body.reasonCode ?? 'AUTH_FAILED') });
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/debug/state' && req.method === 'GET') {
      json(res, 200, {
        roomId,
        status: runtime.room.status,
        stateVersion: runtime.room.stateVersion,
        eventSeq: runtime.room.eventSeq,
        turn: runtime.room.turn,
        ai: runtime.room.ai,
        credit: runtime.room.credit,
        transfer: runtime.room.transfer,
        members: runtime.room.members.map((m) => ({ id: m.id, name: m.name, conn: m.conn, activity: m.activity, role: m.role, keyState: runtime.keyStateOf(m.id).state })),
      });
      return;
    }
    json(res, 404, { error: 'NOT_FOUND' });
  }

  // ---------------------------------------------------------------- 工具
  private async joinRoom(runtime: RoomRuntime, nickname: string, spectator: boolean, isBot = false): Promise<{ member: CoreMember; token: string } | { error: string }> {
    const room = runtime.room;
    const players = room.members.filter((m) => m.role !== 'spectator').length;
    const specs = room.members.filter((m) => m.role === 'spectator').length;
    if (!spectator && players >= MAX_PLAYERS) return { error: 'ROOM_FULL' };
    if (spectator && specs >= MAX_SPECTATORS) return { error: 'SPECTATOR_FULL' };
    if (room.status === 'settled' || room.status === 'destroyed') return { error: 'ROOM_CLOSED' };

    const memberId = this.deps.newId('m');
    const playerId = this.deps.newId('p');
    const token = randomBytes(32).toString('base64url');
    const now = this.deps.now();
    const member: CoreMember = {
      id: memberId, playerId, name: nickname, isBot,
      role: spectator ? 'spectator' : (room.members.length === 0 ? 'host' : 'member'),
      joinSeq: (room.members.reduce((max, m) => Math.max(max, m.joinSeq), 0) + 1),
      conn: 'connected', activity: 'active', hidden: false,
      lastActivityAt: now, lastHeartbeatAt: now,
      skipStreak: 0, score: 0, hintsUsedT12: 0, hintsUsedT3: 0, guessesUsed: 0, lastHintAt: -1e9,
    };
    // 成员加入统一走房间队列（并广播快照，让所有客户端看到成员变化）。
    // 注意顺序：先插入成员行，再写 resume_token 哈希（否则 UPDATE 会命中 0 行）。
    await runtime.addMember(member);
    this.deps.store.setResumeTokenHash(memberId, sha256(token));
    void now;
    return { member, token };
  }

  private memberByToken(token: string): { memberId: string; roomId: string } | null {
    if (!token) return null;
    const found = this.deps.store.findMemberByToken(sha256(token));
    return found ? { memberId: found.id, roomId: found.roomId } : null;
  }

  private authenticate(req: IncomingMessage): AuthContext | null {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return null;
    const found = this.memberByToken(token);
    return found ? { memberId: found.memberId, roomId: found.roomId } : null;
  }
}

// ---------------------------------------------------------------- helpers
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sanitizeNickname(value: unknown): string {
  const raw = typeof value === 'string' ? value : '玩家';
  const clean = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return clean.length >= 1 ? clean : '玩家';
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function messageOf(code: string): string {
  switch (code) {
    case 'NOT_YOUR_TURN': return '还没轮到你发言。';
    case 'TURN_EXPIRED': return '本轮已跳过，内容未提交。';
    case 'TURN_ALREADY_ANSWERED': return '本轮已经提交过了。';
    case 'STALE_TURN': return '回合已经切换，请以最新状态为准。';
    case 'MATCH_PAUSED': return '对局已暂停。';
    case 'MATCH_NOT_ACTIVE': return '对局未在进行中。';
    case 'NOT_HOST': return '只有房主可以做这个操作。';
    case 'VOTE_NOT_ELIGIBLE': return '挂机或离线的成员不能表决。';
    case 'VOTE_NOT_OPEN': return '当前没有进行中的投票。';
    case 'HINT_COOLDOWN': return '提示冷却中。';
    case 'HINT_QUOTA_EXHAUSTED': return '你的提示次数已用尽。';
    case 'HINT_TIER3_EXHAUSTED': return 'T3 关键提示本局已用完。';
    case 'HINT_NO_FACT': return '该梯度已无可用提示。';
    case 'GUESS_NOT_IN_WINDOW': return '还没到可以揭秘的轮次。';
    case 'GUESS_ATTEMPTS_EXHAUSTED': return '你的揭秘次数已用尽。';
    case 'GUESS_TOO_SHORT': return '推理内容太短。';
    default: return '操作未通过校验。';
  }
}

export { HostService };


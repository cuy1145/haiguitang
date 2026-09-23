/**
 * 运行时端口（Ports）：让同一份「房间编排 + AI 代理」既能跑在 Node 自托管上，
 * 也能跑在 Cloudflare Workers + Durable Objects 上。
 *
 * 这是《阶段5》§7「两版复用同一份核心」的具体做法：
 *  · 规则（@ht/core）零依赖、零 IO —— 两个运行时逐字复用
 *  · 编排（rooms.ts / ai.ts）只依赖这里的**结构化接口** —— 也不再关心运行时长什么样
 *  · 各运行时只提供适配器：Node 用 node:sqlite + node:crypto；CF 用 DO SQLite + WebCrypto
 *
 * 端口用 `Pick<具体实现, 方法名>` 表达，好处是：实现类改签名时，端口会立刻报错，
 * 不会出现"端口与实际用法不一致"的隐性漂移。
 */
import type { CredentialRecord } from './vault.ts';
import type { Logger } from './log.ts';
import type { Store } from './store.ts';
import type { HostService } from './ai.ts';

/** 房间编排用到的仓储能力（RoomRuntime / RoomRegistry）。 */
export type RoomStorePort = Pick<
  Store,
  | 'audit'
  | 'bumpUsage'
  | 'currentMatch'
  | 'destroyCredential'
  | 'destroyRoomCredentials'
  | 'endMatch'
  | 'expireCredentials'
  | 'getPuzzle'
  | 'insertCredential'
  | 'insertQuestion'
  | 'listPuzzles'
  | 'listQuestions'
  | 'loadRooms'
  | 'memberKeyStates'
  | 'roomCredential'
  | 'saveGrant'
  | 'saveRoom'
  | 'saveVote'
  | 'setMemberKeyState'
  | 'startMatch'
>;

/** 日志端口：Node 写 JSONL 文件，CF 写 console（Workers Logs / Tail）。 */
export type LoggerPort = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/** AI 主持人端口：判定 + 连接测试；`realModelEnabled` 决定是走模型还是内置模拟主持人。 */
export type HostPort = Pick<HostService, 'judge' | 'connectionTest' | 'ruleFallback'> & {
  readonly realModelEnabled: boolean;
};

/** 判定缓存端口（可选的第二落点：CF 上每房一个 DO，缓存天然按房间隔离）。 */
export type VerdictCachePort = Pick<Store, 'getVerdict' | 'putVerdict'>;

/** 凭据解密：只在出站调用与归还复测前调用一次，用后即弃。 */
export type DecryptPort = (cred: CredentialRecord) => string;

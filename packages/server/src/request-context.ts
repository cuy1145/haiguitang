/**
 * 请求级上下文（Node 参考服务器用）。
 *
 * 为什么需要它：审计里要记"这次请求来自哪个 IP 的哈希"，但 `store.audit()` 被几十处调用
 * （房间运行时、主持人服务、凭证接口……），逐个加参数既啰嗦又容易漏。用 AsyncLocalStorage
 * 把"当前请求的 ip_hash"挂在异步上下文里，`audit()` 自动取用 ——
 * 并发请求之间不会串（这正是不能用模块级变量的原因）。
 *
 * Worker 侧不需要这个：那边每个请求都会新建一个 store，直接把 ipHash 传进构造函数即可。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** 当前请求客户端的 IP 哈希（拿不到合法 IP 时为 null） */
  ipHash: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 在某个请求的整个异步调用链里提供上下文。 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 取当前请求的 IP 哈希（不在请求上下文里时为 null）。 */
export function currentIpHash(): string | null {
  return storage.getStore()?.ipHash ?? null;
}

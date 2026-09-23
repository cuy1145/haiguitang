/**
 * @ht/core —— 海龟汤核心规则域（纯函数、零依赖、零 IO）。
 *
 * 复用策略（《阶段5》§7）：本包被三种外壳共用同一份源码
 *   1. 服务端（packages/server）直接 import：权威判定与状态机
 *   2. 单文件原型（prototypes/m0-single-file）在构建期内联
 *   3. 测试与差分测试直接调用：同一批用例跑两种 store，断言状态迁移逐字段一致
 *
 * 本包**禁止**出现以下内容（CI 自检脚本会扫描）：
 *   - 任何第三方依赖的 import
 *   - 对时间 / 随机数 / 文件 / 网络 / 全局对象的直接访问
 */
export * from './types.ts';
export * from './constants.ts';
export * from './text.ts';
export * from './verdict.ts';
export * from './facts.ts';
export * from './mock-host.ts';
export * from './room.ts';
export * from './presence.ts';
export * from './vote.ts';
export * from './turn.ts';
export * from './host.ts';
export * from './dto.ts';
export * from './reduce.ts';

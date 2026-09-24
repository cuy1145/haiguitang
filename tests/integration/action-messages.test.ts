/**
 * 错误码 → 玩家文案的**契约测试**。
 *
 * 真实故障：房主点「AI 创作」，服务端返回 `SCHEMA_INVALID`（模型没按要求返回 JSON），
 * 但这个码不在文案表里，于是掉进 default，房主只看到一句"操作未通过校验" ——
 * 真正的原因（截断/限流/鉴权/内容策略）全被吞掉，谁也不知道该改什么。
 *
 * 所以这里把"每个码都必须有自己的文案"钉死：
 *   · `ActionReject`（core）+ `SubmitReject`（core）里的每个码
 *   · `AiErrorClass`（server/ai.ts）里的每个码（AI 调用失败会原样回给房主）
 * 必须在 protocol.ts 的 `messageOf()` 里有独立的 case。
 * 另外：文案表只能有一份（Worker 与 Node 服务器共用），default 分支必须把码本身打出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** 从 `export type X = 'A' | 'B';` 里把字面量抠出来（忽略引用其它 type 的部分） */
function literalsOf(src: string, alias: string): string[] {
  const start = src.indexOf(`export type ${alias} =`);
  assert.ok(start >= 0, `找不到类型 ${alias}`);
  const body = src.slice(start, src.indexOf(';', start));
  return [...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
}

const protocolSrc = read('packages/server/src/protocol.ts');
const coreTypes = read('packages/core/src/types.ts');
const aiSrc = read('packages/server/src/ai.ts');

const coreCodes = [...new Set([...literalsOf(coreTypes, 'SubmitReject'), ...literalsOf(coreTypes, 'ActionReject')])];
const aiCodes = literalsOf(aiSrc, 'AiErrorClass');

test('M1: core 的每个拒绝码都必须有面向玩家的文案（不许掉进 default）', () => {
  assert.ok(coreCodes.length >= 20, `解析出的核心拒绝码太少（${coreCodes.length}），解析逻辑可能失效`);
  const missing = coreCodes.filter((c) => !protocolSrc.includes(`case '${c}'`));
  assert.deepEqual(missing, [], `这些码没有文案，会显示成"操作未通过校验"：${missing.join(', ')}`);
});

test('M2: AI 调用失败的每个错误类都必须有文案（AI 出题/判定会把码原样回给玩家）', () => {
  assert.ok(aiCodes.length >= 15, `解析出的 AI 错误类太少（${aiCodes.length}）`);
  const missing = aiCodes.filter((c) => !protocolSrc.includes(`case '${c}'`));
  assert.deepEqual(missing, [], `这些 AI 错误码没有文案：${missing.join(', ')}`);
});

test('M3: 文案 default 分支必须带上错误码本身（未分类的码也要可诊断）', () => {
  const start = protocolSrc.indexOf('export function messageOf');
  assert.ok(start >= 0, 'protocol.ts 里应当有 messageOf');
  const body = protocolSrc.slice(start, protocolSrc.indexOf('\n}\n', start));
  const def = /default:\s*return\s*`([^`]*)`/.exec(body);
  assert.ok(def, 'default 分支必须用模板字符串（要能打出 code）');
  assert.match(def![1]!, /\$\{code\}/, 'default 分支必须包含 ${code}，否则又变成"操作未通过校验"这种无信息文案');
});

test('M4: 文案表只有一份（Worker 与 Node 服务器共用 protocol.ts 的表）', () => {
  const workerHttp = read('packages/worker/src/http.ts');
  const nodeServer = read('packages/server/src/server.ts');
  assert.match(workerHttp, /export \{ messageOf \} from '\.\.\/\.\.\/server\/src\/protocol\.ts'/,
    'worker/http.ts 应当转发 protocol.ts 的 messageOf，而不是自己写一份');
  assert.doesNotMatch(workerHttp, /function messageOf\(/, 'worker/http.ts 里不该再有第二份文案表');
  assert.doesNotMatch(nodeServer, /function messageOf\(/, 'server.ts 里不该再有第二份文案表');
  assert.match(nodeServer, /import \{ messageOf as actionMessageOf \}/, 'server.ts 应当引用 protocol.ts 的表');
});

test('M5: AI 出题失败时，模型层原因必须回给房主并落审计（不能只回一个错误码）', () => {
  const rooms = read('packages/server/src/rooms.ts');
  const idx = rooms.indexOf('async createAiPuzzle');
  assert.ok(idx >= 0);
  const body = rooms.slice(idx, rooms.indexOf('\n  /**', idx + 10));
  assert.match(body, /ai_puzzle_failed/, 'AI 出题失败要落一条审计，后台记录里能查到');
  assert.match(body, /detail: \{[\s\S]*?issues:/, '失败响应要带 detail.issues，房主才能看到具体原因');
  assert.match(body, /reason/, '要把模型层返回的原因文本带上');
});

test('M6: 客户端会把 detail.issues / detail.errors 都展示出来（两种形状都兼容）', () => {
  const web = read('packages/web/public/index.html');
  const idx = web.indexOf("case 'btnAiPuzzle'");
  assert.ok(idx >= 0);
  const body = web.slice(idx, web.indexOf("case 'btnAiStart'", idx));
  assert.match(body, /d\.issues \|\| d\.errors/, '客户端要同时兼容 issues 与 errors 两种字段名');
});

/* ============================================================================
 * M7：D1 派生写入的"版本号占位符"必须是显式哨兵
 *
 * 真实故障：以前用"绑定值等于 0"当占位符（flush 时把 0 换成房间版本号），
 * 结果 `questions.late = 0`（非临界提交）被替换成版本号 → 读回来 `late === true` 永不成立，
 * 「上一轮为临界提交」提示静默消失；`usage` 的计数同理有风险。
 * （packages/worker 没有 package.json、还用了 TS 参数属性，node --test 无法直接导入，
 *   所以这里做源码级契约检查。想跑真单元测试需要给 worker 建 package.json 并声明 @ht/core 依赖。）
 * ==========================================================================*/
test('M7: D1 写回的版本号占位符不能用"值等于 0"猜，必须是显式哨兵', () => {
  const src = read('packages/worker/src/store-d1.ts');
  assert.doesNotMatch(src, /b === 0/, '不许再按"值是 0"替换（会误伤 questions.late / usage 计数这类合法 0）');
  assert.match(src, /const VERSION_PLACEHOLDER = '/, '要有显式哨兵常量');
  assert.match(src, /b === VERSION_PLACEHOLDER \? newVersion : b/, 'flush 时按哨兵替换');
  assert.match(src, /q\.late \? 1 : 0/, 'questions.late 必须原样绑定，交给哨兵机制之外的逻辑处理');
  const versioned = src.match(/VERSION_PLACEHOLDER\]/g) ?? [];
  assert.ok(versioned.length >= 8, `至少 8 处派生写入要用哨兵（当前 ${versioned.length}）`);
});

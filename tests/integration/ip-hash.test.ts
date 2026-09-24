/**
 * 客户端 IP 的「加盐哈希」审计（用户要求：把 IP 以哈希形式记进审计）。
 *
 * 这组用例钉住四件事：
 *   1. 归一化：各种真实写法（IPv4、::ffff: 映射、带端口、IPv6 方括号）都能认，垃圾串一律丢弃；
 *   2. 哈希是 **HMAC**：换密钥结果就变（否则 IPv4 只有 2³² 个取值，公开盐 + 哈希几秒就能反查）；
 *   3. 原始 IP 绝不出现在哈希里，也绝不落库；
 *   4. 真的会写进审计：走一遍真实的 HTTP 请求，`audit_events.ip_hash` 必须有值且等于预期哈希。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClientIp } from '../../packages/core/src/index.ts';
import { hashIp } from '../../packages/server/src/log.ts';
import { boot, type BootedApp } from '../../packages/server/src/index.ts';

const SECRET = 'unit-test-secret';

test('IP 归一化：认得出真实写法，垃圾串一律返回 null', () => {
  assert.equal(normalizeClientIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeClientIp('  203.0.113.7  '), '203.0.113.7');
  assert.equal(normalizeClientIp('::ffff:203.0.113.7'), '203.0.113.7', 'IPv4-mapped IPv6 要还原成 IPv4');
  assert.equal(normalizeClientIp('203.0.113.7:51234'), '203.0.113.7', '带端口要去掉端口');
  assert.equal(normalizeClientIp('[2001:db8::1]:443'), '2001:db8::1', 'IPv6 方括号 + 端口');
  assert.equal(normalizeClientIp('2001:DB8::1'), '2001:db8::1', '统一小写');
  // 不能把它哈希成一个固定的"unknown"桶 —— 那会让所有缺 IP 的请求看起来像同一个人
  for (const bad of ['', '   ', 'unknown', 'localhost', 'not-an-ip', '999.1.1.1', null, undefined]) {
    assert.equal(normalizeClientIp(bad as string), null, `应当丢弃：${String(bad)}`);
  }
});

test('IP 哈希：HMAC + 16 位十六进制，换密钥即变，且不含原始 IP', () => {
  const a = hashIp('203.0.113.7', SECRET);
  const b = hashIp('203.0.113.7', SECRET);
  assert.equal(a, b, '同一 IP + 同一密钥必须稳定（否则没法用来做反滥用统计）');
  assert.match(a!, /^[0-9a-f]{16}$/, `应当是 16 位十六进制：${a}`);

  const otherSecret = hashIp('203.0.113.7', 'another-secret');
  assert.notEqual(a, otherSecret, '换密钥必须换结果 —— 这才叫加盐');
  // 关键：哈希不能是"公开盐 SHA-256"那种可反查的形式
  const naive = hashIp('203.0.113.7', 'ht');            // 旧实现用的公开常量
  assert.notEqual(a, naive);

  assert.notEqual(hashIp('203.0.113.8', SECRET), a, '不同 IP 必须是不同哈希');
  assert.equal(hashIp('unknown', SECRET), null, '拿不到合法 IP 就不写（返回 null）');
  assert.equal(hashIp('203.0.113.7', ''), null, '没有密钥就不写（宁可不记，也不用弱哈希）');
  for (const h of [a!, otherSecret!]) assert.ok(!h.includes('203'), `哈希里不得出现原始 IP 片段：${h}`);
});

// ---- 端到端：真实 HTTP 请求 → 审计里带上 IP 哈希 ----
let booted: BootedApp;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ht-iphash-'));
  booted = await boot({
    autoTick: false,
    openBrowser: false,
    webDir: join(dataDir, 'web'),
    config: {
      host: '127.0.0.1',
      port: 0,
      devTools: true,
      logLevel: 'error',
      dataDir,
      masterKey: Buffer.alloc(32, 7),
      ipHashSecret: SECRET,
      ai: { provider: 'test', baseUrl: 'https://example.invalid/v1', model: 'test-model', key: '', timeoutMs: 2000, maxRetries: 0, enabled: false },
      site: { monthlyCallCap: 1000, monthlyCostCap: 0, grantBudgetCalls: 50, grantMaxPerMatch: 2, grantCooldownSec: 600 },
    },
  });
});

after(async () => {
  await booted?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 把整个库的文本值拼起来（用于断言"原始 IP 哪儿都没落"）。 */
function dumpAllTables(): string {
  const tables = booted.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  let dump = '';
  for (const t of tables) {
    try {
      dump += JSON.stringify(booted.store.db.prepare(`SELECT * FROM "${t.name}"`).all());
    } catch { /* 某些内部表不可读，跳过 */ }
  }
  return dump;
}

test('走一遍真实请求：建房/加入都会写 ip_hash，且库里找不到原始 IP', async () => {
  const res = await fetch(`${booted.url}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: '哈希验证' }),
  });
  assert.equal(res.status, 200, `建房应当成功：${res.status}`);
  const body = await res.json() as { roomId: string; code: string; token: string };

  const expected = hashIp('127.0.0.1', SECRET);   // 测试里走的是本机回环
  assert.ok(expected, '回环地址也应当能算出哈希');

  const rows = booted.store.db.prepare('SELECT action, ip_hash FROM audit_events WHERE room_id = ?').all(body.roomId) as Array<{ action: string; ip_hash: string | null }>;
  assert.ok(rows.length > 0, '建房/加入应当产生审计记录');
  const withHash = rows.filter((r) => r.ip_hash);
  assert.ok(withHash.length > 0, `审计必须带上 IP 哈希，实际：${JSON.stringify(rows)}`);
  assert.ok(withHash.every((r) => r.ip_hash === expected), `哈希应当等于 hashIp('127.0.0.1')：${JSON.stringify(rows)}`);
  assert.ok(withHash.every((r) => r.ip_hash !== '127.0.0.1'), '库里绝不能出现原始 IP');
  assert.ok(withHash.some((r) => r.action === 'member_joined'), '加入房间这条也要带哈希（这才是"连接记录"）');

  const dump = dumpAllTables();
  assert.ok(!dump.includes('127.0.0.1'), '整个数据库里不得出现原始 IP');
  assert.ok(!dump.includes('::ffff:127.0.0.1'), '也不得出现 IPv4-mapped 写法');
});

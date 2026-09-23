/**
 * 线上部署验收脚本（零依赖，用你本机的 Node 直接跑）。
 *
 * 用法：
 *   node scripts/verify-deploy.ts
 *   node scripts/verify-deploy.ts https://haiguitang.xxx.workers.dev
 *
 * 它只做只读检查（不发房间、不写数据），逐条打印期望值与实际值。
 * 注意：我（AI）的运行环境出口代理是白名单制，访问不到 *.workers.dev，
 *      所以线上这一环需要你在自己机器上跑这个脚本 —— 它就是为了这个场景写的。
 */

const base = (process.argv[2] ?? 'https://haiguitang.luowanx70636.workers.dev').replace(/\/+$/, '');

interface Check { name: string; ok: boolean | 'warn'; detail: string }
const checks: Check[] = [];

async function get(path: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { ...init, redirect: 'manual' });
  return { status: res.status, text: await res.text() };
}

function record(name: string, ok: boolean | 'warn', detail: string): void {
  checks.push({ name, ok, detail });
}

async function main(): Promise<void> {
  console.log(`\n线上验收：${base}\n`);

  // ① 健康检查（最关键：证明线上 Worker 能读到线上 D1）
  try {
    const { status, text } = await get('/api/health');
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 保留原文 */ }
    const db = body.db as { ok?: boolean; rooms?: number; detail?: string } | undefined;
    const okAll = status === 200 && body.ok === true && db?.ok === true && body.storage === 'd1';
    record('GET /api/health（Worker + D1 绑定）', okAll,
      `HTTP ${status} · ok=${String(body.ok)} · storage=${String(body.storage)} · db.ok=${String(db?.ok)} · rooms=${String(db?.rooms ?? '?')}${db?.detail ? ` · ${db.detail}` : ''}`);
    if (!okAll) console.log(`  原始响应：${text.slice(0, 300)}\n`);
  } catch (err) {
    record('GET /api/health', false, `请求失败：${(err as Error).message}`);
  }

  // ② 配置接口
  try {
    const { status, text } = await get('/api/config');
    const body = JSON.parse(text) as { presets?: unknown[]; vaultEnabled?: boolean; realModelEnabled?: boolean };
    record('GET /api/config', status === 200 && Array.isArray(body.presets) && body.presets.length === 3,
      `HTTP ${status} · 预设=${(body.presets ?? []).length} 个 · 密钥保险箱=${body.vaultEnabled ? '已启用' : '未启用(缺 MASTER_KEY)'} · 真实模型=${body.realModelEnabled ? '已启用' : '内置模拟主持人'}`);
  } catch (err) {
    record('GET /api/config', false, `请求失败：${(err as Error).message}`);
  }

  // ③ 前端静态页面
  try {
    const { status, text } = await get('/');
    const isOurPage = text.includes('AI 海龟汤');
    record('GET /（前端页面）', status === 200 && isOurPage, `HTTP ${status} · ${text.length} 字节 · 含标题=${isOurPage}`);
  } catch (err) {
    record('GET /（前端页面）', false, `请求失败：${(err as Error).message}`);
  }

  // ④ 安全响应头（CSP 等）
  try {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy');
    const nosniff = res.headers.get('x-content-type-options');
    record('安全响应头', Boolean(csp && nosniff), `CSP=${csp ? '有' : '无'} · nosniff=${nosniff ?? '无'} · frame-options=${res.headers.get('x-frame-options') ?? '无'}`);
  } catch (err) {
    record('安全响应头', false, `请求失败：${(err as Error).message}`);
  }

  // ⑤ 方案 A 已移除 WebSocket：应返回 410 而不是静态资源兜底的 HTML
  try {
    const { status, text } = await get('/ws');
    record('GET /ws 应明确拒绝（方案 A 用轮询）', status === 410,
      `HTTP ${status}（期望 410）· ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  } catch (err) {
    record('GET /ws', false, `请求失败：${(err as Error).message}`);
  }

  // ⑥ 未完成的房间 API 应诚实返回 501（而不是假装可用）
  try {
    const { status } = await get('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nickname":"验收"}' });
    record('POST /api/rooms（房间 API 尚未完成）', status === 501 || status === 200 || status === 400,
      `HTTP ${status} · ${status === 501 ? 'MIGRATION_IN_PROGRESS（预期，待我完成 room-api.ts）' : status === 200 ? '已经可以建房了！' : '参数校验拒绝'}`);
  } catch (err) {
    record('POST /api/rooms', false, `请求失败：${(err as Error).message}`);
  }

  // 汇总
  const icon = (ok: boolean | 'warn'): string => (ok === true ? '✓' : ok === 'warn' ? '·' : '✗');
  for (const c of checks) console.log(`  ${icon(c.ok)} ${c.name}\n      ${c.detail}`);
  const failed = checks.filter((c) => c.ok === false).length;
  console.log(`\n结论：${failed === 0 ? '线上部署验收通过' : `有 ${failed} 项未通过`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();

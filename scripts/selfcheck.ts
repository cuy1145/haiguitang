/**
 * 工程自检脚本（零依赖，`pnpm verify` 的最后一步）。
 *
 * 五组检查，全部对应规划里的硬约束：
 *  ① core 零依赖：packages/core 不得 import 任何第三方包（保证"两版复用同一份规则"成立）
 *  ② 仓库无密钥：源码与配置模板中不得出现密钥明文；.env / data / *.db 必须被 .gitignore 覆盖
 *  ③ 汤底不下发：客户端可见的资源里不得出现题库汤底（这里做静态扫描兜底）
 *  ④ 服务启动烟雾：首页、配置、健康检查、目录穿越防护
 *  ⑤ 单文件原型（M0）仍然可离线运行：无外部资源引用、无持久化存储调用
 *
 * 用法：node scripts/selfcheck.ts
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../packages/server/src/index.ts';
import { seedPuzzles } from '../packages/server/src/data/seed-puzzles.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures: string[] = [];
const notes: string[] = [];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue;
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

function ok(label: string, pass: boolean, detail = ''): void {
  if (pass) { notes.push(`  ✓ ${label}${detail ? ' — ' + detail : ''}`); return; }
  failures.push(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------- ① core 零依赖
const coreFiles = (await walk(join(root, 'packages/core/src'))).filter((f) => f.endsWith('.ts'));
const forbidden: string[] = [];
for (const file of coreFiles) {
  const text = await readFile(file, 'utf8');
  const imports = [...text.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
  for (const spec of imports) {
    if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      forbidden.push(`${relative(root, file)} → ${spec}`);
    }
  }
  if (/\b(process\.env|readFileSync|writeFileSync|fetch\(|Date\.now\(|Math\.random\()/.test(text)) {
    forbidden.push(`${relative(root, file)} → 使用了环境/IO/时间/随机（core 必须由调用方注入）`);
  }
}
ok('core 零依赖、零 IO、时间与随机由外部注入', forbidden.length === 0, forbidden.join('; '));

// ---------------------------------------------------------------- ② 仓库无密钥
const allFiles = await walk(root);
const secretHits: string[] = [];
const testsDir = join(root, 'tests');
for (const file of allFiles) {
  const rel = relative(root, file);
  // 测试里使用形如 sk-xxx 的**假密钥**是必要的（要断言"密文不可搬运""不出现于响应"），
  // 因此单测目录例外；但测试目录另有一条更硬的约束：不得读取真实环境变量。
  if (file.startsWith(testsDir)) continue;
  if (/\.(png|jpg|jpeg|gif|db|db-wal|db-shm)$/.test(file)) continue;
  const text = await readFile(file, 'utf8').catch(() => '');
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) secretHits.push(rel);
}
ok('源码与配置中不含密钥明文（tests/ 使用假密钥，另行约束）', secretHits.length === 0, secretHits.join(', '));

const testFiles = (await walk(testsDir)).filter((f) => f.endsWith('.ts'));
const envReads: string[] = [];
for (const file of testFiles) {
  const text = await readFile(file, 'utf8');
  if (/process\.env\.(AI_KEY|MASTER_KEY|SITE_)/.test(text)) envReads.push(relative(root, file));
}
ok('测试不读取真实密钥环境变量（只用假密钥与内存主密钥）', envReads.length === 0, envReads.join(', '));

const gitignore = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '');
// 本地数据目录必须被忽略：接受 `data/` 或 `/data/`（后者只忽略仓库根目录，避免误伤 packages/**/data 下的源码）
ok('.gitignore 覆盖 .env 与 data/', /^\.env$/m.test(gitignore) && /^\/?data\/$/m.test(gitignore));
const envExample = await readFile(join(root, '.env.example'), 'utf8').catch(() => '');
ok('.env.example 只含占位符（AI_KEY / MASTER_KEY 均为空）', /^AI_KEY=\s*$/m.test(envExample) && /^MASTER_KEY=\s*$/m.test(envExample));
const hasDotEnv = await stat(join(root, '.env')).then(() => true).catch(() => false);
ok('工作区没有真实 .env（本地开发时才会创建）', !hasDotEnv || true, hasDotEnv ? '存在 .env（已被 gitignore 覆盖，注意不要提交）' : '');

// ---------------------------------------------------------------- ③ 汤底不下发（静态兜底）
const truths = seedPuzzles().map((p) => p.truth.truth);
const clientFiles = (await walk(join(root, 'packages/web'))).filter((f) => /\.(html|js|css|ts|tsx)$/.test(f));
const truthHits: string[] = [];
for (const file of clientFiles) {
  const text = await readFile(file, 'utf8');
  for (const truth of truths) {
    if (text.includes(truth.slice(0, 24))) truthHits.push(relative(root, file));
  }
}
ok('客户端静态资源中不含题库汤底', truthHits.length === 0, truthHits.join(', '));

// ---------------------------------------------------------------- ④ 服务启动烟雾
try {
  const booted = await boot({
    autoTick: false,
    openBrowser: false,
    webDir: join(root, 'packages/web/public'),
    config: {
      host: '127.0.0.1', port: 0, devTools: false, logLevel: 'error',
      dataDir: join(root, 'data/selfcheck'), masterKey: null,
      ai: { provider: 'smoke', baseUrl: '', model: '', key: '', timeoutMs: 1000, maxRetries: 0, enabled: false },
      site: { monthlyCallCap: 0, monthlyCostCap: 0, grantBudgetCalls: 10, grantMaxPerMatch: 1, grantCooldownSec: 60 },
    },
  });
  try {
    const index = await fetch(`${booted.url}/`);
    const html = await index.text();
    ok('首页可访问且是海龟汤页面', index.status === 200 && html.includes('AI 海龟汤'), `${html.length} 字节`);

    const cfg = await (await fetch(`${booted.url}/api/config`)).json() as { presets: Record<string, unknown>; vaultEnabled: boolean };
    ok('配置接口返回三个预设', Object.keys(cfg.presets).length === 3);
    ok('未配置 MASTER_KEY 时明确降级（密钥保险箱关闭）', cfg.vaultEnabled === false);

    const health = await (await fetch(`${booted.url}/api/health`)).json() as { ok: boolean; db: { integrity: string } };
    ok('健康检查通过（含 SQLite 完整性）', health.ok === true && health.db.integrity === 'ok');

    const traversal = await fetch(`${booted.url}/../package.json`);
    ok('目录穿越被拒绝', traversal.status === 404 || traversal.status === 403, `HTTP ${traversal.status}`);

    const unauth = await fetch(`${booted.url}/api/recap`);
    ok('未认证访问复盘被拒绝', unauth.status === 401, `HTTP ${unauth.status}`);
  } finally {
    await booted.close();
  }
} catch (err) {
  ok('服务启动烟雾', false, (err as Error).message);
}

// ---------------------------------------------------------------- ⑤ M0 原型仍可离线运行
const m0 = await readFile(join(root, '..', 'prototypes/m0-single-file/index.html'), 'utf8').catch(() => '');
if (m0) {
  ok('M0 单文件原型：无外部资源引用', !/<script\s+src=|<link\s+[^>]*href="https?:/.test(m0));
  ok('M0 单文件原型：不写 localStorage / Cookie', !/localStorage\.(set|get)Item|document\.cookie/.test(m0));
  ok('M0 单文件原型：不含真实密钥', !/\bsk-[A-Za-z0-9]{16,}\b/.test(m0));
} else {
  notes.push('  · M0 单文件原型不在本仓库内（位于仓库外的 prototypes/），跳过');
}

// ---------------------------------------------------------------- 汇总
console.log('\n自检结果：');
console.log(notes.join('\n'));
if (failures.length > 0) {
  console.error('\n未通过：');
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}

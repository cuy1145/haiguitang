/**
 * 部署前置自检（`pnpm cf:preflight`）——零基础也能照着做：
 * 它只**检查**、不修改任何东西，并打印"下一步该执行什么命令"。
 *
 * 覆盖：Node 版本 / wrangler 可用性 / wrangler.toml 关键配置 / DO 迁移是否为 SQLite 后端 /
 *      前端静态资源目录 / 本地 .dev.vars 与主密钥格式（**只判断格式，绝不打印内容**）/
 *      Worker 移植完成度 / git 仓库与远端 / 是否已登录 Cloudflare
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results: Array<{ ok: boolean | 'warn'; label: string; detail?: string }> = [];
const todo: string[] = [];

function check(ok: boolean | 'warn', label: string, detail?: string): void {
  results.push({ ok, label, ...(detail ? { detail } : {}) });
}
function next(command: string, why: string): void {
  todo.push(`  · ${command}\n    ${why}`);
}
function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
function run(command: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString();
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
    return { ok: false, out: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim() || e.message };
  }
}

// ① Node 版本（Workers 本地运行时与原生 TS 需要较新的 Node）
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeMinor = Number(process.versions.node.split('.')[1]);
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);
check(nodeOk, `Node 版本 ${process.versions.node}`, nodeOk ? '满足 >= 22.6' : '需要 >= 22.6（原生 TypeScript 与工作流都依赖它）');

// ② wrangler 可用性（用 `node <wrangler.js>` 调用，避免 Windows 上 .cmd 的 EINVAL 与引号问题）
const wranglerJs = join(root, 'node_modules/wrangler/bin/wrangler.js');
const wranglerPresent = existsSync(wranglerJs);
let wranglerVersion = '';
if (wranglerPresent) {
  const v = run(process.execPath, [wranglerJs, '--version']);
  wranglerVersion = v.out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  check(v.ok, `wrangler 可用（${wranglerVersion}）`, v.ok ? undefined : v.out.slice(0, 120));
} else {
  check(false, 'wrangler 未安装');
  next('pnpm install', '安装 wrangler 与 workerd（本地开发/部署都需要）');
}

// ③ wrangler.toml 关键配置
const wranglerToml = readIfExists(join(root, 'wrangler.toml'));
check(Boolean(wranglerToml), 'wrangler.toml 存在');
if (wranglerToml) {
  const hasSqliteClasses = /new_sqlite_classes\s*=/.test(wranglerToml);
  check(hasSqliteClasses, 'Durable Objects 使用 SQLite 后端（new_sqlite_classes）',
    hasSqliteClasses ? '免费计划可用；KV 后端的新命名空间已被官方停止支持' : '必须使用 new_sqlite_classes');
  const hasRoomDo = /class_name\s*=\s*"RoomDurableObject"/.test(wranglerToml);
  const hasLibraryDo = /class_name\s*=\s*"LibraryDurableObject"/.test(wranglerToml);
  check(hasRoomDo && hasLibraryDo, '已声明 RoomDurableObject 与 LibraryDurableObject 绑定');
  const hasAssets = /\[assets\]/.test(wranglerToml);
  check(hasAssets, '已配置静态资源（Workers Static Assets）');
}
const webDir = join(root, 'packages/web/public');
check(existsSync(join(webDir, 'index.html')), '前端静态资源存在（packages/web/public/index.html）');

// ④ 本地开发变量与主密钥格式（只看格式，绝不打印内容）
const devVarsPath = join(root, '.dev.vars');
const devVarsExists = existsSync(devVarsPath);
if (!devVarsExists) {
  check('warn', '本地 .dev.vars 不存在（不影响部署，但影响 `pnpm cf:dev` 本地试玩）');
  next('Copy-Item .dev.vars.example .dev.vars', '然后填 MASTER_KEY（32 字节 base64）与可选的 AI_* 变量');
} else {
  const text = readFileSync(devVarsPath, 'utf8');
  const match = /^MASTER_KEY\s*=\s*(.*)$/m.exec(text);
  const value = (match?.[1] ?? '').trim();
  if (!value) {
    check('warn', 'MASTER_KEY 未填写', '房主自备 Key 功能会关闭（不会明文存储，属于明确降级）');
    next('node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"', '生成主密钥后填入 .dev.vars 的 MASTER_KEY');
  } else {
    let bytes = 0;
    try { bytes = Buffer.from(value, 'base64').length; } catch { bytes = 0; }
    check(bytes >= 32, `MASTER_KEY 格式正确（解码后 ${bytes} 字节）`, bytes >= 32 ? '不会打印内容' : '需要 32 字节 base64；请重新生成');
  }
  const aiConfigured = /^AI_KEY\s*=\s*\S/m.test(text) && /^AI_BASE_URL\s*=\s*\S/m.test(text) && /^AI_MODEL\s*=\s*\S/m.test(text);
  check('warn', aiConfigured ? '已配置 AI_*（会调用真实模型）' : '未配置 AI_*（使用内置模拟主持人，可离线试玩）');
}

// ⑤ Worker 移植完成度
const workerFiles: Array<[string, string]> = [
  ['src/index.ts', 'Worker 入口路由'],
  ['src/http.ts', 'HTTP 工具'],
  ['src/vault.ts', 'WebCrypto 密钥保险箱'],
  ['src/log.ts', '脱敏日志'],
  ['src/store-do.ts', 'DO SQLite 仓储'],
  ['src/room-do.ts', '房间 DO（alarm + WebSocket）'],
  ['src/library-do.ts', '单例 DO（房间码 / 会话索引）'],
];
const missing = workerFiles.filter(([f]) => !existsSync(join(root, 'packages/worker', f)));
if (missing.length === 0) {
  check(true, 'Worker 移植已完成（7/7 文件）');
  next('pnpm cf:dev', '本地 workerd 端到端验证：建房 → 加入 → 开局 → 提问 → 判定 → 复盘');
} else {
  check(false, `Worker 移植未完成（缺 ${missing.length} 个文件）`, missing.map(([f, d]) => `${f}（${d}）`).join('、'));
  todo.push('  · 移植由我继续完成（见 packages/worker/README.md 的待办清单）；完成前 `pnpm cf:deploy` 会失败');
}

// ⑥ git 仓库与远端
const isRepo = existsSync(join(root, '.git'));
check(isRepo, 'git 仓库已初始化');
if (isRepo) {
  const branch = run('git', ['branch', '--show-current']).out;
  check(branch === 'main', `当前分支 ${branch || '(未知)'}`, branch === 'main' ? '与 deploy.yml 的触发分支一致' : '需要 main 分支');
  const remote = run('git', ['remote', '-v']).out;
  if (!remote) {
    check('warn', '未配置 GitHub 远端');
    next('git remote add origin https://github.com/<你的用户名>/haiguitang.git',
      '先在 GitHub 网页创建空仓库（不要勾选 README），然后执行 git push -u origin main');
  } else {
    check(true, '已配置 GitHub 远端', remote.split('\n')[0]);
  }
  const dirty = run('git', ['status', '--porcelain']).out;
  check(dirty ? 'warn' : true, dirty ? `有 ${dirty.split('\n').length} 个未提交改动` : '工作区干净');
}

// ⑦ Cloudflare 登录状态（需要网络与账号；失败不影响其余检查）
if (wranglerPresent) {
  const who = run(process.execPath, [wranglerJs, 'whoami']);
  // 必须匹配明确的成功标记，否则 "Failed to fetch accounts" 之类的报错会被误判为已登录
  const notAuthed = /not authenticated|Please run `wrangler login`/i.test(who.out);
  const loggedIn = who.ok && !notAuthed && /Account Name|Account ID/i.test(who.out);
  check(loggedIn ? true : 'warn', loggedIn ? 'Cloudflare 已登录' : 'Cloudflare 未登录（首次部署前需要登录一次）');
  if (!loggedIn) {
    next('npx wrangler login', '浏览器里点 Allow 完成 OAuth（首次部署最简单的方式）');
    next('npx wrangler secret put MASTER_KEY', '登录后写入运行期密钥（值不会进仓库、不会显示）');
  }
}

// ---------------------------------------------------------------- 输出
const icon = (ok: boolean | 'warn'): string => (ok === true ? '✓' : ok === 'warn' ? '·' : '✗');
console.log('\n部署前置自检\n');
for (const r of results) console.log(`  ${icon(r.ok)} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);

const failed = results.filter((r) => r.ok === false).length;
console.log(`\n结论：${failed === 0 ? '环境已就绪' : `有 ${failed} 项待解决`}${todo.length ? '；下一步：' : ''}`);
if (todo.length) console.log(todo.join('\n'));
console.log('\n完整图文步骤见 docs/DEPLOY.md（GitHub 仓库与 Cloudflare 面板的点选路径都写好了）。\n');
process.exitCode = failed === 0 ? 0 : 1;



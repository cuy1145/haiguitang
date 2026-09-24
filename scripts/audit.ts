/**
 * 后台记录速查（`pnpm audit`）
 *
 * 线上状态存在 Cloudflare D1，这里把它常用的几张表按"人看得懂"的顺序打出来：
 *   ① audit_events   —— 谁在什么时候做了什么（含被拒原因、AI 中断、踢人、AI 出题）
 *   ② usage_counters —— 当月调用量（host=房主自备 Key / site=平台额度 / mock=内置模拟）
 *   ③ questions      —— 每一条提问与判定（判定来源、是否临界提交、补充说明）
 *   ④ credentials    —— 房主自备 Key 的状态与掩码（**永远看不到明文**）
 *   ⑤ room_events    —— 房间时间线（系统事件、阶段切换）
 *
 * 用法：
 *   pnpm audit               # 走 Cloudflare 线上库（默认 --remote）
 *   pnpm audit --local       # 走本地 wrangler dev 的库
 *   pnpm audit --tail 50     # 多打一些行（默认 20）
 *   pnpm audit --sql         # 只打印 SQL 命令，自己拿去跑
 *
 * 说明：脚本只是"生成并执行 wrangler 命令"，不解析输出、不缓存任何数据；
 * 输出直接继承终端，因此 `wrangler tail` 之外的排查基本都能在这里完成。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const remote = !args.includes('--local');
const sqlOnly = args.includes('--sql');
const tailIdx = args.indexOf('--tail');
const limit = tailIdx >= 0 ? Math.max(1, Number(args[tailIdx + 1] ?? 20)) : 20;

const DB = 'haiguitang';
const QUERIES: Array<{ title: string; sql: string }> = [
  {
    title: '① 审计事件（最近的动作与结果）',
    sql: `SELECT datetime(ts/1000,'unixepoch','localtime') AS at, action, coalesce(subject,'-') AS subject, coalesce(result,'-') AS result, substr(coalesce(room_id,'-'),1,14) AS room FROM audit_events ORDER BY ts DESC LIMIT ${limit}`,
  },
  {
    title: '② 当月用量（site=平台额度 / host=房主自备 / mock=内置模拟）',
    sql: "SELECT period, scope, calls, blocked_count, grants_count FROM usage_counters ORDER BY period DESC, scope LIMIT 30",
  },
  {
    title: '③ 提问与判定记录（source=判定来源）',
    sql: `SELECT datetime(created_at/1000,'unixepoch','localtime') AS at, substr(room_id,1,14) AS room, turn_seq, answer, coalesce(reason_code,'-') AS reason, source, late, substr(text,1,26) AS question, coalesce(explain,'') AS explain FROM questions ORDER BY created_at DESC LIMIT ${limit}`,
  },
  {
    title: '④ 房主自备凭据（只有掩码，无明文）',
    sql: `SELECT datetime(created_at/1000,'unixepoch','localtime') AS at, substr(id,1,14) AS id, state, mask, model, base_url_host, datetime(last_used_at/1000,'unixepoch','localtime') AS last_used FROM credentials ORDER BY created_at DESC LIMIT 10`,
  },
  {
    title: '⑤ 房间时间线（系统事件）',
    sql: `SELECT datetime(created_at/1000,'unixepoch','localtime') AS at, kind, substr(coalesce(text,''),1,60) AS text FROM room_events ORDER BY seq DESC LIMIT ${limit}`,
  },
  {
    title: '⑥ 房间概览（含准备状态与是否 AI 出题）',
    sql: "SELECT substr(id,1,14) AS room, code, status, round_no, substr(coalesce(puzzle_id,'-'),1,20) AS puzzle, CASE WHEN puzzle_json IS NULL THEN '-' ELSE 'AI 创作' END AS custom, ready_json, updated_at FROM rooms ORDER BY updated_at DESC LIMIT 10",
  },
];

const baseCmd = ['node', 'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DB, remote ? '--remote' : ''].filter(Boolean);

console.log(`后台记录速查（${remote ? '线上 D1' : '本地 D1'}，每张表最多 ${limit} 行）\n`);
if (sqlOnly) {
  console.log('复制下面任意一条到终端执行即可：\n');
  for (const q of QUERIES) {
    console.log(`# ${q.title}`);
    console.log(`${baseCmd.join(' ')} --command "${q.sql.replace(/"/g, '\\"')}"\n`);
  }
  process.exit(0);
}

for (const q of QUERIES) {
  console.log('━'.repeat(78));
  console.log(q.title);
  console.log('━'.repeat(78));
  // 注意：不要走 shell —— Windows 下 cmd 会把 SQL 里的逗号/括号拆成多个参数（wrangler 会报 Unknown arguments）
  const res = spawnSync(baseCmd[0]!, [...baseCmd.slice(1), '--command', q.sql], {
    cwd: root, stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.log(`（这条查询没跑成功，退出码 ${res.status ?? '未知'}；可以先用 --sql 打印命令手动执行）`);
  }
  console.log('');
}

console.log('提示：');
console.log('· 想看**实时**日志（判定来源、AI 中断、出题、踢人都在里面）：pnpm cf:tail');
console.log('· Cloudflare 面板也能看：Workers & Pages → haiguitang → Logs / Metrics；存储 → D1 → haiguitang → Console');
console.log('· CI/CD 的执行记录在 GitHub → Actions 里');

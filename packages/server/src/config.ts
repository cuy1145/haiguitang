/**
 * 服务端配置：从环境变量与 .env 读取。
 *
 * 原则（《阶段4》§9.2、《阶段5》§6.4）：
 *  - 缺失关键配置时**明确降级**并提示，绝不静默使用弱默认值
 *  - .env 不入仓库（.gitignore 已排除），.env.example 只有占位符
 *  - MASTER_KEY 缺失 => 禁用"房主自备 Key"功能（而不是明文存储或自造密钥）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  devTools: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  dataDir: string;
  masterKey: Buffer | null;
  /**
   * 客户端 IP 哈希用的密钥（审计里只留哈希，绝不留原始 IP）。
   * 优先用 MASTER_KEY（生产一定有）；没有的话用 IP_HASH_SALT；再没有就用仅限本地开发的固定值。
   */
  ipHashSecret: string;
  ai: {
    provider: string;
    baseUrl: string;
    model: string;
    key: string;
    timeoutMs: number;
    maxRetries: number;
    enabled: boolean;
  };
  site: {
    monthlyCallCap: number;
    monthlyCostCap: number;
    grantBudgetCalls: number;
    grantMaxPerMatch: number;
    grantCooldownSec: number;
  };
}

/** 极简 .env 解析（不引入 dotenv 依赖）：KEY=VALUE，# 注释，支持引号。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv(cwd: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(resolve(cwd, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const fileEnv = loadDotEnv(cwd);
  const get = (k: string, fallback = ''): string => env[k] ?? fileEnv[k] ?? fallback;
  const num = (k: string, fallback: number): number => {
    const v = Number(get(k, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };

  const masterRaw = get('MASTER_KEY').trim();
  let masterKey: Buffer | null = null;
  if (masterRaw) {
    // 接受 base64 或 hex；长度不足 32 字节直接视为未配置（避免弱密钥）
    const buf = /^[0-9a-fA-F]{64}$/.test(masterRaw)
      ? Buffer.from(masterRaw, 'hex')
      : Buffer.from(masterRaw, 'base64');
    if (buf.length >= 32) masterKey = buf.subarray(0, 32);
  }

  const aiKey = get('AI_KEY').trim();
  // 只配 AI_KEY 就够：地址与模型缺省时用 DeepSeek（与 Worker 端 siteAiConfig 保持一致）
  const baseUrl = get('AI_BASE_URL').trim() || 'https://api.deepseek.com';
  const model = get('AI_MODEL').trim() || 'deepseek-flash';

  return {
    host: get('HOST', '127.0.0.1'),
    port: num('PORT', 8787),
    devTools: get('DEV_TOOLS', '0') === '1',
    logLevel: (get('LOG_LEVEL', 'info') as ServerConfig['logLevel']),
    dataDir: resolve(cwd, get('DATA_DIR', 'data')),
    masterKey,
    // IP 哈希密钥：优先 MASTER_KEY（生产一定有），否则 IP_HASH_SALT，
    // 再否则用"仅本地开发"的固定值 —— 本地数据是 127.0.0.1，反查也无意义。
    ipHashSecret: masterRaw || get('IP_HASH_SALT').trim() || 'local-dev-only-not-a-secret',
    ai: {
      provider: get('AI_PROVIDER', 'openai-compatible'),
      baseUrl,
      model,
      key: aiKey,
      timeoutMs: num('AI_TIMEOUT_MS', 20000),
      maxRetries: num('AI_MAX_RETRIES', 2),
      enabled: Boolean(aiKey),
    },
    site: {
      monthlyCallCap: num('SITE_MONTHLY_CALL_CAP', 2000),
      monthlyCostCap: num('SITE_MONTHLY_COST_CAP', 0),
      grantBudgetCalls: num('SITE_GRANT_BUDGET_CALLS', 200),
      grantMaxPerMatch: num('SITE_GRANT_MAX_PER_MATCH', 2),
      grantCooldownSec: num('SITE_GRANT_COOLDOWN_SEC', 600),
    },
  };
}

/** 启动自检：把"降级"与"缺失"明确说清楚（《阶段5》§6.1）。 */
export function describeConfig(cfg: ServerConfig): string[] {
  const lines: string[] = [];
  lines.push(`监听：http://${cfg.host}:${cfg.port}`);
  lines.push(`数据目录：${cfg.dataDir}`);
  lines.push(cfg.ai.enabled
    ? `AI：真实提供方已启用（${cfg.ai.provider} / ${cfg.ai.model}）`
    : 'AI：未配置 AI_KEY / AI_BASE_URL / AI_MODEL → 使用内置模拟主持人（离线可玩，判定为规则匹配）');
  lines.push(cfg.masterKey
    ? '密钥保险箱：已启用（房主可提交自己的 API Key，AES-256-GCM 加密存储）'
    : '密钥保险箱：未启用（缺少 MASTER_KEY）→ 房主自备 Key 功能关闭，将使用站点额度或模拟主持人');
  if (cfg.devTools) lines.push('调试接口：已挂载 /debug/*（仅本地开发；公网部署请设置 DEV_TOOLS=0）');
  return lines;
}

/**
 * 启动引导：加载配置 → 打开数据库（完整性自检 + 迁移）→ 播种题库 →
 * 恢复房间 → 启动 HTTP/WS → 打印可访问地址与降级说明。
 *
 * 启动失败一律给出"原因 + 处理建议"，不抛原始堆栈（《阶段5》§6.1）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLATFORM } from '@ht/core';
import { describeConfig, loadConfig, type ServerConfig } from './config.ts';
import { Logger } from './log.ts';
import { Store } from './store.ts';
import { Vault } from './vault.ts';
import { HostService } from './ai.ts';
import { App } from './server.ts';
import { seedPuzzles } from './data/seed-puzzles.ts';

export interface BootOptions {
  /** 覆盖配置（测试用） */
  config?: Partial<ServerConfig>;
  /** 使用内存数据库（测试用） */
  inMemoryDb?: boolean;
  /** 自动打开浏览器（默认仅真实启动时开启） */
  openBrowser?: boolean;
  autoTick?: boolean;
  /** 静态资源目录覆盖（测试用） */
  webDir?: string;
  /** 注入时钟（测试用假时钟） */
  now?: () => number;
}

export interface BootedApp {
  app: App;
  store: Store;
  logger: Logger;
  vault: Vault;
  host: HostService;
  config: ServerConfig;
  url: string;
  port: number;
  close: () => Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function boot(options: BootOptions = {}): Promise<BootedApp> {
  const baseConfig = loadConfig();
  const config: ServerConfig = { ...baseConfig, ...options.config };
  const logger = new Logger(config.logLevel, options.inMemoryDb ? undefined : `${config.dataDir}/logs`);

  const store = new Store(config.dataDir, options.inMemoryDb ? `test-${randomUUID()}.db` : 'haiguitang.db');
  const integrity = store.integrityCheck();
  if (!integrity.ok) {
    logger.error('db_integrity_failed', { detail: integrity.detail });
    throw new Error(`数据库完整性校验失败（${integrity.detail}）：请备份 data/ 后删除数据库文件重建（对局记录会丢失，题库会从种子重建）`);
  }
  for (const puzzle of seedPuzzles()) store.upsertPuzzle(puzzle);

  const vault = new Vault(config.masterKey);
  const host = new HostService({
    store,
    logger,
    config: config.ai,
    siteQuotaAllows: () => config.site.monthlyCallCap <= 0 || store.usage('site', Date.now()).calls < config.site.monthlyCallCap,
    onCall: (info) => {
      logger.debug('provider_call', {
        source: info.source, ok: info.ok, latency_ms: info.latencyMs,
        tokens_in: info.tokensIn, tokens_out: info.tokensOut, code: info.errorClass,
      });
    },
  });

  const now = options.now ?? (() => Date.now());
  const app = new App({
    config,
    store,
    logger,
    vault,
    host,
    now,
    newId: (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`,
    rand: Math.random,
    webDir: options.webDir ?? resolve(here, '../../web/public'),
    autoTick: options.autoTick ?? true,
  });

  const restored = app.registry.restore(now());
  const { port, url } = await app.listen();

  for (const line of describeConfig(config)) logger.info('startup', { detail: line });
  if (restored > 0) logger.info('startup', { detail: `已恢复 ${restored} 个房间（进行中的对局进入暂停，等待成员回来）` });
  logger.info('startup', { detail: `平台级阈值：挂机 ${PLATFORM.idleSec}s / 后台 ${PLATFORM.hiddenIdleSec}s / 断连 ${PLATFORM.disconnectSec}s / 房主无响应 ${PLATFORM.hostUnresponsiveSec}s` });

  return {
    app, store, logger, vault, host, config, url, port,
    close: async () => { await app.close(); store.close(); },
  };
}

// ---------------------------------------------------------------- CLI 入口
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  boot({ openBrowser: true })
    .then(async (booted) => {
      const lines = [
        '',
        '  ✓ 海龟汤本地服务器已启动（M1 本地测试形态）',
        `  → 打开：${booted.url}`,
        `  · 端口可改：PORT=8888 pnpm m1     · 数据文件：${booted.store.path}`,
        `  · 健康检查：${booted.url}/api/health`,
        booted.config.devTools ? `  · 调试接口：${booted.url}/debug/state?roomId=...（仅本地）` : '  · 调试接口：未启用（DEV_TOOLS=0）',
        '',
      ];
      console.log(lines.join('\n'));
      // 自动打开浏览器（OPEN_BROWSER=0 可关闭；失败不影响服务运行）
      if (process.env.OPEN_BROWSER !== '0') {
        try {
          const { spawn } = await import('node:child_process');
          if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', booted.url], { detached: true, stdio: 'ignore' }).unref();
          } else if (process.platform === 'darwin') {
            spawn('open', [booted.url], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('xdg-open', [booted.url], { detached: true, stdio: 'ignore' }).unref();
          }
        } catch { /* 打不开浏览器不影响服务 */ }
      }
    })
    .catch((err: Error) => {
      console.error(`\n  ✗ 启动失败：${err.message}\n`);
      process.exitCode = 1;
    });
}

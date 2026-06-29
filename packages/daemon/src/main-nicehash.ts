/**
 * DB-backed NiceHash daemon entrypoint (DRY-RUN by default).
 *
 * Boots the persistent NiceHash control loop. Configuration is sourced from the
 * persisted settings row (`nicehash_settings`) so the operator can edit
 * credentials / connection / strategy from the dashboard config screen without
 * touching the compose env. On first boot the row is seeded from environment
 * variables (see settings.ts), so an env-only deployment keeps working.
 *
 * Boot order: open the SQLite store (applying migrations) → load/seed settings
 * → build the signed client + caching service → resolve the destination pool →
 * build the controller config from settings + live algorithm metadata → drive
 * `NiceHashController.tick()` on an interval with graceful shutdown.
 *
 * In DRY-RUN it logs what it would do and mutates nothing; switch to LIVE from
 * the dashboard (or seed `NICEHASH_RUN_MODE=LIVE`) to enable real orders (only
 * after the submit-price scale is validated - see docs/NICEHASH_ADAPTATION.md
 * §6). Connection/strategy edits apply on restart; the run mode applies live.
 *
 * Run: `pnpm daemon:nicehash`.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createNiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { NiceHashController } from './controller/nicehash/controller.js';
import { ensurePool } from './controller/nicehash/pool-manager.js';
import { settingsFromEnv, toControllerConfig } from './controller/nicehash/settings.js';
import { NiceHashStateStore } from './controller/nicehash/state-store.js';
import type { NiceHashTickResult } from './controller/nicehash/tick.js';
import { createNiceHashHttpServer } from './http/nicehash-server.js';
import { NiceHashService } from './services/nicehash-service.js';
import { closeDatabase, openDatabase } from './state/db.js';
import { NiceHashOrdersRepo } from './state/repos/nicehash_orders.js';
import { NiceHashSettingsRepo } from './state/repos/nicehash_settings.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readBuildNumber(): number {
  try {
    return parseInt(readFileSync('BUILD_NUMBER', 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function logTick(res: NiceHashTickResult): void {
  const s = res.state;
  const m = s.market;
  console.log(
    `[${new Date(s.tick_at).toISOString()}] mode=${s.run_mode} balance=${s.balance_btc ?? '?'} anchor=${m?.anchor_price_btc ?? 'n/a'} owned=${s.owned_orders.length} unknown=${s.unknown_orders.length}`,
  );
  for (let i = 0; i < res.gated.length; i++) {
    const g = res.gated[i]!;
    const o = res.outcomes[i]!;
    const verdict = g.allowed ? o.outcome : `BLOCKED(${'reason' in o ? o.reason : '?'})`;
    console.log(`  • ${g.proposal.kind}: ${g.proposal.reason} -> ${verdict}`);
  }
}

async function main(): Promise<void> {
  // 1. Open the DB first - settings live there, seeded from env on first boot.
  const dbPath = process.env.NICEHASH_DB_PATH ?? 'data/nicehash-state.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const handle = await openDatabase({ path: dbPath });
  if (handle.migrations.applied.length > 0) {
    console.log(`migrations applied: ${handle.migrations.applied.join(', ')}`);
  }
  const ledger = new NiceHashOrdersRepo(handle.db);
  const settingsRepo = new NiceHashSettingsRepo(handle.db);

  // 2. Load persisted settings, or seed from env on first boot.
  let settings = await settingsRepo.get();
  if (!settings) {
    settings = settingsFromEnv(process.env);
    await settingsRepo.put(settings);
    console.log('settings seeded from environment (edit them on the dashboard config screen)');
  }

  // 3. Build the signed client + caching service from the saved connection.
  const client = createNiceHashClient({
    baseUrl: settings.baseUrl,
    credentials: {
      apiKey: settings.apiKey,
      apiSecret: settings.apiSecret,
      orgId: settings.orgId,
    },
  });
  const service = new NiceHashService({ client });
  await service.syncTime();
  const algo = await service.getAlgorithmSetting(settings.algorithm);

  // 4. Resolve the destination pool. Auto-register the configured stratum pool
  // (idempotent) and use its id, so the operator never has to look one up. Pool
  // registration carries no fee and is safe in any run mode. Failures here are
  // non-fatal: without a pool, decide() simply won't propose CREATE_ORDER.
  let poolId = '';
  if (settings.poolHost && settings.poolUser) {
    try {
      poolId = await ensurePool(client, {
        name: 'nicehash-autobidder',
        algorithm: settings.algorithm,
        stratumHostname: settings.poolHost,
        stratumPort: settings.poolPort,
        username: settings.poolUser,
        password: settings.poolPassword || 'x',
      });
      console.log(`  pool auto-registered → ${poolId}`);
    } catch (err) {
      console.error(`  pool registration failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  // 5. Build the controller config from settings + live algorithm metadata.
  const config = toControllerConfig(settings, algo, poolId);

  // Shared store: the loop writes each tick here, the HTTP API reads it, and
  // the run mode lives here so the dashboard can flip DRY-RUN / LIVE / PAUSED.
  const store = new NiceHashStateStore(settings.runMode);

  const controller = new NiceHashController({
    service,
    client,
    ledger,
    config,
    currency: settings.priceCurrency,
    balanceCurrency: settings.balanceCurrency,
    runMode: () => store.getRunMode(),
  });

  const httpPort = Number(process.env.NICEHASH_HTTP_PORT ?? 3010);
  const app = await createNiceHashHttpServer({
    store,
    ledger,
    settingsRepo,
    config,
    buildNumber: readBuildNumber(),
    tickSeconds: settings.tickSeconds,
  });
  await app.listen({ port: httpPort, host: '0.0.0.0' });

  console.log('NiceHash daemon starting');
  console.log(`  base=${settings.baseUrl} algorithm=${settings.algorithm} market=${config.market}`);
  console.log(`  run_mode=${settings.runMode} tick=${settings.tickSeconds}s db=${dbPath} pool_id=${config.pool_id || '(none)'}`);
  console.log(`  HTTP API on :${httpPort} (dashboard at /, config + connectivity test on the page)`);
  if (settings.runMode === 'LIVE') {
    console.log(
      '  ⚠️  LIVE: marketplace mutations enabled. Confirm the submit-price scale on a funded testnet order first (docs/NICEHASH_ADAPTATION.md §6).',
    );
  }
  if (!config.pool_id) {
    console.log(
      '  ℹ️  No pool resolved (set the pool host + user on the config screen) → decide() will not propose CREATE_ORDER.',
    );
  }

  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received - shutting down…`);
    await app.close();
    await closeDatabase(handle);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  while (!stopping) {
    try {
      const result = await controller.tick();
      store.setLast(result);
      logTick(result);
    } catch (err) {
      console.error(`tick error: ${(err as Error)?.message ?? String(err)}`);
    }
    for (let i = 0; i < settings.tickSeconds && !stopping; i++) await sleep(1000);
  }
}

main().catch((err: unknown) => {
  console.error('NiceHash daemon failed to start:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

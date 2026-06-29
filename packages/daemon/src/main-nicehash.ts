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
import {
  mergeSettings,
  resolveBootRunMode,
  settingsFromEnv,
  toControllerConfig,
} from './controller/nicehash/settings.js';
import { NiceHashStateStore } from './controller/nicehash/state-store.js';
import type { NiceHashTickResult } from './controller/nicehash/tick.js';
import { createNiceHashHttpServer } from './http/nicehash-server.js';
import { HashpriceOracle } from './services/nicehash-hashprice.js';
import { NiceHashService } from './services/nicehash-service.js';
import { closeDatabase, openDatabase } from './state/db.js';
import { NiceHashOrdersRepo } from './state/repos/nicehash_orders.js';
import { NiceHashSettingsRepo } from './state/repos/nicehash_settings.js';
import { NiceHashMetricsRepo } from './state/repos/nicehash_tick_metrics.js';
import { NiceHashEventsRepo } from './state/repos/nicehash_order_events.js';
import { NiceHashDecisionLogRepo } from './state/repos/nicehash_decision_log.js';

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
  const metricsRepo = new NiceHashMetricsRepo(handle.db);
  const eventsRepo = new NiceHashEventsRepo(handle.db);
  const decisionLogRepo = new NiceHashDecisionLogRepo(handle.db);

  // 2. Load persisted settings, or seed from env on first boot. A stored row
  // from an older version may lack newer fields; backfill them from the env
  // defaults (mergeSettings keeps every stored value and fills only the gaps)
  // and persist the normalised row.
  const stored = await settingsRepo.get();
  let settings: ReturnType<typeof settingsFromEnv>;
  if (stored) {
    settings = mergeSettings(settingsFromEnv(process.env), stored);
    await settingsRepo.put(settings);
  } else {
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
  // `config`, `settings`, `poolId` and the oracle are mutable: a live-reload
  // step (see applyLiveSettings, below) rebuilds them from the saved settings
  // each tick so config edits apply without a restart.
  let config = toControllerConfig(settings, algo, poolId);

  // Network-hashprice oracle (estimate) - powers the cost-vs-hashprice tile,
  // the P&L income estimate, and (optionally) the dynamic price cap. Disabled
  // unless the operator picks a source. Best-effort refresh on boot.
  let hashpriceOracle = new HashpriceOracle({ source: settings.hashpriceSource });
  await hashpriceOracle.refresh();

  // Speed-unit (PH) -> price-unit (EH) conversion = marketFactor / priceFactor.
  // Used to express the order burn rate in BTC/day in the metrics. 1 = no-op.
  const mf = Number(algo.marketFactor);
  const pf = Number(algo.priceFactor);
  const speedToPriceUnit = mf > 0 && pf > 0 ? mf / pf : 1;

  // Shared store: the loop writes each tick here, the HTTP API reads it, and
  // the run mode lives here so the dashboard can flip DRY-RUN / LIVE / PAUSED.
  // The boot mode decides the starting run mode (RESUME demotes PAUSED).
  const bootRunMode = resolveBootRunMode(settings.bootMode, settings.runMode);
  const store = new NiceHashStateStore(bootRunMode);

  const controller = new NiceHashController({
    service,
    client,
    ledger,
    config: () => config,
    currency: settings.priceCurrency,
    balanceCurrency: settings.balanceCurrency,
    runMode: () => store.getRunMode(),
    hashprice: () => hashpriceOracle.latest(),
    metrics: metricsRepo,
    events: eventsRepo,
    decisionLog: decisionLogRepo,
    speedToPriceUnit,
  });

  // Prune the time-series + audit log to the configured retention window on
  // boot (and once per day in the loop below).
  const retentionMs = Math.max(1, settings.retentionDays) * 24 * 60 * 60_000;
  const logRetentionMs = Math.max(1, settings.logRetentionDays) * 24 * 60 * 60_000;
  const prune = async (): Promise<void> => {
    try {
      const now = Date.now();
      await metricsRepo.pruneOlderThan(now - retentionMs);
      await eventsRepo.pruneOlderThan(now - retentionMs);
      await decisionLogRepo.pruneOlderThan(now - logRetentionMs);
    } catch {
      /* non-fatal */
    }
  };
  await prune();

  // Single guarded tick driver, shared by the loop and the "Run decision now"
  // HTTP endpoint so the two can never run concurrently.
  let ticking = false;
  const doTick = async (): Promise<{ ok: boolean; error?: string }> => {
    if (ticking) return { ok: false, error: 'a decision tick is already running' };
    ticking = true;
    try {
      const result = await controller.tick();
      store.setLast(result);
      logTick(result);
      return { ok: true };
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      console.error(`tick error: ${error}`);
      try {
        await decisionLogRepo.record({
          ts: Date.now(),
          level: 'error',
          kind: 'ERROR',
          run_mode: store.getRunMode(),
          message: `tick error: ${error}`,
          detail: (err as Error)?.stack ?? null,
        });
      } catch {
        /* non-fatal */
      }
      return { ok: false, error };
    } finally {
      ticking = false;
    }
  };

  const httpPort = Number(process.env.NICEHASH_HTTP_PORT ?? 3010);
  const app = await createNiceHashHttpServer({
    store,
    ledger,
    settingsRepo,
    config: () => config,
    buildNumber: readBuildNumber(),
    tickSeconds: settings.tickSeconds,
    metrics: metricsRepo,
    events: eventsRepo,
    decisionLog: decisionLogRepo,
    hashprice: () => hashpriceOracle.latest(),
    runNow: doTick,
  });
  await app.listen({ port: httpPort, host: '0.0.0.0' });

  console.log('NiceHash daemon starting');
  console.log(`  base=${settings.baseUrl} algorithm=${settings.algorithm} market=${config.market}`);
  console.log(`  boot_mode=${settings.bootMode} run_mode=${bootRunMode} tick=${settings.tickSeconds}s db=${dbPath} pool_id=${config.pool_id || '(none)'}`);
  console.log(`  HTTP API on :${httpPort} (dashboard at /, config + connectivity test on the page)`);
  if (bootRunMode === 'LIVE') {
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

  // --- Live config reload (no restart needed for routine tuning) -------------
  // Each tick we re-read the saved settings and rebuild the controller config,
  // so edits on the dashboard (overpay, caps, fees, dynamic cap, target,
  // min-fill, walk-up, cheap mode, refill, pool worker, …) take effect on the
  // next decision. Pool stratum changes re-register the pool; a hashprice-source
  // change rebuilds the oracle. Connection-level fields (API key/secret/org,
  // base URL, algorithm/market) keep the boot client and still need a restart.
  const poolKeyOf = (s: typeof settings): string =>
    [s.poolHost, s.poolPort, s.poolUser, s.poolPassword, s.algorithm].join('|');
  let poolKey = poolKeyOf(settings);
  let oracleSource: string = settings.hashpriceSource;
  const applyLiveSettings = async (): Promise<void> => {
    try {
      const latestStored = await settingsRepo.get();
      if (!latestStored) return;
      const latest = mergeSettings(settingsFromEnv(process.env), latestStored);
      const nPoolKey = poolKeyOf(latest);
      if (nPoolKey !== poolKey) {
        if (latest.poolHost && latest.poolUser) {
          try {
            poolId = await ensurePool(client, {
              name: 'nicehash-autobidder',
              algorithm: latest.algorithm,
              stratumHostname: latest.poolHost,
              stratumPort: latest.poolPort,
              username: latest.poolUser,
              password: latest.poolPassword || 'x',
            });
            console.log(`  pool re-registered (live config change) → ${poolId}`);
          } catch (err) {
            console.error(`  live pool re-register failed: ${(err as Error)?.message ?? String(err)}`);
          }
        }
        poolKey = nPoolKey;
      }
      if (latest.hashpriceSource !== oracleSource) {
        hashpriceOracle = new HashpriceOracle({ source: latest.hashpriceSource });
        oracleSource = latest.hashpriceSource;
        await hashpriceOracle.refresh();
      }
      settings = latest;
      config = toControllerConfig(latest, algo, poolId);
    } catch (err) {
      console.error(`live settings reload failed: ${(err as Error)?.message ?? String(err)}`);
    }
  };

  let lastPruneAt = Date.now();
  const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
  while (!stopping) {
    // Pick up any live config edits before deciding.
    await applyLiveSettings();
    // Refresh the hashprice estimate when stale (cheap no-op when source=none).
    if (hashpriceOracle.isStale()) await hashpriceOracle.refresh();
    await doTick();
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      await prune();
      lastPruneAt = Date.now();
    }
    for (let i = 0; i < settings.tickSeconds && !stopping; i++) await sleep(1000);
  }
}

main().catch((err: unknown) => {
  console.error('NiceHash daemon failed to start:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

/**
 * DB-backed NiceHash daemon entrypoint (DRY-RUN by default).
 *
 * Boots the persistent NiceHash control loop: opens the SQLite store (applying
 * migrations), builds the signed client + caching service, hydrates the
 * owned-order ledger, and drives `NiceHashController.tick()` on an interval
 * with graceful shutdown. In DRY-RUN it logs what it would do and mutates
 * nothing; flip `NICEHASH_RUN_MODE=LIVE` to enable real orders (only after the
 * submit-price scale is validated - see docs/NICEHASH_ADAPTATION.md §6).
 *
 * Config comes from env (see config-from-env.ts). Run: `pnpm daemon:nicehash`.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createNiceHashClient } from '@hashrate-autopilot/nicehash-client';

import {
  buildControllerConfig,
  readConnection,
} from './controller/nicehash/config-from-env.js';
import { NiceHashController } from './controller/nicehash/controller.js';
import { ensurePool } from './controller/nicehash/pool-manager.js';
import { NiceHashStateStore } from './controller/nicehash/state-store.js';
import type { NiceHashTickResult } from './controller/nicehash/tick.js';
import { createNiceHashHttpServer } from './http/nicehash-server.js';
import { NiceHashService } from './services/nicehash-service.js';
import { closeDatabase, openDatabase } from './state/db.js';
import { NiceHashOrdersRepo } from './state/repos/nicehash_orders.js';

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
  const conn = readConnection(process.env);
  const client = createNiceHashClient({ baseUrl: conn.baseUrl, credentials: conn.credentials });
  const service = new NiceHashService({ client });
  await service.syncTime();
  const algo = await service.getAlgorithmSetting(conn.algorithm);
  const rc = buildControllerConfig(algo, process.env);

  // Resolve the destination pool. Prefer an explicit NICEHASH_POOL_ID; else
  // auto-register the configured stratum pool (idempotent) and use its id, so
  // the operator never has to look one up. Pool registration carries no fee and
  // is safe in any run mode.
  let poolId = rc.config.pool_id;
  if (!poolId && process.env.NICEHASH_POOL_HOST && process.env.NICEHASH_POOL_USER) {
    poolId = await ensurePool(client, {
      name: process.env.NICEHASH_POOL_NAME ?? 'nicehash-autobidder',
      algorithm: conn.algorithm,
      stratumHostname: process.env.NICEHASH_POOL_HOST,
      stratumPort: Number(process.env.NICEHASH_POOL_PORT ?? 3333),
      username: process.env.NICEHASH_POOL_USER,
      password: process.env.NICEHASH_POOL_PASS ?? 'x',
    });
    console.log(`  pool auto-registered → ${poolId}`);
  }
  const config = { ...rc.config, pool_id: poolId };

  const dbPath = process.env.NICEHASH_DB_PATH ?? 'data/nicehash-state.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const handle = await openDatabase({ path: dbPath });
  if (handle.migrations.applied.length > 0) {
    console.log(`migrations applied: ${handle.migrations.applied.join(', ')}`);
  }
  const ledger = new NiceHashOrdersRepo(handle.db);

  // Shared store: the loop writes each tick here, the HTTP API reads it, and
  // the run mode lives here so the dashboard can flip DRY-RUN / LIVE / PAUSED.
  const store = new NiceHashStateStore(rc.runMode);

  const controller = new NiceHashController({
    service,
    client,
    ledger,
    config,
    currency: rc.currency,
    balanceCurrency: rc.balanceCurrency,
    runMode: () => store.getRunMode(),
  });

  const httpPort = Number(process.env.NICEHASH_HTTP_PORT ?? 3010);
  const app = await createNiceHashHttpServer({
    store,
    ledger,
    config,
    buildNumber: readBuildNumber(),
    tickSeconds: rc.tickSeconds,
  });
  await app.listen({ port: httpPort, host: '0.0.0.0' });

  console.log('NiceHash daemon starting');
  console.log(`  base=${conn.baseUrl} algorithm=${conn.algorithm} market=${config.market}`);
  console.log(`  run_mode=${rc.runMode} tick=${rc.tickSeconds}s db=${dbPath} pool_id=${config.pool_id || '(none)'}`);
  console.log(`  HTTP API on :${httpPort} (GET /api/nicehash/status, POST /api/nicehash/run-mode)`);
  if (rc.runMode === 'LIVE') {
    console.log(
      '  ⚠️  LIVE: marketplace mutations enabled. Confirm the submit-price scale on a funded testnet order first (docs/NICEHASH_ADAPTATION.md §6).',
    );
  }
  if (!config.pool_id) {
    console.log(
      '  ℹ️  No pool resolved (set NICEHASH_POOL_ID, or NICEHASH_POOL_HOST + NICEHASH_POOL_USER) → decide() will not propose CREATE_ORDER.',
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
    for (let i = 0; i < rc.tickSeconds && !stopping; i++) await sleep(1000);
  }
}

main().catch((err: unknown) => {
  console.error('NiceHash daemon failed to start:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

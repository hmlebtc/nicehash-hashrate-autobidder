/**
 * Standalone NiceHash control-loop runner (DRY-RUN by default, no DB).
 *
 * Ties the real loop together - service -> observe -> decide -> gate ->
 * execute - against a live NiceHash endpoint and logs what it WOULD do each
 * tick. In DRY-RUN nothing is mutated, so it's safe to point at a real key to
 * watch the controller reason about the live order book. For the persistent,
 * ledger-backed daemon use `pnpm daemon:nicehash` instead.
 *
 * Config is via env (shared with the daemon - see
 * packages/daemon/src/controller/nicehash/config-from-env.ts). Extra runner-only
 * knob: NICEHASH_ONCE=1 runs a single tick and exits.
 */

import { createNiceHashClient } from '@hashrate-autopilot/nicehash-client';

import {
  buildControllerConfig,
  readConnection,
} from '../packages/daemon/src/controller/nicehash/config-from-env.js';
import { tick, type NiceHashTickResult } from '../packages/daemon/src/controller/nicehash/tick.js';
import { NiceHashService } from '../packages/daemon/src/services/nicehash-service.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function logTick(res: NiceHashTickResult): void {
  const s = res.state;
  const m = s.market;
  console.log(`\n[${new Date(s.tick_at).toISOString()}] run_mode=${s.run_mode}`);
  console.log(
    `  balance=${s.balance_btc ?? '?'}  anchor=${m?.anchor_price_btc ?? 'n/a'}  totalSpeed=${m?.total_speed_units ?? '?'}  thin=${m?.thin ?? '?'}`,
  );
  console.log(`  owned=${s.owned_orders.length}  unknown=${s.unknown_orders.length}`);
  if (res.proposals.length === 0) console.log('  proposals: (none - holding)');
  for (let i = 0; i < res.gated.length; i++) {
    const g = res.gated[i]!;
    const o = res.outcomes[i]!;
    const verdict = g.allowed ? o.outcome : `BLOCKED(${'reason' in o ? o.reason : '?'})`;
    const note = 'note' in o && o.note ? ` — ${o.note}` : '';
    console.log(`  • ${g.proposal.kind}: ${g.proposal.reason} -> ${verdict}${note}`);
  }
}

async function main(): Promise<void> {
  const conn = readConnection(process.env);
  const client = createNiceHashClient({ baseUrl: conn.baseUrl, credentials: conn.credentials });
  const service = new NiceHashService({ client });
  await service.syncTime();
  const algo = await service.getAlgorithmSetting(conn.algorithm);
  const rc = buildControllerConfig(algo, process.env);
  const once = process.env.NICEHASH_ONCE === '1';

  console.log('NiceHash control loop runner (no DB)');
  console.log(`  base=${conn.baseUrl}  algorithm=${conn.algorithm}  market=${rc.config.market}`);
  console.log(`  run_mode=${rc.runMode}  tick=${rc.tickSeconds}s  pool_id=${rc.config.pool_id || '(none)'}`);
  console.log(
    `  target=${rc.config.target_speed_units} PH/s  overpay=${rc.config.overpay_btc_per_unit_day}  maxPrice=${rc.config.max_price_btc_per_unit_day} BTC/EH/day`,
  );
  if (!rc.config.pool_id) {
    console.log('  ℹ️  No NICEHASH_POOL_ID set → decide() will not propose CREATE_ORDER.');
  }

  const runOnce = async (): Promise<void> => {
    try {
      logTick(
        await tick({
          service,
          client,
          config: rc.config,
          currency: rc.currency,
          balanceCurrency: rc.balanceCurrency,
          knownOrderIds: rc.ownOrderIds,
          runMode: rc.runMode,
          hashprice: null,
          orderType: 'STANDARD',
        }),
      );
    } catch (err) {
      console.error(`  tick error: ${(err as Error)?.message ?? String(err)}`);
    }
  };

  if (once) {
    await runOnce();
    return;
  }

  let stop = false;
  process.on('SIGINT', () => {
    console.log('\nstopping…');
    stop = true;
  });
  while (!stop) {
    await runOnce();
    for (let i = 0; i < rc.tickSeconds && !stop; i++) await sleep(1000);
  }
}

main().catch((err: unknown) => {
  console.error('\nLoop runner failed:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

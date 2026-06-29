/**
 * Standalone NiceHash control-loop runner (DRY-RUN by default).
 *
 * Ties the real loop together - service -> observe -> decide -> gate ->
 * execute - against a live NiceHash endpoint, and logs what it WOULD do each
 * tick. In DRY-RUN nothing is mutated (the gate denies every marketplace call),
 * so it's safe to point at a real key to watch the controller reason about the
 * live order book before any DB/dashboard wiring exists.
 *
 * Config is via env vars (credentials are never hardcoded). Algorithm metadata
 * (min order, min speed, price-down step) is read live and used as defaults.
 *
 * Usage (read-only):
 *   NICEHASH_API_KEY=… NICEHASH_API_SECRET=… NICEHASH_ORG_ID=… \
 *   NICEHASH_BALANCE_CURRENCY=TBTC pnpm loop:nicehash
 *
 * Useful knobs: NICEHASH_POOL_ID (set to see CREATE proposals), NICEHASH_MARKET,
 * NICEHASH_TARGET_SPEED (PH/s), NICEHASH_OVERPAY, NICEHASH_MAX_PRICE (BTC/EH/day),
 * NICEHASH_TICK_SECONDS, NICEHASH_ONCE=1, NICEHASH_OWN_ORDER_IDS=a,b.
 */

import {
  createNiceHashClient,
  NICEHASH_TEST_BASE_URL,
  parseDecimal,
} from '@hashrate-autopilot/nicehash-client';

import { NiceHashService } from '../packages/daemon/src/services/nicehash-service.js';
import { tick, type NiceHashTickResult } from '../packages/daemon/src/controller/nicehash/tick.js';
import type {
  NiceHashControllerConfig,
  RunMode,
} from '../packages/daemon/src/controller/nicehash/types.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}
const num = (name: string, fallback: number): number => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function logTick(res: NiceHashTickResult): void {
  const s = res.state;
  const ts = new Date(s.tick_at).toISOString();
  const m = s.market;
  console.log(`\n[${ts}] run_mode=${s.run_mode}`);
  console.log(
    `  balance=${s.balance_btc ?? '?'}  anchor=${m?.anchor_price_btc ?? 'n/a'}  totalSpeed=${m?.total_speed_units ?? '?'}  thin=${m?.thin ?? '?'}`,
  );
  console.log(`  owned=${s.owned_orders.length}  unknown=${s.unknown_orders.length}`);
  if (res.proposals.length === 0) {
    console.log('  proposals: (none - holding)');
  }
  for (let i = 0; i < res.gated.length; i++) {
    const g = res.gated[i]!;
    const o = res.outcomes[i]!;
    const verdict = g.allowed ? o.outcome : `BLOCKED(${'reason' in o ? o.reason : '?'})`;
    const note = 'note' in o && o.note ? ` — ${o.note}` : '';
    console.log(`  • ${g.proposal.kind}: ${g.proposal.reason} -> ${verdict}${note}`);
  }
}

async function main(): Promise<void> {
  const credentials = {
    apiKey: required('NICEHASH_API_KEY'),
    apiSecret: required('NICEHASH_API_SECRET'),
    orgId: required('NICEHASH_ORG_ID'),
  };
  const baseUrl = process.env.NICEHASH_BASE_URL ?? NICEHASH_TEST_BASE_URL;
  const algorithm = process.env.NICEHASH_ALGORITHM ?? 'SHA256ASICBOOST';
  const market = process.env.NICEHASH_MARKET ?? 'EU';
  const priceCurrency = process.env.NICEHASH_PRICE_CURRENCY ?? 'BTC';
  const balanceCurrency = process.env.NICEHASH_BALANCE_CURRENCY ?? 'TBTC';
  const poolId = process.env.NICEHASH_POOL_ID ?? '';
  const runMode = (process.env.NICEHASH_RUN_MODE ?? 'DRY_RUN') as RunMode;
  const tickSeconds = num('NICEHASH_TICK_SECONDS', 60);
  const once = process.env.NICEHASH_ONCE === '1';
  const ownOrderIds = new Set(
    (process.env.NICEHASH_OWN_ORDER_IDS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

  const client = createNiceHashClient({ baseUrl, credentials });
  const service = new NiceHashService({ client });
  await service.syncTime();
  const algo = await service.getAlgorithmSetting(algorithm);

  const minOrder = parseDecimal(algo.minimalOrderAmount, 0.001);
  const config: NiceHashControllerConfig = {
    market,
    algorithm,
    pool_id: poolId,
    target_speed_units: num('NICEHASH_TARGET_SPEED', 1),
    overpay_btc_per_unit_day: num('NICEHASH_OVERPAY', 0.0001),
    max_price_btc_per_unit_day: num('NICEHASH_MAX_PRICE', 0.02),
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: num('NICEHASH_ORDER_BUDGET_BTC', minOrder),
    refill_amount_btc: num('NICEHASH_REFILL_AMOUNT_BTC', 0),
    refill_when_runway_hours: num('NICEHASH_REFILL_RUNWAY_HOURS', 6),
    min_order_amount_btc: minOrder,
    price_edit_deadband_pct: num('NICEHASH_DEADBAND_PCT', 20),
    min_speed_limit_units: parseDecimal(algo.minSpeedLimit, 0.1),
    price_down_step_btc: Math.abs(parseDecimal(algo.priceDownStep, 0.0001)),
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };

  console.log('NiceHash control loop runner');
  console.log(`  base=${baseUrl}  algorithm=${algorithm}  market=${market}`);
  console.log(`  run_mode=${runMode}  tick=${tickSeconds}s  pool_id=${poolId || '(none)'}`);
  console.log(
    `  target=${config.target_speed_units} PH/s  overpay=${config.overpay_btc_per_unit_day}  maxPrice=${config.max_price_btc_per_unit_day} BTC/EH/day`,
  );
  if (runMode === 'LIVE') {
    console.log(
      '  ⚠️  LIVE mode: marketplace mutations are ENABLED. The submit-price scale is not yet validated against a funded testnet order — keep this DRY-RUN until §6 of the adaptation doc is confirmed.',
    );
  }
  if (!poolId) {
    console.log('  ℹ️  No NICEHASH_POOL_ID set → decide() will not propose CREATE_ORDER.');
  }

  const runOnce = async (): Promise<void> => {
    try {
      const res = await tick({
        service,
        client,
        config,
        currency: priceCurrency,
        balanceCurrency,
        knownOrderIds: ownOrderIds,
        runMode,
        hashprice: null,
        orderType: 'STANDARD',
      });
      logTick(res);
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
    for (let i = 0; i < tickSeconds && !stop; i++) await sleep(1000);
  }
}

main().catch((err: unknown) => {
  console.error('\nLoop runner failed:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

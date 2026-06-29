/**
 * Price-scale validation probe (TESTNET, opt-in, auto-cancelling).
 *
 * Resolves the one open question from docs/NICEHASH_ADAPTATION.md §6: is the
 * `price` we SUBMIT on createOrder stored at the SAME scale the order book
 * shows (BTC/EH/day for SHA256ASICBOOST), or does NiceHash transform it
 * (e.g. per-PH vs per-EH, a 1000x difference)?
 *
 * What it does:
 *   1. picks a deliberately LOW, uncompetitive price (so the order won't be
 *      matched and won't spend) at the minimum order amount + minimum speed,
 *   2. creates ONE STANDARD order,
 *   3. reads it back (getOrder + myOrders) and compares submitted vs stored
 *      price/limit/amount,
 *   4. CANCELS it immediately (always, even on error) - refunding the escrow;
 *      the only cost is the ~0.00001 BTC non-refundable creation fee.
 *
 * SAFETY:
 *   - Refuses to run unless NICEHASH_VALIDATE_PRICE_SCALE=1 is set explicitly.
 *   - Refuses to run against production unless NICEHASH_ALLOW_PROD=1 too.
 *   - Needs a pool: set NICEHASH_POOL_ID, or NICEHASH_POOL_HOST/PORT/USER to
 *     auto-register one.
 *
 * Run: NICEHASH_VALIDATE_PRICE_SCALE=1 pnpm validate:nicehash
 */

import {
  createNiceHashClient,
  parseDecimal,
  type HashpowerOrder,
} from '@hashrate-autopilot/nicehash-client';

import { readConnection } from '../packages/daemon/src/controller/nicehash/config-from-env.js';
import { ensurePool } from '../packages/daemon/src/controller/nicehash/pool-manager.js';
import { NiceHashService } from '../packages/daemon/src/services/nicehash-service.js';

const env = process.env;
const num = (k: string, d: number): number => {
  const v = env[k];
  return v === undefined || v === '' ? d : Number(v);
};
const dec = (n: number, decimals = 8): string => parseFloat(n.toFixed(decimals)).toString();

// Default validation pool (operator-provided testnet pool). Overridable via env.
const DEFAULT_POOL_HOST = 'pool.xaxamining.com';
const DEFAULT_POOL_USER = 'tb1q3a89fh49xwzrjy4k8ee05etlp5zlnxq5hzks84';

async function resolvePoolId(client: ReturnType<typeof createNiceHashClient>, algorithm: string): Promise<string> {
  if (env.NICEHASH_POOL_ID) return env.NICEHASH_POOL_ID;
  return ensurePool(client, {
    name: env.NICEHASH_POOL_NAME ?? 'nicehash-autobidder-validate',
    algorithm,
    stratumHostname: env.NICEHASH_POOL_HOST ?? DEFAULT_POOL_HOST,
    stratumPort: num('NICEHASH_POOL_PORT', 3333),
    username: env.NICEHASH_POOL_USER ?? DEFAULT_POOL_USER,
    password: env.NICEHASH_POOL_PASS ?? 'x',
  });
}

async function main(): Promise<void> {
  const conn = readConnection(env);
  const isProd = conn.baseUrl.includes('api2.nicehash.com');

  if (env.NICEHASH_VALIDATE_PRICE_SCALE !== '1') {
    console.log('Price-scale validation probe (auto-cancelling) is OPT-IN.');
    console.log('It places ONE minimum order at a low price, reads it back, and cancels it.');
    console.log('Re-run with NICEHASH_VALIDATE_PRICE_SCALE=1 to proceed.');
    process.exit(0);
  }
  if (isProd && env.NICEHASH_ALLOW_PROD !== '1') {
    console.error('Refusing to run against production (api2.nicehash.com) without NICEHASH_ALLOW_PROD=1.');
    process.exit(2);
  }

  const client = createNiceHashClient({ baseUrl: conn.baseUrl, credentials: conn.credentials });
  const service = new NiceHashService({ client });
  await service.syncTime();

  const algorithm = conn.algorithm;
  const market = env.NICEHASH_MARKET ?? 'BTC';
  const priceCurrency = env.NICEHASH_PRICE_CURRENCY ?? 'BTC';
  const balanceCurrency = env.NICEHASH_BALANCE_CURRENCY ?? 'TBTC';

  const algo = await service.getAlgorithmSetting(algorithm);
  const minOrder = parseDecimal(algo.minimalOrderAmount, 0.001);
  const minSpeed = parseDecimal(algo.minSpeedLimit, 0.1);

  // Pick a low, uncompetitive submit price from the live book.
  const book = await client.getOrderBook(algorithm);
  const bucket = book.stats?.[priceCurrency];
  const live = (bucket?.orders ?? []).filter((o) => o.alive !== false);
  const standardPrices = live
    .filter((o) => (o.type ?? '').toUpperCase() === 'STANDARD')
    .map((o) => parseDecimal(o.price))
    .filter((p) => p > 0)
    .sort((a, b) => a - b);
  const cheapest = standardPrices[0];
  // Default to the cheapest live STANDARD price: guaranteed-valid (others use
  // it) and, tying at the bottom of the book, it's filled last - so in the
  // ~1s before we cancel it won't match (and even a momentary match spends a
  // financially negligible amount). Override with NICEHASH_VALIDATE_PRICE.
  const submitPrice = num('NICEHASH_VALIDATE_PRICE', cheapest ?? 0.0001);
  const submitLimit = num('NICEHASH_VALIDATE_LIMIT', minSpeed);
  const submitAmount = num('NICEHASH_VALIDATE_AMOUNT', minOrder);

  const balance = await client.getAccountBalance(balanceCurrency);
  const available = parseDecimal(balance.available);
  console.log('Price-scale validation probe');
  console.log(`  base=${conn.baseUrl} algorithm=${algorithm} market=${market}`);
  console.log(`  balance=${available} ${balanceCurrency}`);
  console.log(
    `  book: displayPriceFactor=${bucket?.displayPriceFactor ?? '?'} displayMarketFactor=${bucket?.displayMarketFactor ?? '?'} cheapestSTANDARD=${cheapest ?? 'n/a'}`,
  );
  console.log(`  SUBMIT price=${dec(submitPrice)} limit=${dec(submitLimit)} amount=${dec(submitAmount)}`);

  if (available < submitAmount + 0.00001) {
    console.error(`  Insufficient balance: need ~${dec(submitAmount + 0.00001)} (order + creation fee).`);
    process.exit(2);
  }

  const poolId = await resolvePoolId(client, algorithm);
  console.log(`  poolId=${poolId}`);

  // Read back any existing orders first. This confirms the API READ scale
  // (what myOrders/getOrder report) against the UI - useful even if the
  // create call below is gated (e.g. NiceHash 5096).
  const existing = (await client.getMyOrders({ algorithm, market })).list ?? [];
  console.log(`\nexisting orders (market ${market}): ${existing.length}`);
  for (const o of existing) {
    console.log(
      `  - id=${o.id} price=${o.price} limit=${o.limit} amount=${o.amount} status=${typeof o.status === 'string' ? o.status : (o.status?.code ?? '?')}`,
    );
  }

  let createdId: string | undefined;
  try {
    console.log('\n→ createOrder …');
    const created = await client.createOrder({
      market,
      algorithm,
      type: 'STANDARD',
      amount: dec(submitAmount),
      price: dec(submitPrice),
      limit: dec(submitLimit),
      poolId,
      marketFactor: algo.marketFactor,
      displayMarketFactor: algo.displayMarketFactor,
    });
    createdId = created.id;
    console.log(`  created id=${created.id}`);

    const readBack = await client.getOrder(created.id);
    const fromList = (await client.getMyOrders({ algorithm, market })).list?.find(
      (o) => o.id === created.id,
    );

    const show = (label: string, o: HashpowerOrder | undefined): void => {
      if (!o) return void console.log(`  ${label}: (not found)`);
      console.log(`  ${label}: price=${o.price} limit=${o.limit} amount=${o.amount} available=${o.availableAmount ?? '?'}`);
    };
    console.log('\nread-back:');
    show('getOrder', readBack);
    show('myOrders', fromList);

    const storedPrice = parseDecimal(readBack.price);
    const ratio = storedPrice > 0 ? storedPrice / submitPrice : 0;
    console.log(`\nprice: submitted=${dec(submitPrice)}  stored=${readBack.price}  ratio=${ratio.toFixed(6)}`);
    if (Math.abs(ratio - 1) < 0.01) {
      console.log('✓ PASS — stored price matches submitted price. Submit scale == order-book scale.');
    } else {
      console.log(
        `✗ MISMATCH — stored/submitted ratio ${ratio.toFixed(6)} (≈${Math.round(ratio)}x). The submit price needs scaling; tell me this ratio and I'll fix the executor.`,
      );
    }
  } finally {
    if (createdId) {
      console.log(`\n→ cancelOrder ${createdId} (cleanup) …`);
      try {
        await client.cancelOrder(createdId);
        console.log('  cancelled — escrow refunded (minus the non-refundable creation fee).');
      } catch (err) {
        console.error(`  ⚠️ CANCEL FAILED: ${(err as Error)?.message ?? String(err)}`);
        console.error(`  ⚠️ Manually cancel order ${createdId} in the NiceHash UI.`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error('\nValidation probe failed:');
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
});

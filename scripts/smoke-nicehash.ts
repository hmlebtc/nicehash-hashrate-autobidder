/**
 * NiceHash smoke test - proves the signed-client chain works against a live
 * NiceHash endpoint (testnet by default) end to end. READ-ONLY: it never
 * creates, edits, refills, or cancels an order, so it's safe to run with real
 * credentials. (Order mutations are deliberately out of scope here; per project
 * policy they need an explicit operator green-light.)
 *
 * Credentials are read from the environment - they are NEVER hardcoded or
 * committed. Generate a key at https://test.nicehash.com (testnet) with
 * hash-power read + accounting read permissions.
 *
 * Usage:
 *   NICEHASH_API_KEY=...        \
 *   NICEHASH_API_SECRET=...     \
 *   NICEHASH_ORG_ID=...         \
 *   NICEHASH_BASE_URL=https://api-test.nicehash.com   # default; prod=https://api2.nicehash.com
 *   NICEHASH_ALGORITHM=SHA256   # default
 *   NICEHASH_MARKET=EU          # default
 *   NICEHASH_CURRENCY=TBTC      # testnet balance currency; prod=BTC
 *   pnpm smoke:nicehash
 */

import {
  createNiceHashClient,
  NICEHASH_TEST_BASE_URL,
  NiceHashApiError,
  parseDecimal,
} from '@hashrate-autopilot/nicehash-client';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function mask(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

async function main() {
  const apiKey = required('NICEHASH_API_KEY');
  const apiSecret = required('NICEHASH_API_SECRET');
  const orgId = required('NICEHASH_ORG_ID');
  const baseUrl = process.env.NICEHASH_BASE_URL ?? NICEHASH_TEST_BASE_URL;
  const algorithm = process.env.NICEHASH_ALGORITHM ?? 'SHA256';
  const market = process.env.NICEHASH_MARKET ?? 'EU';
  const currency = process.env.NICEHASH_CURRENCY ?? 'TBTC';

  console.log('NiceHash smoke test (read-only)');
  console.log(`  base       ${baseUrl}`);
  console.log(`  org        ${orgId}`);
  console.log(`  apiKey     ${mask(apiKey)}`);
  console.log(`  apiSecret  ${mask(apiSecret)}`);
  console.log(`  algorithm  ${algorithm}   market ${market}   currency ${currency}`);

  const client = createNiceHashClient({ baseUrl, credentials: { apiKey, apiSecret, orgId } });

  console.log('\n→ syncTime() (public, learns clock offset)');
  const offset = await client.syncTime();
  console.log(`  clock offset vs NiceHash: ${offset} ms`);

  console.log(`\n→ getAlgorithmSetting(${algorithm}) (public)`);
  const algo = await client.getAlgorithmSetting(algorithm);
  console.log(`  marketFactor=${algo.marketFactor} displayMarketFactor=${algo.displayMarketFactor}`);
  console.log(
    `  minOrder=${algo.minimalOrderAmount ?? '?'} BTC  minSpeed=${algo.minSpeedLimit ?? '?'}  maxSpeed=${algo.maxSpeedLimit ?? '?'}  priceDownStep=${algo.priceDownStep ?? '?'}`,
  );

  console.log(`\n→ getAccountBalance(${currency}) (SIGNED - proves HMAC auth)`);
  try {
    const bal = await client.getAccountBalance(currency);
    console.log(`  available=${bal.available} total=${bal.totalBalance} pending=${bal.pending ?? '0'}`);
  } catch (err) {
    console.log(`  (balance read failed: ${(err as Error).message})`);
  }

  console.log(`\n→ getMyOrders(${algorithm}, ${market}) (SIGNED)`);
  const mine = await client.getMyOrders({ algorithm, market });
  console.log(`  active orders: ${mine.list?.length ?? 0}`);
  for (const o of mine.list ?? []) {
    console.log(
      `   - id=${o.id} price=${o.price} limit=${o.limit} avail=${o.availableAmount ?? '?'} speed=${o.acceptedCurrentSpeed ?? '0'}`,
    );
  }
  // Shape probe: confirm the top-level field name (list vs orderList vs ...).
  console.log(`  myOrders top-level keys: ${Object.keys(mine ?? {}).join(', ')}`);

  console.log(`\n→ getOrderBook(${algorithm})`);
  const book = await client.getOrderBook(algorithm);
  // Shape probe: the order book is keyed differently than first assumed
  // (saw "BTC", not "EU"). Dump the structure so the parser can be fixed.
  const rawStats = (book as { stats?: Record<string, unknown> }).stats ?? {};
  console.log(`  stats keys: ${Object.keys(rawStats).join(', ')}`);
  for (const [k, v] of Object.entries(rawStats)) {
    const nested = v && typeof v === 'object' ? Object.keys(v as Record<string, unknown>) : [];
    console.log(`   stats[${k}] keys: ${nested.join(', ')}`);
  }
  console.log('  raw orderBook (truncated to 4000 chars):');
  console.log(JSON.stringify(book, null, 2).slice(0, 4000));

  console.log('\n✓ Smoke test complete - signed NiceHash calls succeeded.');
}

main().catch((err: unknown) => {
  console.error('\nSmoke test FAILED:');
  if (err instanceof NiceHashApiError) {
    console.error(`  ${err.message}`);
    console.error(`  HTTP ${err.status}`);
    if (err.errors.length) console.error(`  NiceHash errors: ${JSON.stringify(err.errors)}`);
  } else {
    console.error(`  ${(err as Error)?.message ?? String(err)}`);
  }
  process.exit(1);
});

/**
 * TESTNET-ONLY convenience defaults for the dev scripts (smoke / loop /
 * validate) so credentials don't have to be passed on every run.
 *
 * ⚠️  These are throwaway **testnet** credentials (api-test.nicehash.com) with
 *     no mainnet value - testnet coins are worthless. NEVER hardcode
 *     production / mainnet API keys this way; for the real daemon, pass
 *     credentials via env or a gitignored secrets file.
 *
 * Any explicitly-set env var overrides these. This module is intentionally
 * NOT imported by the daemon entrypoint (`main-nicehash.ts`).
 */

const TESTNET_DEFAULTS: Record<string, string> = {
  NICEHASH_API_KEY: 'e7055dfd-e56b-4aea-96fe-f21c906333be',
  NICEHASH_API_SECRET: '05c77743-bbd0-4e9d-96fe-34a6ca8344a585832b58-c688-4a81-980d-2cbaf95435c0',
  NICEHASH_ORG_ID: '954d273a-47df-4c81-aab7-019f77e3811e',
  NICEHASH_BASE_URL: 'https://api-test.nicehash.com',
  NICEHASH_BALANCE_CURRENCY: 'TBTC',
};

/** Fill in any unset (or empty) NiceHash env vars with the testnet defaults. */
export function applyTestnetDefaults(): void {
  for (const [key, value] of Object.entries(TESTNET_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

/**
 * Pool registration for NiceHash.
 *
 * A Braiins bid carried its destination stratum URL inline; a NiceHash order
 * instead references a **registered pool by id**. Before the first order the
 * loop must ensure the operator's stratum pool exists in the account and
 * resolve its `poolId`. This finds an existing pool matching the operator's
 * stratum config (so we don't create duplicates across restarts) and creates
 * one only when absent.
 */

import type { CreatePoolRequest, NiceHashClient } from '@hashrate-autopilot/nicehash-client';

/** True when an existing pool matches the desired stratum config. */
function poolMatches(
  pool: { algorithm?: string; stratumHostname?: string; stratumPort?: number; username?: string },
  want: CreatePoolRequest,
): boolean {
  return (
    pool.algorithm === want.algorithm &&
    pool.stratumHostname === want.stratumHostname &&
    pool.stratumPort === want.stratumPort &&
    pool.username === want.username
  );
}

/**
 * Resolve the `poolId` for the operator's stratum pool, registering it if it
 * isn't already present. Idempotent across restarts (matches on
 * algorithm + host + port + username).
 */
export async function ensurePool(
  client: Pick<NiceHashClient, 'getPools' | 'createPool'>,
  want: CreatePoolRequest,
): Promise<string> {
  const existing = await client.getPools({ size: 100, page: 0 });
  const match = (existing.list ?? []).find((p) => poolMatches(p, want));
  if (match) return match.id;
  const created = await client.createPool(want);
  return created.id;
}

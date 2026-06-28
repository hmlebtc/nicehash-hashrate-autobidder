/**
 * #250: append-only log of public-IP rotations. One row per observed
 * change of the box's public IPv4 (old -> new), written from the
 * public-IP poll's onIpChange hook in main.ts. Drives the "IP last
 * changed" line in the Dynamic DNS card and the IP-change markers on
 * the hashrate / price charts.
 *
 * Persisted (the DDNS updater's own snapshot is in-memory and resets on
 * restart) so the chart can query historical changes by range and the
 * card survives a daemon restart.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export interface IpChangeEventInsert {
  occurred_at: number;
  old_ip: string | null;
  new_ip: string;
}

export interface IpChangeEventRow extends IpChangeEventInsert {
  id: number;
}

export class IpChangeEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(event: IpChangeEventInsert): Promise<void> {
    await this.db.insertInto('ip_change_events').values(event).execute();
  }

  async listSince(sinceMs: number, untilMs?: number): Promise<IpChangeEventRow[]> {
    let q = this.db
      .selectFrom('ip_change_events')
      .selectAll()
      .where('occurred_at', '>=', sinceMs);
    if (untilMs !== undefined) q = q.where('occurred_at', '<=', untilMs);
    return q.orderBy('occurred_at', 'asc').execute();
  }

  /** Most recent change, or null if the IP has never been observed to rotate. */
  async latest(): Promise<IpChangeEventRow | null> {
    const row = await this.db
      .selectFrom('ip_change_events')
      .selectAll()
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }
}

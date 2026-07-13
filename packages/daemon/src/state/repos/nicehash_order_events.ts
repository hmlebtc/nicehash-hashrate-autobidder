/**
 * NiceHash order-mutation audit trail - the data behind the History page.
 *
 * The controller records one row per attempted order mutation (CREATE /
 * EDIT_PRICE / EDIT_LIMIT / REFILL / CANCEL) with its before/after price+limit,
 * the market anchor at the time, the run mode, and the outcome
 * (EXECUTED / DRY_RUN / FAILED). The History page lists and filters these.
 */

import type { Kysely } from 'kysely';

import type { Database, NiceHashOrderEventsTable } from '../types.js';

export type NiceHashOrderEventAction =
  | 'CREATE'
  | 'EDIT_PRICE'
  | 'EDIT_LIMIT'
  | 'REFILL'
  | 'CANCEL';

export interface NiceHashOrderEventInput {
  readonly ts: number;
  readonly order_id: string | null;
  readonly action: NiceHashOrderEventAction;
  readonly run_mode: string;
  readonly outcome: 'EXECUTED' | 'DRY_RUN' | 'FAILED';
  readonly price_before: number | null;
  readonly price_after: number | null;
  readonly limit_before: number | null;
  readonly limit_after: number | null;
  readonly amount_btc: number | null;
  readonly anchor_price_btc: number | null;
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface NiceHashEventFilters {
  readonly actions?: readonly string[];
  readonly orderIdContains?: string;
  readonly sinceMs?: number;
  readonly untilMs?: number;
  /** Minimum |price_after - price_before|; rows without both prices are excluded. */
  readonly minAbsDeltaPrice?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export type NiceHashOrderEventRow = {
  [K in keyof NiceHashOrderEventsTable]: K extends 'id'
    ? number
    : NiceHashOrderEventsTable[K];
};

export class NiceHashEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async record(e: NiceHashOrderEventInput): Promise<void> {
    await this.db.insertInto('nicehash_order_events').values(e).execute();
  }

  /**
   * List events newest-first, with optional filters + pagination.
   * `maxLimit` bounds the requested `limit` - 1000 for the dashboard page,
   * raised by the CSV export route which needs a much bigger row cap.
   */
  async list(filters: NiceHashEventFilters = {}, maxLimit = 1000): Promise<NiceHashOrderEventRow[]> {
    let q = this.db.selectFrom('nicehash_order_events').selectAll();
    if (filters.actions && filters.actions.length > 0) {
      q = q.where('action', 'in', filters.actions as string[]);
    }
    if (filters.orderIdContains) {
      q = q.where('order_id', 'like', `%${filters.orderIdContains}%`);
    }
    if (filters.sinceMs !== undefined) q = q.where('ts', '>=', filters.sinceMs);
    if (filters.untilMs !== undefined) q = q.where('ts', '<=', filters.untilMs);
    if (filters.minAbsDeltaPrice !== undefined && filters.minAbsDeltaPrice > 0) {
      const min = filters.minAbsDeltaPrice;
      q = q
        .where('price_before', 'is not', null)
        .where('price_after', 'is not', null)
        .where((eb) =>
          eb.or([
            eb('price_after', '>=', eb('price_before', '+', min)),
            eb('price_after', '<=', eb('price_before', '-', min)),
          ]),
        );
    }
    q = q.orderBy('ts', 'desc').limit(Math.min(filters.limit ?? 200, maxLimit));
    if (filters.offset) q = q.offset(filters.offset);
    return q.execute() as Promise<NiceHashOrderEventRow[]>;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('nicehash_order_events')
      .where('ts', '<', cutoffMs)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}

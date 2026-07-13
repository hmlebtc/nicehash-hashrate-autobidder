/**
 * Per-tick decision + error log - the data behind the dashboard Logs tab.
 *
 * The controller records one row per tick summarising what it decided (and why,
 * including holds / blocks / pauses); the daemon records ERROR rows for
 * tick-level exceptions. Pruned by the operator-configurable log-retention
 * window.
 */

import type { Kysely } from 'kysely';

import type { Database, NiceHashDecisionLogTable } from '../types.js';

export type NiceHashLogLevel = 'info' | 'warn' | 'error';

export interface NiceHashLogInput {
  readonly ts: number;
  readonly level: NiceHashLogLevel;
  readonly kind: string;
  readonly run_mode: string | null;
  readonly message: string;
  readonly detail: string | null;
}

export interface NiceHashLogFilters {
  readonly levels?: readonly string[];
  readonly sinceMs?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export type NiceHashLogRow = {
  [K in keyof NiceHashDecisionLogTable]: K extends 'id' ? number : NiceHashDecisionLogTable[K];
};

export class NiceHashDecisionLogRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async record(e: NiceHashLogInput): Promise<void> {
    await this.db.insertInto('nicehash_decision_log').values(e).execute();
  }

  /**
   * List newest-first, with optional level filter + pagination.
   * `maxLimit` bounds the requested `limit` - 2000 for the dashboard page,
   * raised by the CSV export route which needs a much bigger row cap.
   */
  async list(filters: NiceHashLogFilters = {}, maxLimit = 2000): Promise<NiceHashLogRow[]> {
    let q = this.db.selectFrom('nicehash_decision_log').selectAll();
    if (filters.levels && filters.levels.length > 0) {
      q = q.where('level', 'in', filters.levels as string[]);
    }
    if (filters.sinceMs !== undefined) q = q.where('ts', '>=', filters.sinceMs);
    q = q.orderBy('ts', 'desc').orderBy('id', 'desc').limit(Math.min(filters.limit ?? 300, maxLimit));
    if (filters.offset) q = q.offset(filters.offset);
    return q.execute() as Promise<NiceHashLogRow[]>;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('nicehash_decision_log')
      .where('ts', '<', cutoffMs)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}

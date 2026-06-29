/**
 * Per-tick NiceHash metrics time series - the data behind the dashboard
 * hashrate/price charts, the summary tiles, and the profit & loss panel.
 *
 * One row per controller tick. Reads are range scans (chart windows) and a
 * single aggregate query (tiles); writes are one upsert per tick. Old rows are
 * pruned by the configurable retention window.
 */

import type { Kysely } from 'kysely';

import type { Database, NiceHashTickMetricsTable } from '../types.js';

export type NiceHashMetricRow = NiceHashTickMetricsTable;

/** Aggregate over a window, for the summary tiles. NULLs are ignored by AVG. */
export interface NiceHashMetricsSummary {
  readonly samples: number;
  readonly uptime_pct: number | null;
  readonly avg_accepted_units: number | null;
  readonly avg_limit_units: number | null;
  readonly avg_our_price_btc: number | null;
  readonly avg_anchor_price_btc: number | null;
  readonly avg_hashprice_btc_per_unit_day: number | null;
  readonly avg_spend_rate_btc_day: number | null;
  readonly first_ts: number | null;
  readonly last_ts: number | null;
}

export class NiceHashMetricsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Upsert the metrics row for a tick (ts is the primary key). */
  async record(row: NiceHashMetricRow): Promise<void> {
    await this.db
      .insertInto('nicehash_tick_metrics')
      .values(row)
      .onConflict((oc) =>
        oc.column('ts').doUpdateSet({
          run_mode: row.run_mode,
          api_ok: row.api_ok,
          balance_btc: row.balance_btc,
          anchor_price_btc: row.anchor_price_btc,
          our_price_btc: row.our_price_btc,
          total_speed_units: row.total_speed_units,
          accepted_speed_units: row.accepted_speed_units,
          limit_units: row.limit_units,
          target_units: row.target_units,
          floor_units: row.floor_units,
          available_amount_btc: row.available_amount_btc,
          spend_rate_btc_day: row.spend_rate_btc_day,
          hashprice_btc_per_unit_day: row.hashprice_btc_per_unit_day,
          owned_count: row.owned_count,
          unknown_count: row.unknown_count,
        }),
      )
      .execute();
  }

  /** Rows in [sinceMs, untilMs] ascending by ts (for charts). */
  async range(sinceMs: number, untilMs?: number): Promise<NiceHashMetricRow[]> {
    let q = this.db
      .selectFrom('nicehash_tick_metrics')
      .selectAll()
      .where('ts', '>=', sinceMs);
    if (untilMs !== undefined) q = q.where('ts', '<=', untilMs);
    return q.orderBy('ts', 'asc').execute();
  }

  /** The most recent row, or null. */
  async latest(): Promise<NiceHashMetricRow | null> {
    const row = await this.db
      .selectFrom('nicehash_tick_metrics')
      .selectAll()
      .orderBy('ts', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /** Window aggregate for the summary tiles. */
  async summary(sinceMs: number): Promise<NiceHashMetricsSummary> {
    const row = await this.db
      .selectFrom('nicehash_tick_metrics')
      .where('ts', '>=', sinceMs)
      .select((eb) => [
        eb.fn.countAll<number>().as('samples'),
        eb.fn.avg<number | null>('api_ok').as('uptime_frac'),
        eb.fn.avg<number | null>('accepted_speed_units').as('avg_accepted_units'),
        eb.fn.avg<number | null>('limit_units').as('avg_limit_units'),
        eb.fn.avg<number | null>('our_price_btc').as('avg_our_price_btc'),
        eb.fn.avg<number | null>('anchor_price_btc').as('avg_anchor_price_btc'),
        eb.fn.avg<number | null>('hashprice_btc_per_unit_day').as('avg_hashprice_btc_per_unit_day'),
        eb.fn.avg<number | null>('spend_rate_btc_day').as('avg_spend_rate_btc_day'),
        eb.fn.min<number | null>('ts').as('first_ts'),
        eb.fn.max<number | null>('ts').as('last_ts'),
      ])
      .executeTakeFirst();
    const uptimeFrac = row?.uptime_frac ?? null;
    return {
      samples: Number(row?.samples ?? 0),
      uptime_pct: uptimeFrac === null ? null : Number(uptimeFrac) * 100,
      avg_accepted_units: nn(row?.avg_accepted_units),
      avg_limit_units: nn(row?.avg_limit_units),
      avg_our_price_btc: nn(row?.avg_our_price_btc),
      avg_anchor_price_btc: nn(row?.avg_anchor_price_btc),
      avg_hashprice_btc_per_unit_day: nn(row?.avg_hashprice_btc_per_unit_day),
      avg_spend_rate_btc_day: nn(row?.avg_spend_rate_btc_day),
      first_ts: nn(row?.first_ts),
      last_ts: nn(row?.last_ts),
    };
  }

  /** Delete rows older than the cutoff. Returns the number deleted. */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('nicehash_tick_metrics')
      .where('ts', '<', cutoffMs)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}

function nn(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

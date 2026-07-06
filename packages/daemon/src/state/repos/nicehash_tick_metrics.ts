/**
 * Per-tick NiceHash metrics time series - the data behind the dashboard
 * hashrate/price charts, the summary tiles, and the profit & loss panel.
 *
 * One row per controller tick. Reads are range scans (chart windows) and a
 * single aggregate query (tiles); writes are one upsert per tick. Old rows are
 * pruned by the configurable retention window.
 */

import { sql, type Kysely } from 'kysely';

import type { Database, NiceHashTickMetricsTable } from '../types.js';

export type NiceHashMetricRow = NiceHashTickMetricsTable;

/** Aggregate over a window, for the summary tiles. NULLs are ignored by AVG. */
export interface NiceHashMetricsSummary {
  readonly samples: number;
  /** % of ticks where the NiceHash API (order book) was reachable. */
  readonly uptime_pct: number | null;
  /**
   * Fill uptime: of the ticks where an order was *active* (one existed on the
   * account), the % where it was actually *filled* - delivering at/above the
   * fill threshold (target × min-fill %). null when no order was active in the
   * window. This is the "is my order winning hashrate" health signal, distinct
   * from API uptime.
   */
  readonly fill_uptime_pct: number | null;
  /** Ticks in the window where an order existed (the fill-uptime denominator). */
  readonly active_samples: number;
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
          next_filled_price_btc: row.next_filled_price_btc,
          market_median_price_btc: row.market_median_price_btc,
          market_avg_price_btc: row.market_avg_price_btc,
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
        // Fill uptime: ticks with an order present (active) vs of those the ones
        // delivering at/above the fill threshold (floor_units = target × min-fill%).
        // floor_units 0/null (degenerate config) requires any positive delivery.
        sql<number>`sum(case when owned_count > 0 then 1 else 0 end)`.as('active_samples'),
        sql<number>`sum(case when owned_count > 0 and accepted_speed_units > 0 and accepted_speed_units >= coalesce(floor_units, 0) then 1 else 0 end)`.as(
          'filled_samples',
        ),
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
    const activeSamples = Number(row?.active_samples ?? 0);
    const filledSamples = Number(row?.filled_samples ?? 0);
    return {
      samples: Number(row?.samples ?? 0),
      uptime_pct: uptimeFrac === null ? null : Number(uptimeFrac) * 100,
      fill_uptime_pct: activeSamples > 0 ? (filledSamples / activeSamples) * 100 : null,
      active_samples: activeSamples,
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

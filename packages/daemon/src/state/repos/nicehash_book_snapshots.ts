/**
 * Per-tick NiceHash order-book capture - the data behind the dashboard
 * "Order book" tab and its CSV export.
 *
 * One row per successful book read: the marginal + the strict (raw) and
 * exposed (smoothed) next-tier readings the pipeline derived from it, plus
 * the FULL alive competitor book as a gzipped JSON blob. Each captured row
 * carries its current debounce state (filled / unconfirmed_zero /
 * confirmed_zero / recovering_nonzero) - the state is what makes the
 * tier-smoothing behavior diagnosable offline from a few days of capture.
 *
 * Size: ~1000 rows compress to roughly 10-15 KB per tick, i.e. ~40 MB/day at
 * 30-second ticks. Pruned by the operator-configurable book-capture
 * retention window; capture itself can be toggled off.
 *
 * Reads decompress one snapshot at a time - exports must never inflate days
 * of blobs into memory at once (see `listTs` + `get`).
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { sql, type Kysely } from 'kysely';

import type { Database } from '../types.js';

/** Debounce state of one captured book row (see observe's RowDebounce). */
export type NiceHashBookDebounceState =
  | 'filled'
  | 'unconfirmed_zero'
  | 'confirmed_zero'
  | 'recovering_nonzero';

/** One competitor row as captured (raw book values + debounce state). */
export interface NiceHashBookRowCapture {
  readonly id: string | null;
  readonly price_btc: number;
  readonly limit_units: number;
  readonly rigs_count: number | null;
  readonly accepted_speed_units: number | null;
  readonly debounce_state: NiceHashBookDebounceState;
}

/** One captured snapshot: the tier readings + the full alive competitor book. */
export interface NiceHashBookSnapshot {
  /** Book read time (= the tick's `tick_at`, joinable with the metrics rows). */
  readonly ts: number;
  readonly marginal_price_btc: number | null;
  /** Strict next tier straight from the raw book (no smoothing). */
  readonly raw_tier_btc: number | null;
  /** The exposed (debounce + hysteresis) tier the bot acted on. */
  readonly smoothed_tier_btc: number | null;
  /** Alive competitor rows, price-descending. */
  readonly rows: readonly NiceHashBookRowCapture[];
}

/** Capture status for the tab's header line. */
export interface NiceHashBookCaptureMeta {
  readonly count: number;
  readonly first_ts: number | null;
  readonly last_ts: number | null;
  /** Approximate stored size of the compressed blobs, in bytes. */
  readonly stored_bytes: number;
}

/** Compact per-row JSON encoding inside the gzipped blob (keys repeat ~1000x). */
interface BlobRow {
  readonly i: string | null;
  readonly p: number;
  readonly l: number;
  readonly r: number | null;
  readonly s: number | null;
  readonly d: NiceHashBookDebounceState;
}

export class NiceHashBookSnapshotsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Persist one snapshot (upsert on ts - one row per tick). */
  async record(snap: NiceHashBookSnapshot): Promise<void> {
    const blob: BlobRow[] = snap.rows.map((r) => ({
      i: r.id,
      p: r.price_btc,
      l: r.limit_units,
      r: r.rigs_count,
      s: r.accepted_speed_units,
      d: r.debounce_state,
    }));
    const gz = gzipSync(Buffer.from(JSON.stringify(blob), 'utf8'));
    await this.db
      .insertInto('nicehash_book_snapshots')
      .values({
        ts: snap.ts,
        marginal_price_btc: snap.marginal_price_btc,
        raw_tier_btc: snap.raw_tier_btc,
        smoothed_tier_btc: snap.smoothed_tier_btc,
        row_count: snap.rows.length,
        book_gz: gz,
      })
      .onConflict((oc) =>
        oc.column('ts').doUpdateSet({
          marginal_price_btc: snap.marginal_price_btc,
          raw_tier_btc: snap.raw_tier_btc,
          smoothed_tier_btc: snap.smoothed_tier_btc,
          row_count: snap.rows.length,
          book_gz: gz,
        }),
      )
      .execute();
  }

  /** The most recent snapshot, decompressed, or null. */
  async latest(): Promise<NiceHashBookSnapshot | null> {
    const row = await this.db
      .selectFrom('nicehash_book_snapshots')
      .selectAll()
      .orderBy('ts', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? inflate(row) : null;
  }

  /** One snapshot by exact ts, decompressed, or null. */
  async get(ts: number): Promise<NiceHashBookSnapshot | null> {
    const row = await this.db
      .selectFrom('nicehash_book_snapshots')
      .selectAll()
      .where('ts', '=', ts)
      .executeTakeFirst();
    return row ? inflate(row) : null;
  }

  /** Capture status: snapshot count, covered span, approx stored bytes. */
  async meta(): Promise<NiceHashBookCaptureMeta> {
    const row = await this.db
      .selectFrom('nicehash_book_snapshots')
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        eb.fn.min<number | null>('ts').as('first_ts'),
        eb.fn.max<number | null>('ts').as('last_ts'),
        sql<number | null>`sum(length(book_gz))`.as('stored_bytes'),
      ])
      .executeTakeFirst();
    return {
      count: Number(row?.count ?? 0),
      first_ts: row?.first_ts ?? null,
      last_ts: row?.last_ts ?? null,
      stored_bytes: Number(row?.stored_bytes ?? 0),
    };
  }

  /**
   * Timestamps of the MOST RECENT `limit` snapshots within [fromMs, toMs],
   * returned ascending. The CSV export walks this list and inflates one
   * snapshot at a time (`get`), so days of blobs are never held in memory.
   */
  async listTs(opts: { fromMs?: number; toMs?: number; limit: number }): Promise<number[]> {
    let q = this.db.selectFrom('nicehash_book_snapshots').select('ts');
    if (opts.fromMs !== undefined) q = q.where('ts', '>=', opts.fromMs);
    if (opts.toMs !== undefined) q = q.where('ts', '<=', opts.toMs);
    const rows = await q.orderBy('ts', 'desc').limit(Math.max(1, opts.limit)).execute();
    return rows.map((r) => r.ts).reverse();
  }

  /** Delete snapshots older than the cutoff. Returns the number deleted. */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('nicehash_book_snapshots')
      .where('ts', '<', cutoffMs)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }

  /**
   * Delete ALL stored snapshots (the tab's "Clear data" button - the bulky
   * series an operator may want to reclaim immediately rather than waiting
   * for retention). Returns the number deleted.
   */
  async clearAll(): Promise<number> {
    const res = await this.db.deleteFrom('nicehash_book_snapshots').executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}

function inflate(row: {
  ts: number;
  marginal_price_btc: number | null;
  raw_tier_btc: number | null;
  smoothed_tier_btc: number | null;
  book_gz: Buffer;
}): NiceHashBookSnapshot {
  const blob = JSON.parse(gunzipSync(row.book_gz).toString('utf8')) as BlobRow[];
  return {
    ts: row.ts,
    marginal_price_btc: row.marginal_price_btc,
    raw_tier_btc: row.raw_tier_btc,
    smoothed_tier_btc: row.smoothed_tier_btc,
    rows: blob.map((b) => ({
      id: b.i,
      price_btc: b.p,
      limit_units: b.l,
      rigs_count: b.r,
      accepted_speed_units: b.s,
      debounce_state: b.d,
    })),
  };
}

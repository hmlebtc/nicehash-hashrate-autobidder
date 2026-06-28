/**
 * Repository for the `braiins_deposits` table (#130, revived #210).
 *
 * Written by `BraiinsDepositWatcherService` which polls the Braiins
 * on-chain transaction endpoint every 60s. Each row tracks one
 * deposit across its lifecycle (detected -> credited -> optionally
 * returned). The `notified_*` flags ensure each notification fires
 * exactly once. The `/api/deposits` route reads credited rows for
 * the Price chart's deposit markers (#211).
 */

import { type Kysely, sql } from 'kysely';

import type { Database } from '../types.js';

export type DepositNotificationKind = 'detected' | 'available' | 'returned';

export interface BraiinsDepositRow {
  readonly tx_id: string;
  readonly amount_sat: number;
  readonly address: string | null;
  readonly last_seen_status: number;
  readonly last_seen_return_tx_id: string | null;
  readonly first_seen_at_ms: number;
  readonly updated_at_ms: number;
  readonly tx_timestamp_ms: number | null;
  readonly credited_at_ms: number | null;
  readonly notified_detected: boolean;
  readonly notified_available: boolean;
  readonly notified_returned: boolean;
}

export interface UpsertSeenArgs {
  readonly tx_id: string;
  readonly amount_sat: number;
  readonly address: string | null;
  readonly status: number;
  readonly return_tx_id: string | null;
  readonly observed_at_ms: number;
  readonly tx_timestamp_ms: number | null;
}

export class BraiinsDepositsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert the row's current observed state. New rows are inserted
   * with all `notified_*` flags = 0. Existing rows have their state
   * fields refreshed but `notified_*` flags are preserved (ON
   * CONFLICT DO UPDATE).
   */
  async upsertSeen(args: UpsertSeenArgs): Promise<BraiinsDepositRow> {
    const creditedNow = args.status === 1 ? args.observed_at_ms : null;
    await this.db
      .insertInto('braiins_deposits')
      .values({
        tx_id: args.tx_id,
        amount_sat: args.amount_sat,
        address: args.address,
        last_seen_status: args.status,
        last_seen_return_tx_id: args.return_tx_id,
        first_seen_at_ms: args.observed_at_ms,
        updated_at_ms: args.observed_at_ms,
        tx_timestamp_ms: args.tx_timestamp_ms,
        credited_at_ms: creditedNow,
        notified_detected: 0,
        notified_available: 0,
        notified_returned: 0,
      })
      .onConflict((oc) =>
        oc.column('tx_id').doUpdateSet({
          last_seen_status: args.status,
          last_seen_return_tx_id: args.return_tx_id,
          updated_at_ms: args.observed_at_ms,
          amount_sat: args.amount_sat,
          address: args.address,
          tx_timestamp_ms: args.tx_timestamp_ms,
          credited_at_ms: creditedNow !== null
            ? sql`COALESCE(braiins_deposits.credited_at_ms, CASE WHEN braiins_deposits.last_seen_status = 1 THEN COALESCE(braiins_deposits.tx_timestamp_ms, ${creditedNow}) ELSE ${creditedNow} END)`
            : sql`braiins_deposits.credited_at_ms`,
        }),
      )
      .execute();

    const row = await this.findByTxId(args.tx_id);
    if (!row) {
      throw new Error(`upsertSeen: row vanished after upsert (${args.tx_id})`);
    }
    return row;
  }

  /**
   * Every deposit row, newest first. Used by the debug-dump endpoint
   * so an operator filing a deposit/fee bug can ship one curl that
   * includes the full deposit history. Deposits are rare (Braiins
   * settles ~weekly), so the row count stays bounded regardless of
   * uptime.
   */
  async listAll(): Promise<BraiinsDepositRow[]> {
    const rows = await this.db
      .selectFrom('braiins_deposits')
      .selectAll()
      .orderBy('first_seen_at_ms', 'desc')
      .execute();
    return rows.map((row) => ({
      tx_id: row.tx_id,
      amount_sat: row.amount_sat,
      address: row.address,
      last_seen_status: row.last_seen_status,
      last_seen_return_tx_id: row.last_seen_return_tx_id,
      first_seen_at_ms: row.first_seen_at_ms,
      updated_at_ms: row.updated_at_ms,
      tx_timestamp_ms: row.tx_timestamp_ms ?? null,
      credited_at_ms: row.credited_at_ms ?? null,
      notified_detected: row.notified_detected === 1,
      notified_available: row.notified_available === 1,
      notified_returned: row.notified_returned === 1,
    }));
  }

  /** Row count - used by the watcher to detect fresh-install state. */
  async countAll(): Promise<number> {
    const row = await this.db
      .selectFrom('braiins_deposits')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async findByTxId(tx_id: string): Promise<BraiinsDepositRow | null> {
    const row = await this.db
      .selectFrom('braiins_deposits')
      .selectAll()
      .where('tx_id', '=', tx_id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      tx_id: row.tx_id,
      amount_sat: row.amount_sat,
      address: row.address,
      last_seen_status: row.last_seen_status,
      last_seen_return_tx_id: row.last_seen_return_tx_id,
      first_seen_at_ms: row.first_seen_at_ms,
      updated_at_ms: row.updated_at_ms,
      tx_timestamp_ms: row.tx_timestamp_ms ?? null,
      credited_at_ms: row.credited_at_ms ?? null,
      notified_detected: row.notified_detected === 1,
      notified_available: row.notified_available === 1,
      notified_returned: row.notified_returned === 1,
    };
  }

  /**
   * Flip a single `notified_*` flag to 1. Used by both the actual
   * notification path (after the alert manager records the alert)
   * and the "silently absorb backlog when toggle is off" path.
   */
  async markNotified(tx_id: string, kind: DepositNotificationKind): Promise<void> {
    const col =
      kind === 'detected'
        ? 'notified_detected'
        : kind === 'available'
          ? 'notified_available'
          : 'notified_returned';
    await this.db
      .updateTable('braiins_deposits')
      .set({ [col]: 1 })
      .where('tx_id', '=', tx_id)
      .execute();
  }
}

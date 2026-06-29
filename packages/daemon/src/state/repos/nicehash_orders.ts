/**
 * Repository for the NiceHash owned-order ledger - the analogue of
 * {@link ../repos/owned_bids.OwnedBidsRepo} for the NiceHash order model.
 *
 * On successful CREATE_ORDER: {@link insert}.
 * On successful EDIT_PRICE (decrease): {@link setLastPriceDecrease}.
 * On successful CANCEL_ORDER: {@link markCancelled}.
 * Every tick: {@link reconcileFromApi} brings the ledger in line with
 * `myOrders`, and {@link getIds} / {@link lastPriceDecreaseMap} feed the
 * controller's ownership reconciliation and price-decrease cooldown.
 */

import { sql, type Kysely, type Selectable } from 'kysely';

import type { Database, NiceHashOrdersTable } from '../types.js';

type NiceHashOrdersRow = Selectable<NiceHashOrdersTable>;

export interface NiceHashOrderRow {
  readonly order_id: string;
  readonly created_at: number;
  readonly last_known_status: string | null;
  readonly price_btc: number | null;
  readonly amount_btc: number | null;
  readonly limit_units: number | null;
  readonly payed_amount_btc: number;
  readonly last_price_decrease_at: number | null;
  readonly pool_id: string | null;
  readonly abandoned: boolean;
}

export interface InsertNiceHashOrderArgs {
  readonly order_id: string;
  readonly created_at: number;
  readonly price_btc: number;
  readonly amount_btc: number;
  readonly limit_units: number;
  readonly pool_id: string;
  readonly last_known_status?: string;
}

export interface ReconcilableOrder {
  readonly order_id: string;
  readonly status: string;
  readonly price_btc: number;
  readonly amount_btc: number;
  readonly limit_units: number;
  readonly payed_amount_btc: number;
}

export class NiceHashOrdersRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<NiceHashOrderRow[]> {
    const rows = await this.db.selectFrom('nicehash_orders').selectAll().execute();
    return rows.map(toDomain);
  }

  /** Order ids the autopilot owns - feeds the unknown-order PAUSE check. */
  async getIds(): Promise<Set<string>> {
    const rows = await this.db.selectFrom('nicehash_orders').select('order_id').execute();
    return new Set(rows.map((r) => r.order_id));
  }

  /** order_id -> last price-decrease timestamp (only rows that have one). */
  async lastPriceDecreaseMap(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('nicehash_orders')
      .select(['order_id', 'last_price_decrease_at'])
      .where('last_price_decrease_at', 'is not', null)
      .execute();
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.last_price_decrease_at !== null) map.set(r.order_id, r.last_price_decrease_at);
    }
    return map;
  }

  /** Record a newly-created order. Idempotent on the order id. */
  async insert(args: InsertNiceHashOrderArgs): Promise<void> {
    await this.db
      .insertInto('nicehash_orders')
      .values({
        order_id: args.order_id,
        created_at: args.created_at,
        last_known_status: args.last_known_status ?? null,
        price_btc: args.price_btc,
        amount_btc: args.amount_btc,
        limit_units: args.limit_units,
        last_price_decrease_at: null,
        pool_id: args.pool_id,
      })
      .onConflict((oc) => oc.column('order_id').doNothing())
      .execute();
  }

  async setLastPriceDecrease(orderId: string, at: number, newPriceBtc: number): Promise<void> {
    await this.db
      .updateTable('nicehash_orders')
      .set({ last_price_decrease_at: at, price_btc: newPriceBtc })
      .where('order_id', '=', orderId)
      .execute();
  }

  async markCancelled(orderId: string, status = 'CANCELLED'): Promise<void> {
    await this.db
      .updateTable('nicehash_orders')
      .set({ last_known_status: status })
      .where('order_id', '=', orderId)
      .execute();
  }

  /**
   * Bring ledger rows in line with what NiceHash currently reports for our
   * orders. Updates status/price/limit and keeps `payed_amount_btc` monotonic
   * (NiceHash's payedAmount can wobble a few sat between polls). Does NOT
   * insert unknown orders - ownership is decided only on our own create.
   */
  async reconcileFromApi(orders: readonly ReconcilableOrder[]): Promise<void> {
    for (const o of orders) {
      await this.db
        .updateTable('nicehash_orders')
        .set({
          last_known_status: o.status,
          price_btc: o.price_btc,
          amount_btc: o.amount_btc,
          limit_units: o.limit_units,
          payed_amount_btc: sql<number>`MAX(payed_amount_btc, ${o.payed_amount_btc})`,
        })
        .where('order_id', '=', o.order_id)
        .execute();
    }
  }

  /** Lifetime spend across every order the autopilot has owned (BTC). */
  async sumLifetimePayedBtc(): Promise<number> {
    const row = await this.db
      .selectFrom('nicehash_orders')
      .select(sql<number>`COALESCE(SUM(payed_amount_btc), 0)`.as('total'))
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }
}

function toDomain(row: NiceHashOrdersRow): NiceHashOrderRow {
  return {
    order_id: row.order_id,
    created_at: row.created_at,
    last_known_status: row.last_known_status,
    price_btc: row.price_btc,
    amount_btc: row.amount_btc,
    limit_units: row.limit_units,
    payed_amount_btc: row.payed_amount_btc,
    last_price_decrease_at: row.last_price_decrease_at,
    pool_id: row.pool_id,
    abandoned: row.abandoned === 1,
  };
}

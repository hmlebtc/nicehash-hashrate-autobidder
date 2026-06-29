/**
 * Mappers from NiceHash wire shapes (`@hashrate-autopilot/nicehash-client`) to
 * the controller's parsed domain types. This is the NiceHash equivalent of the
 * data-shaping the upstream `observe()` did inline against Braiins responses;
 * isolating it here keeps `decide()` pure and these conversions unit-tested.
 */

import { parseDecimal } from '@hashrate-autopilot/nicehash-client';
import type {
  AccountBalance,
  CodeDescription,
  HashpowerOrder,
  OrderBookResponse,
} from '@hashrate-autopilot/nicehash-client';

import { computeMarketAnchor } from './orderbook.js';
import type {
  CompetingOrder,
  MarketAnchor,
  OwnedOrderSnapshot,
  UnknownOrderSnapshot,
} from './types.js';

/** Extract a NiceHash enum's code from either the `{code,description}` or bare-string form. */
export function codeOf(value: CodeDescription | string | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value.code ?? '';
}

/** Available BTC balance as a number; 0 when the field is blank/missing. */
export function availableBtcFromBalance(balance: AccountBalance): number {
  return parseDecimal(balance.available);
}

/**
 * Build the competing-order set from an order book. The book is keyed by
 * paying currency ("BTC"), not by EU/USA market. Dead orders (`alive === false`)
 * and our own resting orders (by id) are excluded.
 */
export function competingOrdersFromBook(
  book: OrderBookResponse,
  currency = 'BTC',
  ownOrderIds: ReadonlySet<string> = new Set(),
): { competitors: CompetingOrder[]; totalSpeedUnits: number } {
  const stats = book.stats?.[currency];
  if (!stats) return { competitors: [], totalSpeedUnits: 0 };
  const competitors: CompetingOrder[] = [];
  for (const entry of stats.orders ?? []) {
    if (entry.alive === false) continue;
    if (entry.id !== undefined && ownOrderIds.has(entry.id)) continue;
    competitors.push({
      price_btc: parseDecimal(entry.price),
      limit_units: parseDecimal(entry.limit),
      accepted_speed_units: parseDecimal(entry.acceptedSpeed),
      rigs_count: typeof entry.rigsCount === 'number' ? entry.rigsCount : Number(entry.rigsCount ?? 0),
    });
  }
  return { competitors, totalSpeedUnits: parseDecimal(stats.totalSpeed) };
}

/**
 * Compute the pricing anchor straight from an order book response.
 */
export function marketAnchorFromBook(
  book: OrderBookResponse,
  targetUnits: number,
  ownOrderIds: ReadonlySet<string> = new Set(),
  currency = 'BTC',
): MarketAnchor {
  const { competitors, totalSpeedUnits } = competingOrdersFromBook(book, currency, ownOrderIds);
  return computeMarketAnchor(competitors, totalSpeedUnits, targetUnits);
}

/** Map a wire order to an owned-order snapshot. Timestamps are ledger-sourced. */
export function ownedOrderFromWire(
  order: HashpowerOrder,
  lastPriceDecreaseAt: number | null = null,
  lastPriceChangeAt: number | null = null,
): OwnedOrderSnapshot {
  return {
    order_id: order.id,
    price_btc: parseDecimal(order.price),
    limit_units: parseDecimal(order.limit),
    amount_btc: parseDecimal(order.amount),
    available_amount_btc: parseDecimal(order.availableAmount),
    payed_amount_btc: parseDecimal(order.payedAmount),
    accepted_speed_units: parseDecimal(order.acceptedCurrentSpeed),
    status: codeOf(order.status),
    pool_username: order.pool?.username ?? null,
    last_price_decrease_at: lastPriceDecreaseAt,
    last_price_change_at: lastPriceChangeAt,
  };
}

/**
 * Order statuses that mean an order is no longer live (it neither delivers
 * hashrate nor spends). Used to scope pool-worker matching to live orders so a
 * pile of historical CANCELLED/COMPLETED orders on the same worker isn't all
 * adopted as "ours".
 */
const NON_LIVE_STATUSES = new Set([
  'DEAD',
  'CANCELLED',
  'CANCELED',
  'COMPLETED',
  'COMPLETE',
  'ERROR',
  'EXPIRED',
  'STOPPED',
]);

/** True when an order is live/open (e.g. ACTIVE), not stopped/finished. */
export function isLiveOrder(order: HashpowerOrder): boolean {
  return !NON_LIVE_STATUSES.has(codeOf(order.status).toUpperCase());
}

/**
 * Pick out the autobidder's own orders from the account's hash-power orders.
 *
 * An order is ours when it is in our ledger (an order we created and recorded)
 * OR it is a *live* order whose pool worker matches our configured `poolUser`
 * (e.g. `<address>.autobidder`). The pool-worker match makes ownership robust
 * across a ledger reset - after a restart the bot re-adopts its existing
 * `.autobidder` order instead of orphaning it - and is what lets it keep to a
 * single managed order (`decide()` cancels any extra owned order).
 *
 * Everything else (a manual or legacy order on a different worker) is simply
 * **ignored**: the bot neither manages nor pauses on it. `unknown` is therefore
 * always empty now; it is retained for shape/back-compat (the PAUSE-on-unknown
 * guard in `decide()` is harmless dead weight unless something repopulates it).
 */
export function reconcileOrders(
  wireOrders: readonly HashpowerOrder[],
  knownOrderIds: ReadonlySet<string>,
  poolUser = '',
  lastPriceDecreaseById: ReadonlyMap<string, number> = new Map(),
  lastPriceChangeById: ReadonlyMap<string, number> = new Map(),
): { owned: OwnedOrderSnapshot[]; unknown: UnknownOrderSnapshot[] } {
  const owned: OwnedOrderSnapshot[] = [];
  const unknown: UnknownOrderSnapshot[] = [];
  for (const order of wireOrders) {
    const inLedger = knownOrderIds.has(order.id);
    const poolMatch = poolUser !== '' && (order.pool?.username ?? '') === poolUser && isLiveOrder(order);
    if (inLedger || poolMatch) {
      owned.push(
        ownedOrderFromWire(
          order,
          lastPriceDecreaseById.get(order.id) ?? null,
          lastPriceChangeById.get(order.id) ?? null,
        ),
      );
    }
    // Foreign orders (not ours) are intentionally ignored - no PAUSE.
  }
  return { owned, unknown };
}

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

/** Map a wire order to an owned-order snapshot. `last_price_decrease_at` is ledger-sourced. */
export function ownedOrderFromWire(
  order: HashpowerOrder,
  lastPriceDecreaseAt: number | null = null,
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
    last_price_decrease_at: lastPriceDecreaseAt,
  };
}

function unknownOrderFromWire(order: HashpowerOrder): UnknownOrderSnapshot {
  return { order_id: order.id, price_btc: parseDecimal(order.price) };
}

/**
 * Split the account's hash-power orders into ours (present in the ledger) and
 * unknown (not in the ledger). Unknown orders force the controller to PAUSE.
 */
export function reconcileOrders(
  wireOrders: readonly HashpowerOrder[],
  knownOrderIds: ReadonlySet<string>,
  lastPriceDecreaseById: ReadonlyMap<string, number> = new Map(),
): { owned: OwnedOrderSnapshot[]; unknown: UnknownOrderSnapshot[] } {
  const owned: OwnedOrderSnapshot[] = [];
  const unknown: UnknownOrderSnapshot[] = [];
  for (const order of wireOrders) {
    if (knownOrderIds.has(order.id)) {
      owned.push(ownedOrderFromWire(order, lastPriceDecreaseById.get(order.id) ?? null));
    } else {
      unknown.push(unknownOrderFromWire(order));
    }
  }
  return { owned, unknown };
}

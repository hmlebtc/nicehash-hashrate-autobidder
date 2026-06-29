/**
 * observe() for the NiceHash loop - read one tick of marketplace state and
 * shape it into a `NiceHashState` for `decide()`.
 *
 * Degradation policy (mirrors the upstream observe's "null on failed poll"):
 *   - order book read fails  -> `market = null`        (decide skips pricing)
 *   - balance read fails     -> `balance_btc = null`   (decide skips create)
 *   - **my-orders read fails -> refuse to act**: we force `market = null` so
 *     the controller does nothing this tick rather than risk creating a
 *     duplicate order while blind to the one we may already have.
 */

import type { MarketAnchor, NiceHashControllerConfig, NiceHashState, RunMode } from './types.js';
import { availableBtcFromBalance, marketAnchorFromBook, reconcileOrders } from './wire.js';
import type { NiceHashService } from '../../services/nicehash-service.js';

export interface NiceHashObserveDeps {
  readonly service: NiceHashService;
  readonly config: NiceHashControllerConfig;
  /** Paying-currency bucket key for the order book + balance (BTC / TBTC). */
  readonly currency: string;
  /** Balance currency code (TBTC on testnet, BTC on production). */
  readonly balanceCurrency: string;
  /** Order ids we consider ours (from the ledger). */
  readonly knownOrderIds: ReadonlySet<string>;
  /** Per-order last price-decrease timestamps (from the ledger). */
  readonly lastPriceDecreaseById?: ReadonlyMap<string, number>;
  readonly runMode: RunMode;
  /** Break-even hashprice in BTC/price-unit/day, or null when unavailable. */
  readonly hashprice?: number | null;
  readonly now?: () => number;
}

export async function observe(deps: NiceHashObserveDeps): Promise<NiceHashState> {
  const now = deps.now ?? Date.now;
  const tickAt = now();
  const { service, config } = deps;

  // Our own orders first - if this read fails we must not act (avoid dup create).
  let owned: NiceHashState['owned_orders'] = [];
  let unknown: NiceHashState['unknown_orders'] = [];
  let ordersOk = true;
  try {
    const res = await service.getMyOrders({ algorithm: config.algorithm, market: config.market });
    const split = reconcileOrders(
      res.list ?? [],
      deps.knownOrderIds,
      deps.lastPriceDecreaseById ?? new Map(),
    );
    owned = split.owned;
    unknown = split.unknown;
  } catch {
    ordersOk = false;
  }

  // Order book -> pricing anchor (exclude our own orders).
  let market: MarketAnchor | null = null;
  try {
    const book = await service.getOrderBook(config.algorithm);
    market = marketAnchorFromBook(book, config.target_speed_units, deps.knownOrderIds, deps.currency);
  } catch {
    market = null;
  }

  // Available balance.
  let balanceBtc: number | null = null;
  try {
    const bal = await service.getAccountBalance(deps.balanceCurrency);
    balanceBtc = availableBtcFromBalance(bal);
  } catch {
    balanceBtc = null;
  }

  // Blind to our own orders -> force a no-op tick.
  if (!ordersOk) market = null;

  return {
    tick_at: tickAt,
    run_mode: deps.runMode,
    config,
    market,
    balance_btc: balanceBtc,
    owned_orders: owned,
    unknown_orders: unknown,
    hashprice_btc_per_unit_day: deps.hashprice ?? null,
  };
}

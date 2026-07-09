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

import { parseDecimal } from '@hashrate-autopilot/nicehash-client';

import { effectiveCapBtc } from './types.js';
import type { MarketAnchor, NiceHashControllerConfig, NiceHashState, RunMode } from './types.js';
import {
  availableBtcFromBalance,
  marketAnchorFromBook,
  ownOrderFillsFromBook,
  reconcileOrders,
} from './wire.js';
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
  /** Per-order last price-change timestamps (from the ledger); settle window. */
  readonly lastPriceChangeById?: ReadonlyMap<string, number>;
  /**
   * Mutable per-order "under-filled since" timestamps, owned by the controller
   * across ticks (in memory). observe() updates it from this tick's delivered
   * speed vs the fill threshold (set when an order goes under-filled, cleared when
   * it fills) and stamps each owned order's `under_filled_since`. The controller
   * also resets an entry on a walk-up so each new price gets a fresh grace window.
   * Drives the walk-up grace period in decide().
   */
  readonly underFilledSinceById?: Map<string, number>;
  readonly runMode: RunMode;
  /** Break-even hashprice in BTC/price-unit/day, or null when unavailable. */
  readonly hashprice?: number | null;
  readonly now?: () => number;
}

export async function observe(deps: NiceHashObserveDeps): Promise<NiceHashState> {
  const now = deps.now ?? Date.now;
  const tickAt = now();
  const { service, config } = deps;

  const errMsg = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  // Our own orders first - if this read fails we must not act (avoid dup create).
  let owned: NiceHashState['owned_orders'] = [];
  let unknown: NiceHashState['unknown_orders'] = [];
  let ordersOk = true;
  let ordersError: string | null = null;
  try {
    const res = await service.getMyOrders({ algorithm: config.algorithm, market: config.market });
    const split = reconcileOrders(
      res.list ?? [],
      deps.knownOrderIds,
      config.pool_user,
      deps.lastPriceDecreaseById ?? new Map(),
      deps.lastPriceChangeById ?? new Map(),
    );
    owned = split.owned;
    unknown = split.unknown;

    // The myOrders LIST under-reports delivered speed (it can read 0 even while
    // the per-order detail shows a live draw) and lags the escrow balance, so
    // refresh each of our orders' accepted speed AND available amount from the
    // order-detail endpoint. Best-effort: a failed detail read just keeps the
    // list values. The two fields merge differently:
    //   - speed: take the larger same-tick reading (list under-reports, never lower it).
    //   - amount: prefer the detail value whenever present (escrow legitimately
    //     falls, so a "never lower" rule would freeze it stale), but bounded by
    //     the detail's own funded-minus-spent (amount − payedAmount), mirroring
    //     ownedOrderFromWire - the served availableAmount can freeze upstream
    //     while billing continues, and preferring the raw detail figure would
    //     reintroduce that frozen value over the corrected list figure.
    owned = await Promise.all(
      owned.map(async (o) => {
        try {
          const detail = await service.getOrder(o.order_id);
          const patch: { accepted_speed_units?: number; available_amount_btc?: number } = {};

          const detailSpeed = parseDecimal(detail.acceptedCurrentSpeed);
          if (Number.isFinite(detailSpeed) && detailSpeed > o.accepted_speed_units) {
            patch.accepted_speed_units = detailSpeed;
          }

          if (detail.availableAmount !== undefined) {
            const detailAvail = parseDecimal(detail.availableAmount);
            if (Number.isFinite(detailAvail) && detailAvail >= 0) {
              const detailAmount = parseDecimal(detail.amount);
              const detailPayed = parseDecimal(detail.payedAmount);
              patch.available_amount_btc =
                detailAmount > 0
                  ? Math.max(0, Math.min(detailAvail, detailAmount - detailPayed))
                  : detailAvail;
            }
          }

          return { ...o, ...patch };
        } catch {
          /* keep the list-reported values on detail-read failure */
        }
        return o;
      }),
    );
  } catch (err) {
    ordersOk = false;
    ordersError = errMsg(err);
  }

  // Order book -> pricing anchor (exclude our own orders) + recover our fill.
  // Ownership is by ledger id OR pool-worker adoption, so exclude the actual
  // reconciled owned ids (a superset of knownOrderIds) from the anchor - a
  // pool-adopted order not yet in the ledger must not be mistaken for the
  // marginal we're trying to beat.
  const ownedIds = new Set<string>(deps.knownOrderIds);
  for (const o of owned) ownedIds.add(o.order_id);

  let market: MarketAnchor | null = null;
  let marketError: string | null = null;
  try {
    const book = await service.getOrderBook(config.algorithm, deps.currency);
    // Bound the reported "next filled tier" at the same ceiling decide() will bid
    // under, so a distant book jump above the cap never charts (or anchors) a price
    // we could never actually pay - it collapses onto the cap instead.
    const capBtc = effectiveCapBtc(config, deps.hashprice ?? null);
    market = marketAnchorFromBook(
      book,
      config.target_speed_units,
      ownedIds,
      deps.currency,
      config.price_down_step_btc,
      capBtc,
    );

    // The myOrders LIST and per-order detail both under-report delivered speed
    // (often 0 even while filling). Our order's own row in the order book carries
    // the real acceptedSpeed + rigsCount NiceHash shows the operator, so cross-
    // reference it and take the larger reading - this is what makes the dashboard
    // reflect a fill the operator can see on NiceHash.
    const fills = ownOrderFillsFromBook(book, ownedIds, deps.currency);
    if (fills.size > 0) {
      owned = owned.map((o) => {
        const f = fills.get(o.order_id);
        if (!f) return o;
        return {
          ...o,
          accepted_speed_units: Math.max(o.accepted_speed_units, f.accepted_speed_units),
          rigs_count: Math.max(o.rigs_count ?? 0, f.rigs_count),
        };
      });
    }
  } catch (err) {
    marketError = errMsg(err); // market stays null
  }

  // Available balance.
  let balanceBtc: number | null = null;
  try {
    const bal = await service.getAccountBalance(deps.balanceCurrency);
    balanceBtc = availableBtcFromBalance(bal);
  } catch {
    /* leave balanceBtc null on failure */
  }

  // Walk-up grace bookkeeping: stamp each owned order with when it most recently
  // went under-filled (delivered below target x min-fill%), tracked across ticks
  // in the controller-owned map. Set on the transition into under-fill, cleared
  // when it reaches the threshold (the controller also resets it on a walk-up).
  // decide() uses this to hold off climbing the price until the grace elapses.
  const graceMap = deps.underFilledSinceById;
  if (graceMap) {
    const fillThreshold = (config.target_speed_units * (config.min_fill_pct ?? 100)) / 100;
    const ownedIds = new Set(owned.map((o) => o.order_id));
    for (const id of [...graceMap.keys()]) if (!ownedIds.has(id)) graceMap.delete(id);
    owned = owned.map((o) => {
      if (fillThreshold <= 0 || o.accepted_speed_units >= fillThreshold) {
        graceMap.delete(o.order_id);
        return { ...o, under_filled_since: null };
      }
      if (!graceMap.has(o.order_id)) graceMap.set(o.order_id, tickAt);
      return { ...o, under_filled_since: graceMap.get(o.order_id) ?? null };
    });
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
    market_error: marketError,
    orders_error: ordersError,
  };
}

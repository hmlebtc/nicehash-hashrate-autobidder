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

/** Default escalation-ladder step (BTC/unit/day) when the config omits it. */
export const DEFAULT_ESCALATION_STEP_BTC = 0.0002;
/** Default escalation-ladder interval (seconds) when the config omits it. */
export const DEFAULT_ESCALATION_INTERVAL_SECONDS = 60;
/**
 * Default NiceHash price-decrease cooldown: 10 minutes. Lives here (tick.ts
 * re-exports it) because the escalation ladder's DECAY pacing must match the
 * gate's decrease throttle - decaying faster than walk-downs can execute would
 * drain the offset to zero during one cooldown window and snap the released
 * walk-down to the floor.
 */
export const DEFAULT_PRICE_DECREASE_COOLDOWN_MS = 10 * 60_000;

/**
 * Per-order escalation-ladder state, owned by the controller across ticks (in
 * memory, like the under-filled-since map). `offsetBtc` is the RAW offset above
 * the normal floor (anchor + overpay) the ladder has climbed to; `decide()`
 * clamps it to the room under the effective cap at use. `lastStepAt` paces the
 * ladder (one move per escalation interval, up or down).
 */
export interface EscalationEntry {
  readonly offsetBtc: number;
  readonly lastStepAt: number;
}

/**
 * One escalation-ladder update for a single order - the pure rule behind the
 * escalate-toward-the-cap behavior:
 *
 *   - Under-filled with room left under the cap:
 *       - the FIRST step (offset 0) waits for the walk-up grace, then
 *         fast-starts to clamp(max(step, avgPaying − floor), 0, room) - jump
 *         toward the book's average paying price. The grace gates only this
 *         ENTRY: give the market the full grace to fill at the normal floor
 *         price before paying more.
 *       - later steps add `stepBtc` once per `intervalMs`, paced by the
 *         interval ALONE - each executed raise resets the grace, so requiring
 *         it per step would throttle the ladder to max(grace, interval).
 *   - Filled (delivery at/above the fill threshold): decay one step per
 *     `decayIntervalMs` = max(interval, NiceHash decrease cooldown), probing
 *     back down toward the cheapest price that still fills - never snapping to
 *     the floor. Decay paces on the cooldown so the state never races ahead of
 *     what the gate will execute: decaying every interval while walk-downs are
 *     cooldown-blocked would drain the offset to zero and land the released
 *     walk-down on the floor, re-losing the fill.
 *   - Otherwise (entry grace running, interval not elapsed, offset at room):
 *     hold.
 *
 * Returns the next entry, or null when the ladder is empty (offset 0) or the
 * feature is off (walk-up disabled drops the ladder entirely).
 */
export function nextEscalation(args: {
  readonly prev: EscalationEntry | undefined;
  readonly now: number;
  readonly walkUpEnabled: boolean;
  readonly underFilled: boolean;
  readonly gracePassed: boolean;
  /** Ladder step (BTC/unit/day), > 0. */
  readonly stepBtc: number;
  /** Minimum ms between upward ladder moves (raises are unthrottled). */
  readonly intervalMs: number;
  /**
   * Minimum ms between downward ladder moves. Callers pass
   * max(intervalMs, price-decrease cooldown) so decay never outruns the
   * executable walk-downs.
   */
  readonly decayIntervalMs: number;
  /** Headroom above the floor: max(0, effectiveCap − (anchor + overpay)). */
  readonly room: number;
  /** Book's average paying price minus the floor, or null when unavailable. */
  readonly avgAboveFloor: number | null;
}): EscalationEntry | null {
  const { prev, now, stepBtc, intervalMs, decayIntervalMs, room } = args;
  if (!args.walkUpEnabled) return null;
  const offset = prev?.offsetBtc ?? 0;
  const lastStepAt = prev?.lastStepAt ?? 0;

  if (args.underFilled && offset < room) {
    if (offset === 0) {
      // Entry is grace-gated; once engaged, steps pace on the interval alone.
      if (!args.gracePassed) return prev ?? null;
      // Fast-start: jump toward the average paying price (at least one step),
      // bounded by the room so the target never exceeds the cap.
      const fast = Math.min(Math.max(stepBtc, args.avgAboveFloor ?? stepBtc), room);
      return { offsetBtc: Math.max(0, fast), lastStepAt: now };
    }
    if (now - lastStepAt >= intervalMs) {
      return { offsetBtc: offset + stepBtc, lastStepAt: now };
    }
    return prev ?? null;
  }

  if (!args.underFilled && offset > 0 && now - lastStepAt >= decayIntervalMs) {
    const next = Math.max(0, offset - stepBtc);
    return next > 0 ? { offsetBtc: next, lastStepAt: now } : null;
  }

  return prev ?? null;
}

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
  /**
   * Mutable per-order escalation-ladder state, owned by the controller across
   * ticks (in memory, like `underFilledSinceById`). observe() advances it each
   * tick via {@link nextEscalation} (fast-start / step up while under-filled
   * past the grace, decay while filled) and stamps each owned order's
   * `escalation_offset_btc`. Unlike the grace map, the controller does NOT
   * reset entries on a walk-up - the ladder must survive its own raises.
   */
  readonly escalationByOrderId?: Map<string, EscalationEntry>;
  /**
   * Minimum time between price decreases on a single order (ms) - the SAME
   * value the tick pipeline hands the gate. The escalation ladder's decay
   * paces on max(escalation interval, this), so state decay never outruns the
   * walk-downs the gate will actually allow. Defaults to
   * {@link DEFAULT_PRICE_DECREASE_COOLDOWN_MS} when absent (as in tick.ts).
   */
  readonly priceDecreaseCooldownMs?: number;
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
  // Skipped entirely when the my-orders read FAILED: `owned` is empty then, and
  // pruning per-order state for orders we merely failed to SEE would wipe live
  // grace timestamps (and the escalation ladder below) on a single API blip.
  // Prune only when the read succeeded and the order is genuinely absent.
  const graceMap = deps.underFilledSinceById;
  if (graceMap && ordersOk) {
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

  // Escalation-ladder bookkeeping: advance each owned order's offset above the
  // floor (fast-start / step up while under-filled, decay while filled) and
  // stamp it on the snapshot for decide(). Pruned alongside the grace map when
  // the orders read succeeded and an order is genuinely absent - NEVER on a
  // failed read (the order still sits at its escalated price on NiceHash, and
  // wiping the offset would walk the bid back to the floor over one API blip).
  // The ladder only moves on a tick that can actually price (anchor present;
  // premium cap not blinded by a missing hashprice - mirrors decide()'s
  // guards); otherwise it freezes.
  const escMap = deps.escalationByOrderId;
  if (escMap && ordersOk) {
    const escOwnedIds = new Set(owned.map((o) => o.order_id));
    for (const id of [...escMap.keys()]) if (!escOwnedIds.has(id)) escMap.delete(id);

    const hashprice = deps.hashprice ?? null;
    const canPrice =
      market !== null &&
      market.anchor_price_btc !== null &&
      !(config.max_overpay_vs_hashprice_btc_per_unit_day !== null && hashprice === null);

    if (canPrice) {
      // Same floor decide() tracks: (next tier | marginal) + overpay, and the
      // same effective cap. room = the headroom the ladder may climb into.
      const cap = effectiveCapBtc(config, hashprice);
      const marginal = market!.anchor_price_btc!;
      const ladder = market!.filled_prices ?? [];
      const nextTier = ladder.length > 1 ? ladder[1]! : null;
      const anchor = config.anchor_next_filled_tier && nextTier !== null ? nextTier : marginal;
      const floor = anchor + config.overpay_btc_per_unit_day;
      const room = Math.max(0, cap - floor);
      const avg = market!.avg_price_btc;
      const avgAboveFloor = avg != null && Number.isFinite(avg) ? avg - floor : null;
      const fillThreshold = (config.target_speed_units * (config.min_fill_pct ?? 100)) / 100;
      const graceMs = Math.max(0, (config.walk_up_grace_seconds ?? 0) * 1000);
      const stepBtc = Math.max(0.0001, config.escalation_step_btc ?? DEFAULT_ESCALATION_STEP_BTC);
      const intervalMs =
        Math.max(5, Math.round(config.escalation_interval_seconds ?? DEFAULT_ESCALATION_INTERVAL_SECONDS)) * 1000;
      // Decay paces on the decrease cooldown when it is longer than the
      // interval - one probe step per executable walk-down window.
      const decayIntervalMs = Math.max(
        intervalMs,
        deps.priceDecreaseCooldownMs ?? DEFAULT_PRICE_DECREASE_COOLDOWN_MS,
      );

      for (const o of owned) {
        const underFilled = fillThreshold > 0 && o.accepted_speed_units < fillThreshold;
        const gracePassed =
          graceMs === 0 ||
          (o.under_filled_since != null && tickAt - o.under_filled_since >= graceMs);
        const next = nextEscalation({
          prev: escMap.get(o.order_id),
          now: tickAt,
          walkUpEnabled: config.walk_up_enabled ?? false,
          underFilled,
          gracePassed,
          stepBtc,
          intervalMs,
          decayIntervalMs,
          room,
          avgAboveFloor,
        });
        if (next) escMap.set(o.order_id, next);
        else escMap.delete(o.order_id);
      }
    }
    owned = owned.map((o) => ({
      ...o,
      escalation_offset_btc: escMap.get(o.order_id)?.offsetBtc ?? 0,
    }));
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

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

import { computeMarketAnchor } from './orderbook.js';
import { effectiveCapBtc } from './types.js';
import type { MarketAnchor, NiceHashControllerConfig, NiceHashState, RunMode } from './types.js';
import {
  availableBtcFromBalance,
  competingOrdersFromBook,
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

/** How many consecutive zero-rig book reads confirm a row as a run-breaker. */
export const ZERO_RIG_CONFIRM_READS = 2;
/** How many consecutive ticks an upward tier move must hold before exposure. */
export const TIER_UP_CONFIRM_TICKS = 2;

/**
 * Cross-tick zero-rig-confirmation state, owned by the controller. The map
 * counts consecutive successful book reads at rigs=0 per competitor order id;
 * `primed` distinguishes a genuine cold start from a book that simply has no
 * zero rows. On the FIRST successful read after a restart every zero row is
 * seeded as already-CONFIRMED, so that read reproduces the strict
 * (pre-smoothing) tier exactly - treating restart zeros as unconfirmed would
 * collapse the tier toward the marginal for one tick and could trigger a
 * spurious walk-down out of the filled block. From the second read onward,
 * newly-sighted zero rows get the normal one-read transparency.
 */
export interface ZeroRigStreakState {
  primed: boolean;
  readonly streakByOrderId: Map<string, number>;
}

/** A fresh (unprimed) zero-rig streak state - the controller's initial value. */
export function initialZeroRigStreaks(): ZeroRigStreakState {
  return { primed: false, streakByOrderId: new Map() };
}

/**
 * Cross-tick state for the next-tier upward hysteresis, owned by the
 * controller (in memory; a restart just re-primes from the first successful
 * read). `accepted` is the tier everything downstream sees; an upward raw move
 * sits in `pending` until it has held for {@link TIER_UP_CONFIRM_TICKS}
 * consecutive successful ticks. Downward moves apply instantly.
 */
export interface TierHysteresisState {
  primed: boolean;
  accepted: number | null;
  pending: number | null;
  pendingCount: number;
}

/** A fresh (unprimed) hysteresis state - the controller's initial value. */
export function initialTierHysteresis(): TierHysteresisState {
  return { primed: false, accepted: null, pending: null, pendingCount: 0 };
}

/**
 * One hysteresis step for the (already zero-debounced) raw next tier of a
 * SUCCESSFUL book read - never call this for a failed read (the state must
 * freeze then). Pure: returns the next state and the tier to expose.
 *
 *   - Cold start: the first successful read is accepted as-is.
 *   - Equal or DOWNWARD (including value -> null): accepted instantly; a
 *     falling tier is the cost-safe direction and must never lag.
 *   - UPWARD (including null -> value): held in `pending`; accepted only after
 *     the raw tier has agreed at-or-above the pending value for
 *     {@link TIER_UP_CONFIRM_TICKS} consecutive ticks. A raw value that is
 *     still above `accepted` but below `pending` re-arms the pending at the
 *     lower value (conservative).
 */
export function applyTierHysteresis(
  state: TierHysteresisState,
  rawTier: number | null,
): { readonly next: TierHysteresisState; readonly tier: number | null } {
  if (!state.primed) {
    return { next: { primed: true, accepted: rawTier, pending: null, pendingCount: 0 }, tier: rawTier };
  }
  const accepted = state.accepted;
  const isUp = rawTier !== null && (accepted === null || rawTier > accepted);
  if (!isUp) {
    // Equal or downward (value -> null included): accept instantly.
    return { next: { primed: true, accepted: rawTier, pending: null, pendingCount: 0 }, tier: rawTier };
  }
  if (state.pending !== null && rawTier >= state.pending) {
    const count = state.pendingCount + 1;
    if (count >= TIER_UP_CONFIRM_TICKS) {
      return {
        next: { primed: true, accepted: state.pending, pending: null, pendingCount: 0 },
        tier: state.pending,
      };
    }
    return { next: { ...state, pendingCount: count }, tier: accepted };
  }
  // New (or lowered) upward candidate: first tick of agreement.
  return { next: { primed: true, accepted, pending: rawTier, pendingCount: 1 }, tier: accepted };
}

/**
 * One escalation-ladder update for a single order - the pure rule behind the
 * escalate-toward-the-cap behavior:
 *
 *   - Under-filled with room left under the cap, once the walk-up grace has
 *     passed:
 *       - the FIRST step (offset 0) starts the ladder at exactly ONE step
 *         above the floor (min(step, room)). No market-hint jump - the ladder
 *         never pays more than it has proven necessary, one step at a time.
 *       - later steps add `stepBtc` once per `intervalMs`.
 *     The grace is EPISODE-based: it gates entry into escalation and re-entry
 *     after a filled spell drops back under-filled (`under_filled_since`
 *     re-stamps on that transition), but never paces steps within a
 *     continuous under-filled episode - the controller does not reset the
 *     grace clock on the ladder's own raises, so mid-episode `gracePassed`
 *     stays true and the interval alone paces the climb.
 *   - Filled (delivery at/above the fill threshold): step DOWN by
 *     `decayStepBtc` - the FULL NiceHash per-move decrease limit
 *     (price_down_step, ~0.002) - once per `decayIntervalMs` = max(interval,
 *     NiceHash decrease cooldown). Operator rule: take the maximum step down
 *     each window until the target sits just above the next filled tier (the
 *     floor); if a full step overshoots the price miners accept, the fast
 *     re-climb (one interval + episode grace) is the safety net. Decay paces
 *     on the cooldown so the state never races ahead of what the gate will
 *     execute: decaying every interval while walk-downs are cooldown-blocked
 *     would drain the offset before the first walk-down could land.
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
  /**
   * Size of one DOWNWARD ladder move (BTC/unit/day). Callers pass
   * max(stepBtc, price_down_step_btc) - the full NiceHash per-move decrease
   * limit, never smaller than one escalation step.
   */
  readonly decayStepBtc: number;
  /** Headroom above the floor: max(0, effectiveCap − (anchor + overpay)). */
  readonly room: number;
}): EscalationEntry | null {
  const { prev, now, stepBtc, intervalMs, decayIntervalMs, decayStepBtc, room } = args;
  if (!args.walkUpEnabled) return null;
  const offset = prev?.offsetBtc ?? 0;
  const lastStepAt = prev?.lastStepAt ?? 0;

  if (args.underFilled && offset < room) {
    // Episode-based grace: gates entry AND re-entry after a filled spell (the
    // under-filled clock re-stamps on the filled -> under-filled transition).
    // Mid-episode it is vacuously true - ladder raises don't reset the clock.
    if (!args.gracePassed) return prev ?? null;
    if (offset === 0) {
      // Start the ladder at exactly one step above the floor, bounded by the
      // room so the target never exceeds the cap.
      return { offsetBtc: Math.min(stepBtc, room), lastStepAt: now };
    }
    if (now - lastStepAt >= intervalMs) {
      return { offsetBtc: offset + stepBtc, lastStepAt: now };
    }
    return prev ?? null;
  }

  if (!args.underFilled && offset > 0 && now - lastStepAt >= decayIntervalMs) {
    const next = Math.max(0, offset - decayStepBtc);
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
   * also resets an entry on a plain floor-tracking walk-up (each new price gets a
   * fresh grace window) - but not on the escalation ladder's own raises
   * (episode-based grace). Drives the walk-up grace period in decide().
   */
  readonly underFilledSinceById?: Map<string, number>;
  /**
   * Mutable per-order escalation-ladder state, owned by the controller across
   * ticks (in memory, like `underFilledSinceById`). observe() advances it each
   * tick via {@link nextEscalation} (step up while under-filled past the
   * grace, decay while filled) and stamps each owned order's
   * `escalation_offset_btc`. Unlike the grace map, the controller does NOT
   * reset entries on a walk-up - the ladder must survive its own raises.
   */
  readonly escalationByOrderId?: Map<string, EscalationEntry>;
  /**
   * Mutable per-order "decrease available at" clock (epoch ms), owned by the
   * controller across ticks - when NiceHash will next accept a price DECREASE.
   * The controller arms it on every executed price change and overwrites it
   * from NiceHash's own "Seconds till available" answer on a 5061 rejection
   * (the API is the source of truth). observe() stamps it on each owned
   * order's `decrease_available_at` for the gate and the hold explainer, and
   * prunes entries for orders that disappeared (successful reads only).
   */
  readonly decreaseAvailableAtByOrderId?: Map<string, number>;
  /**
   * Mutable per-order change-SETTLE clock (epoch ms) - when NiceHash will next
   * accept ANY price/limit edit (error 5110, seconds-scale, raises included).
   * Armed by the controller purely from NiceHash's "Seconds till available"
   * 5110 answers. observe() stamps it on each owned order's
   * `edit_available_at` for the gate and the hold explainer, and prunes
   * entries for orders that disappeared (successful reads only).
   */
  readonly editAvailableAtByOrderId?: Map<string, number>;
  /**
   * Mutable per-BOOK-row zero-rig streak state, keyed by competitor order id,
   * owned by the controller across ticks. On every SUCCESSFUL book read (never
   * on a failed one) observe() bumps the streak of each alive rigs=0 row,
   * resets it on rigs>0, and prunes ids that left the book. Rows whose streak
   * is still below {@link ZERO_RIG_CONFIRM_READS} are passed to
   * `computeMarketAnchor` as unconfirmed zeros - transparent to the next-tier
   * contiguity scan. The first successful read after restart seeds zeros as
   * already-confirmed (strict), see {@link ZeroRigStreakState}. Probe-verified
   * remedy for one-read rig-count flicker and 30-90s new-order
   * miner-migration windows.
   */
  readonly zeroRigStreakState?: ZeroRigStreakState;
  /**
   * Mutable upward-hysteresis state for the exposed next tier, owned by the
   * controller across ticks. Advanced via {@link applyTierHysteresis} only on
   * successful book reads; frozen otherwise. The accepted (smoothed) tier is
   * the ONE value everywhere: rewritten into `market.filled_prices`, so
   * decide(), the metrics rows and the dashboard all see the same number.
   */
  readonly tierHysteresisState?: TierHysteresisState;
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
    const { competitors, totalSpeedUnits } = competingOrdersFromBook(book, deps.currency, ownedIds);

    // Zero-rig confirmation streaks: bump/reset/prune per alive competitor row
    // on this SUCCESSFUL book read (a failed read never reaches this code, so
    // streaks freeze exactly like the other cross-tick maps). Rows still below
    // ZERO_RIG_CONFIRM_READS consecutive zero reads are handed to the anchor
    // computation as unconfirmed - they don't break the next-tier run yet.
    // Cold start (first successful read after restart, `primed` false): every
    // zero row is seeded as already-confirmed so this read reproduces the
    // strict tier exactly - unconfirmed-everything would collapse the tier
    // toward the marginal and could walk the bid down out of the filled block.
    // Also frozen when the my-orders read failed (ordersOk discipline, like
    // every other cross-tick map): the market is discarded below anyway, and
    // with `owned` unknown a pool-adopted own order may leak into the
    // competitor set - never let that poison the streaks (or prime the state).
    let unconfirmedZeroIds: ReadonlySet<string> = new Set<string>();
    const streaks = ordersOk ? deps.zeroRigStreakState : undefined;
    if (streaks) {
      const map = streaks.streakByOrderId;
      const seed = streaks.primed ? 1 : ZERO_RIG_CONFIRM_READS;
      const present = new Set<string>();
      const unconfirmed = new Set<string>();
      for (const c of competitors) {
        if (c.id === undefined) continue; // untrackable: stays strict
        present.add(c.id);
        if ((c.rigs_count ?? 0) > 0) {
          map.delete(c.id); // any rigs>0 read resets the streak (downward-friendly)
        } else {
          const prev = map.get(c.id);
          const n = prev !== undefined ? prev + 1 : seed;
          map.set(c.id, n);
          if (n < ZERO_RIG_CONFIRM_READS) unconfirmed.add(c.id);
        }
      }
      for (const id of [...map.keys()]) if (!present.has(id)) map.delete(id);
      streaks.primed = true;
      unconfirmedZeroIds = unconfirmed;
    }

    market = computeMarketAnchor(
      competitors,
      totalSpeedUnits,
      config.target_speed_units,
      unconfirmedZeroIds,
    );

    // Upward tier hysteresis: the tier decide()/metrics/dashboard consume only
    // rises after the (debounced) raw tier has held at-or-above the new value
    // for TIER_UP_CONFIRM_TICKS consecutive successful ticks; falls apply
    // instantly. One value everywhere: the smoothed tier is rewritten into
    // filled_prices, so there is no separate raw-vs-smoothed view downstream.
    // Frozen (neither advanced nor reset) when the my-orders read failed: the
    // market snapshot is discarded below, so that tick never counts toward -
    // or against - an upward confirmation.
    const hyst = ordersOk ? deps.tierHysteresisState : undefined;
    if (hyst) {
      const rawTier = market.filled_prices?.[1] ?? null;
      const { next, tier } = applyTierHysteresis(hyst, rawTier);
      Object.assign(hyst, next);
      // A held-back accepted tier can go stale against a marginal that has
      // since risen to meet it. The raw scan guarantees tier > marginal, so
      // the exposed (smoothed) tier must keep that invariant too - otherwise
      // drop it for this tick and let the anchor fall back to the marginal.
      const anchor = market.anchor_price_btc;
      const exposed = tier !== null && anchor !== null && tier > anchor ? tier : null;
      if (exposed !== rawTier && anchor !== null) {
        market = {
          ...market,
          filled_prices: exposed !== null ? [anchor, exposed] : [anchor],
        };
      }
    }

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
  // floor (step up while under-filled, decay while filled) and
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
      const fillThreshold = (config.target_speed_units * (config.min_fill_pct ?? 100)) / 100;
      const graceMs = Math.max(0, (config.walk_up_grace_seconds ?? 0) * 1000);
      const stepBtc = Math.max(0.0001, config.escalation_step_btc ?? DEFAULT_ESCALATION_STEP_BTC);
      const intervalMs =
        Math.max(5, Math.round(config.escalation_interval_seconds ?? DEFAULT_ESCALATION_INTERVAL_SECONDS)) * 1000;
      // Decay paces on the decrease cooldown when it is longer than the
      // interval - one down-move per executable walk-down window - and each
      // down-move takes the FULL NiceHash per-move decrease limit (operator
      // rule: max step down until just above the next filled tier; the fast
      // re-climb recovers if a full step overshoots). Never smaller than one
      // escalation step, so a tiny/absent price_down_step still decays.
      const decayIntervalMs = Math.max(
        intervalMs,
        deps.priceDecreaseCooldownMs ?? DEFAULT_PRICE_DECREASE_COOLDOWN_MS,
      );
      const decayStepBtc = Math.max(stepBtc, config.price_down_step_btc ?? 0);

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
          decayStepBtc,
          room,
        });
        if (next) escMap.set(o.order_id, next);
        else escMap.delete(o.order_id);
      }
    }
    owned = owned.map((o) => ({
      ...o,
      escalation_offset_btc: escMap.get(o.order_id)?.offsetBtc ?? 0,
      escalation_last_step_at: escMap.get(o.order_id)?.lastStepAt ?? null,
    }));
  }

  // API-truth decrease-cooldown clock: stamp each owned order with when
  // NiceHash will next accept a price decrease (armed by the controller on
  // executed price changes, resynced from 5061 "Seconds till available"
  // answers). Pruned like the other per-order maps - only on a successful
  // orders read with the order genuinely absent.
  const availMap = deps.decreaseAvailableAtByOrderId;
  if (availMap && ordersOk) {
    const availOwnedIds = new Set(owned.map((o) => o.order_id));
    for (const id of [...availMap.keys()]) if (!availOwnedIds.has(id)) availMap.delete(id);
    owned = owned.map((o) => ({
      ...o,
      decrease_available_at: availMap.get(o.order_id) ?? null,
    }));
  }

  // Change-SETTLE clock (5110): stamp when NiceHash will next accept ANY
  // price/limit edit on each owned order. Same lifecycle as the decrease
  // clock above - pruned only on a successful orders read.
  const editMap = deps.editAvailableAtByOrderId;
  if (editMap && ordersOk) {
    const editOwnedIds = new Set(owned.map((o) => o.order_id));
    for (const id of [...editMap.keys()]) if (!editOwnedIds.has(id)) editMap.delete(id);
    owned = owned.map((o) => ({
      ...o,
      edit_available_at: editMap.get(o.order_id) ?? null,
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

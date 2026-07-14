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
import type { CompetingOrder, MarketAnchor, NiceHashControllerConfig, NiceHashState, RunMode } from './types.js';
import {
  availableBtcFromBalance,
  competingOrdersFromBook,
  ownOrderFillsFromBook,
  reconcileOrders,
} from './wire.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import type {
  NiceHashBookDebounceState,
  NiceHashBookSnapshot,
} from '../../state/repos/nicehash_book_snapshots.js';

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
/**
 * How many consecutive rigs>0 reads a CONFIRMED-ZERO row needs before it stops
 * breaking the run - the symmetric side of the debounce (rig flicker goes both
 * ways; the probe showed rows flip 0 -> ~20 for one read with speed 0 on both
 * sides, which would otherwise collapse the tier to the marginal instantly).
 */
export const NONZERO_RIG_CONFIRM_READS = 2;
/** How many consecutive ticks an upward tier move must hold before exposure. */
export const TIER_UP_CONFIRM_TICKS = 2;

/**
 * Per-competitor-row debounce state: a tiny two-counter state machine.
 *
 *   - A row is tracked only while its zero side is engaged; a plainly filled
 *     row has no entry.
 *   - `zeroReads` counts consecutive reads at rigs=0. At
 *     {@link ZERO_RIG_CONFIRM_READS} the zero is CONFIRMED (a run-breaker).
 *   - `nonzeroReads` counts consecutive rigs>0 reads on a CONFIRMED-zero row
 *     (recovery). While recovering the row is STILL a breaker; at
 *     {@link NONZERO_RIG_CONFIRM_READS} the entry is dropped (row is filled).
 *   - Contra-streaks reset on each opposing read: a zero read during recovery
 *     re-arms the confirmed-zero state (nonzeroReads back to 0); a nonzero
 *     read on a not-yet-confirmed zero drops the entry immediately (fresh
 *     rows and normal orders count filled with no delay).
 */
export interface RowDebounce {
  zeroReads: number;
  nonzeroReads: number;
}

/**
 * Cross-tick per-row debounce state, owned by the controller. Keyed by
 * competitor order id; `primed` distinguishes a genuine cold start from a
 * book that simply has no zero rows. On the FIRST successful read after a
 * restart every zero row is seeded as already-CONFIRMED, so that read
 * reproduces the strict (pre-smoothing) tier exactly - treating restart zeros
 * as unconfirmed would collapse the tier toward the marginal for one tick and
 * could trigger a spurious walk-down out of the filled block. From the second
 * read onward, newly-sighted zero rows get the normal one-read transparency.
 */
export interface ZeroRigStreakState {
  primed: boolean;
  readonly rowsByOrderId: Map<string, RowDebounce>;
}

/** A fresh (unprimed) zero-rig streak state - the controller's initial value. */
export function initialZeroRigStreaks(): ZeroRigStreakState {
  return { primed: false, rowsByOrderId: new Map() };
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
   * Mutable per-BOOK-row rig-count debounce state, keyed by competitor order
   * id, owned by the controller across ticks. On every SUCCESSFUL book read
   * (never on a failed one) observe() advances each alive row's
   * {@link RowDebounce} state machine and prunes ids that left the book.
   * Zero side: rows below {@link ZERO_RIG_CONFIRM_READS} consecutive zero
   * reads are passed to `computeMarketAnchor` as unconfirmed zeros -
   * transparent to the next-tier contiguity scan. Nonzero side (symmetric):
   * confirmed-zero rows reading rigs>0 stay run-breakers until
   * {@link NONZERO_RIG_CONFIRM_READS} consecutive nonzero reads. The first
   * successful read after restart seeds zeros as already-confirmed (strict),
   * see {@link ZeroRigStreakState}. Probe-verified remedy for two-way
   * rig-count flicker and 30-90s new-order miner-migration windows.
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
   * Order-book capture sink (the dashboard "Order book" tab + CSV export).
   * Called once per SUCCESSFUL tick (both reads ok) with the full alive
   * competitor book, each row stamped with its current debounce state, plus
   * the marginal and the strict/smoothed tier readings. The controller
   * persists the payload after the tick (best-effort); observe itself never
   * touches storage.
   */
  readonly onBookCapture?: (snapshot: NiceHashBookSnapshot) => void;
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

    // Per-row rig-count debounce: advance the per-row state machine on this
    // SUCCESSFUL book read (a failed read never reaches this code, so the
    // state freezes exactly like the other cross-tick maps). Zero side: a
    // rigs=0 row breaks the next-tier run only after ZERO_RIG_CONFIRM_READS
    // consecutive zero reads. Nonzero side (symmetric): a CONFIRMED-zero row
    // reading rigs>0 stays a breaker until NONZERO_RIG_CONFIRM_READS
    // consecutive nonzero reads - a one-read nonzero flicker can no longer
    // collapse the tier to the marginal (the operator's cyan-line gaps).
    // Cold start (first successful read after restart, `primed` false): every
    // zero row is seeded as already-confirmed so this read reproduces the
    // strict tier exactly - unconfirmed-everything would collapse the tier
    // toward the marginal and could walk the bid down out of the filled block.
    // Also frozen when the my-orders read failed (ordersOk discipline, like
    // every other cross-tick map): the market is discarded below anyway, and
    // with `owned` unknown a pool-adopted own order may leak into the
    // competitor set - never let that poison the streaks (or prime the state).
    let unconfirmedZeroIds: ReadonlySet<string> = new Set<string>();
    let unconfirmedNonzeroIds: ReadonlySet<string> = new Set<string>();
    // Dust rows (0 < limit < threshold; limit 0 = uncapped, never dust) are
    // fully transparent to the run scan, so they need no debounce tracking -
    // skipped below, which also prunes any stale entry for a row that shrank
    // into dust.
    const dustLimit = Math.max(0, config.dust_limit_units ?? 0);
    const isDustRow = (c: CompetingOrder): boolean =>
      dustLimit > 0 && c.limit_units > 0 && c.limit_units < dustLimit;
    const streaks = ordersOk ? deps.zeroRigStreakState : undefined;
    if (streaks) {
      const map = streaks.rowsByOrderId;
      const seed = streaks.primed ? 1 : ZERO_RIG_CONFIRM_READS;
      const present = new Set<string>();
      const uZero = new Set<string>();
      const uNonzero = new Set<string>();
      for (const c of competitors) {
        if (c.id === undefined) continue; // untrackable: stays strict
        if (isDustRow(c)) continue; // dust: invisible to the scan, nothing to track
        present.add(c.id);
        const row = map.get(c.id);
        if ((c.rigs_count ?? 0) > 0) {
          if (!row) continue; // plainly filled row: nothing to track
          if (row.zeroReads < ZERO_RIG_CONFIRM_READS) {
            map.delete(c.id); // unconfirmed zero -> filled immediately (fresh rows)
            continue;
          }
          // Confirmed-zero row reading nonzero: recovery needs confirmation.
          row.nonzeroReads += 1;
          if (row.nonzeroReads >= NONZERO_RIG_CONFIRM_READS) map.delete(c.id);
          else uNonzero.add(c.id); // still a breaker this read
        } else if (row) {
          row.zeroReads += 1;
          row.nonzeroReads = 0; // a zero read re-arms confirmed-zero cleanly
          if (row.zeroReads < ZERO_RIG_CONFIRM_READS) uZero.add(c.id);
        } else {
          map.set(c.id, { zeroReads: seed, nonzeroReads: 0 });
          if (seed < ZERO_RIG_CONFIRM_READS) uZero.add(c.id);
        }
      }
      for (const id of [...map.keys()]) if (!present.has(id)) map.delete(id);
      streaks.primed = true;
      unconfirmedZeroIds = uZero;
      unconfirmedNonzeroIds = uNonzero;
    }

    market = computeMarketAnchor(
      competitors,
      totalSpeedUnits,
      config.target_speed_units,
      unconfirmedZeroIds,
      unconfirmedNonzeroIds,
      dustLimit,
    );

    // Recovery ambiguity: when recovering rows are the only thing between two
    // different floor readings (the floor WITH the recovery breakers differs
    // from the floor WITHOUT them), this tick's reading is a flicker in
    // progress - it must neither advance the upward hysteresis (a recovery
    // tick would manufacture the 2nd "consecutive" elevated read and land the
    // very spike v0.6.54 suppressed) nor drop the floor (the gap the operator
    // saw). The hysteresis freezes and the previously accepted floor stays
    // exposed; once the views agree again (flicker resolved either way),
    // normal hysteresis resumes on the agreed value.
    const rawFloorHold = market.filled_prices?.[1] ?? null;
    let recoveryAmbiguous = false;
    if (unconfirmedNonzeroIds.size > 0) {
      const fresh = computeMarketAnchor(
        competitors,
        totalSpeedUnits,
        config.target_speed_units,
        unconfirmedZeroIds,
        new Set<string>(),
        dustLimit,
      );
      recoveryAmbiguous = (fresh.filled_prices?.[1] ?? null) !== rawFloorHold;
    }

    // Upward floor hysteresis: the floor anchor decide()/metrics/dashboard
    // consume only rises after the (debounced) raw floor has held at-or-above
    // the new value for TIER_UP_CONFIRM_TICKS consecutive successful ticks;
    // falls apply instantly. One value everywhere: the smoothed floor is
    // rewritten into filled_prices, so there is no separate raw-vs-smoothed
    // view downstream. Frozen (neither advanced nor reset) when the my-orders
    // read failed: the market snapshot is discarded below, so that tick never
    // counts toward - or against - an upward confirmation.
    const hyst = ordersOk ? deps.tierHysteresisState : undefined;
    if (hyst) {
      let tier: number | null;
      if (recoveryAmbiguous && hyst.primed) {
        tier = hyst.accepted; // freeze: no advance, no reset, expose as-is
      } else {
        const step = applyTierHysteresis(hyst, rawFloorHold);
        Object.assign(hyst, step.next);
        tier = step.tier;
      }
      // Exposure invariant (the anti-island rule, operator capture 2026-07-14
      // 17:18Z): while the market read succeeded, the exposed anchor must
      // never fall below the debounced run bottom via a fallback. Base value:
      // the accepted floor; when the hysteresis has no accepted value yet
      // (null->value confirmation window after an empty-book spell), expose
      // the CURRENT debounced run bottom rather than anything rawer - biasing
      // up before confirmation is the safe direction. Finally clamp UP to the
      // raw marginal: a stale accepted floor below a risen marginal would bid
      // under the purple (win nothing), while a marginal that DIPS (an
      // island/dust fill below the block) never drags the floor down because
      // max() keeps the higher value.
      const anchor = market.anchor_price_btc;
      if (anchor !== null) {
        const base = tier !== null ? tier : rawFloorHold;
        const exposed = base !== null && base > anchor ? base : anchor;
        if (exposed !== rawFloorHold) {
          market = { ...market, filled_prices: [anchor, exposed] };
        }
      }
    }

    // Order-book capture (the "Order book" tab + CSV export): hand the full
    // alive competitor book to the sink, each row stamped with its current
    // debounce state, alongside the STRICT floor (straight from the raw book -
    // no debounce, no hysteresis, no dust filter) and the exposed smoothed
    // floor. Same ordersOk guard as the smoothing state: on an orders-blind
    // tick the debounce state was frozen and the market is discarded, so a
    // snapshot would misrepresent what the bot saw.
    const capture = ordersOk ? deps.onBookCapture : undefined;
    if (capture) {
      const strict = computeMarketAnchor(competitors, totalSpeedUnits, config.target_speed_units);
      const rowState = (c: CompetingOrder): NiceHashBookDebounceState => {
        const zero = (c.rigs_count ?? 0) === 0;
        const entry = c.id !== undefined ? deps.zeroRigStreakState?.rowsByOrderId.get(c.id) : undefined;
        if (!entry) return zero ? 'confirmed_zero' : 'filled'; // untracked zeros are strict breakers
        if (!zero) return entry.nonzeroReads > 0 ? 'recovering_nonzero' : 'filled';
        return entry.zeroReads >= ZERO_RIG_CONFIRM_READS ? 'confirmed_zero' : 'unconfirmed_zero';
      };
      capture({
        ts: tickAt,
        marginal_price_btc: strict.anchor_price_btc,
        raw_tier_btc: strict.filled_prices?.[1] ?? null,
        smoothed_tier_btc: market.filled_prices?.[1] ?? null,
        rows: [...competitors]
          .sort((a, b) => b.price_btc - a.price_btc)
          .map((c) => ({
            id: c.id ?? null,
            price_btc: c.price_btc,
            limit_units: c.limit_units,
            rigs_count: c.rigs_count ?? null,
            accepted_speed_units: c.accepted_speed_units ?? null,
            debounce_state: rowState(c),
          })),
      });
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
      // Same floor decide() tracks: (floor anchor | marginal) + overpay, and
      // the same effective cap. room = the headroom the ladder may climb into.
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

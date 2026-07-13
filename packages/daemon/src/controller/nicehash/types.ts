/**
 * Domain types for the NiceHash control loop.
 *
 * These are deliberately decoupled from the NiceHash wire types in
 * `@hashrate-autopilot/nicehash-client`: prices/speeds here are already parsed
 * to numbers in canonical units (BTC per display-unit per day; speed in the
 * display unit, e.g. PH/s for SHA256). The mapping from wire responses to this
 * shape happens in `observe()`. Keeping `decide()` pure over plain numbers
 * makes the bidding logic exhaustively unit-testable without any HTTP/DB.
 */

export type RunMode = 'DRY_RUN' | 'LIVE' | 'PAUSED';

/** A competing BUY order resting in the NiceHash order book. */
export interface CompetingOrder {
  /** Price in BTC per price-display-unit per day (EH/day for SHA256 family). */
  readonly price_btc: number;
  /** Speed cap in speed-display units (PH/s). 0 means uncapped. */
  readonly limit_units: number;
  /**
   * Speed currently delivered to this order (PH/s). For an uncapped (limit 0)
   * order this is its real draw on supply; an uncapped order delivering 0 is
   * not actually consuming anything (e.g. an idle BUSINESS ceiling order).
   */
  readonly accepted_speed_units?: number;
  /**
   * Number of mining rigs currently delivering to this order (NiceHash's
   * "Miners" column). This is the reliable signal for whether an order is being
   * filled - the orderbook's per-order `accepted_speed_units` is sparsely
   * reported, but `rigs_count` matches the marginal (purple) price NiceHash
   * shows. 0 / undefined means the order is currently winning no hashrate.
   */
  readonly rigs_count?: number;
}

/**
 * The pricing anchor derived from a market's order book - the NiceHash
 * analogue of Braiins' `fillable_ask`. On NiceHash (buyer competition) it is
 * the marginal price the bidder must beat to get `target` speed delivered.
 */
export interface MarketAnchor {
  /** Marginal price to beat (BTC/unit/day), or null when undeterminable. */
  readonly anchor_price_btc: number | null;
  /** Total live deliverable speed available to this market (display units). */
  readonly total_speed_units: number;
  /**
   * True when the market can't deliver the full target at any price (supply <
   * target) - the anchor is then the highest competing price (best effort).
   */
  readonly thin: boolean;
  /**
   * Ascending prices of competitor orders currently being filled (have miners),
   * i.e. the "fill ladder". `anchor_price_btc` is its first (cheapest) entry.
   * The walk-up uses it to jump to just above the next filled tier above us
   * rather than a fixed step. Empty when nothing is being filled.
   */
  readonly filled_prices?: readonly number[];
  /**
   * Median price among the filled orders (the middle order receiving hashrate) -
   * a robust "typical" market price. Null when nothing is filled. Display only.
   */
  readonly median_price_btc?: number | null;
  /**
   * Speed-weighted average filled-order price: sum(price x speed) / sum(speed)
   * over the filled orders - the effective price per delivered EH, the closest
   * proxy to NiceHash's "Paying" rate. Falls back to the unweighted mean when no
   * delivered speed is reported. Null when nothing is filled. Display only.
   */
  readonly avg_price_btc?: number | null;
}

/** An order we consider our own, reconciled from `myOrders` against the ledger. */
export interface OwnedOrderSnapshot {
  readonly order_id: string;
  readonly price_btc: number;
  readonly limit_units: number;
  /** Total funds committed (BTC). */
  readonly amount_btc: number;
  /** Unspent escrow still in the order (BTC). */
  readonly available_amount_btc: number;
  /** Funds already spent by the order (BTC). */
  readonly payed_amount_btc: number;
  /** Currently delivered speed (display units); 0 when not delivering. */
  readonly accepted_speed_units: number;
  /**
   * Mining rigs currently delivering to this order (NiceHash's "Miners"
   * column), recovered from our order's own order-book row. 0 / undefined when
   * none. This is the reliable fill signal - `accepted_speed_units` from the
   * myOrders/detail endpoints under-reports, so the order book is cross-referenced
   * in `observe()` for both fields.
   */
  readonly rigs_count?: number;
  /**
   * Epoch ms when the order most recently became (and has since stayed)
   * under-filled - delivered below the fill threshold - or null when it is
   * currently filled. Reset when the bidder makes a plain floor-tracking raise
   * (each new price gets a fresh grace window) but NOT on the escalation
   * ladder's own raises - episode-based grace: the clock marks the start of the
   * under-filled episode and re-arms when fills drop again. Feeds the walk-up
   * grace period
   * ({@link NiceHashControllerConfig.walk_up_grace_seconds}): the bidder waits
   * this long under-filled before climbing. Tracked across ticks by the
   * controller (in memory), populated in `observe()`.
   */
  readonly under_filled_since?: number | null;
  /**
   * Raw escalation-ladder offset (BTC/unit/day) accumulated for this order -
   * how far above the normal floor (anchor + overpay) the bid is allowed to
   * escalate while persistently under-filled. Stamped by `observe()` from the
   * controller-owned escalation map; `decide()` clamps it to the room left
   * under the effective cap before adding it to the target. 0 / undefined =
   * no escalation. Unlike {@link under_filled_since}, this is NOT reset on a
   * walk-up - each raise must not restart the ladder.
   */
  readonly escalation_offset_btc?: number;
  /**
   * Epoch ms of the escalation ladder's last move (up or down) for this order,
   * stamped by `observe()` from the controller-owned map. Drives the "next
   * step / next probe down in m:ss" countdowns in the hold explainer. Null
   * when the ladder is not engaged.
   */
  readonly escalation_last_step_at?: number | null;
  /**
   * Epoch ms when NiceHash will next accept a price DECREASE on this order -
   * the API-truth cooldown clock. Armed by the controller on every executed
   * price change (NiceHash's rule is 10 min since ANY price change, raises
   * included) and OVERWRITTEN from NiceHash's own "Seconds till available"
   * answer whenever a decrease is rejected with error 5061 - the API's answer
   * always wins over anything we derive. Null when unknown (the gate then
   * falls back to the persisted last-change stamps).
   */
  readonly decrease_available_at?: number | null;
  /** NiceHash status code, e.g. ACTIVE / DEAD / CANCELLED / COMPLETED. */
  readonly status: string;
  /** The order's pool worker (stratum username); null when the API omits it. */
  readonly pool_username: string | null;
  readonly last_price_decrease_at: number | null;
  /** When the price last changed (up or down); null when never. Settle window. */
  readonly last_price_change_at: number | null;
}

/** An order in the account that is NOT in our ledger - forces PAUSE. */
export interface UnknownOrderSnapshot {
  readonly order_id: string;
  readonly price_btc: number;
}

export interface NiceHashControllerConfig {
  readonly market: string;
  readonly algorithm: string;
  /** Resolved registered pool id; empty string when not yet registered. */
  readonly pool_id: string;
  /**
   * The configured pool worker (stratum username, e.g. `<address>.autobidder`).
   * An order on the account is treated as the autobidder's own iff its
   * `pool.username` matches this - so the bot manages exactly one order (its
   * `.autobidder` worker) and leaves any other order on the account alone.
   * Empty string disables pool-worker matching (ledger-only ownership).
   */
  readonly pool_user: string;
  /** Desired delivered speed (display units). */
  readonly target_speed_units: number;
  /** Cushion added above the anchor (BTC/unit/day). */
  readonly overpay_btc_per_unit_day: number;
  /** Fixed safety ceiling on price (BTC/unit/day). */
  readonly max_price_btc_per_unit_day: number;
  /** Dynamic ceiling: hashprice + this. null disables it. */
  readonly max_overpay_vs_hashprice_btc_per_unit_day: number | null;
  /** Funds for a new order. 0 = use full available balance. */
  readonly order_budget_btc: number;
  /** Top-up amount per refill (BTC). */
  readonly refill_amount_btc: number;
  /** Refill when the order's remaining runway drops below this many hours. */
  readonly refill_when_runway_hours: number;
  /** NiceHash minimum order amount (BTC), from algorithm metadata. */
  readonly min_order_amount_btc: number;
  /**
   * Anchor on the *next filled tier* (the second rung of the fill ladder,
   * `MarketAnchor.filled_prices[1]`) instead of the marginal (cheapest filled,
   * `filled_prices[0]`). The marginal is the theoretical price to beat, but on a
   * thin/lumpy market bidding a hair above it often wins nothing - the market is
   * actually allocating hashrate one tier up. Tracking that tier + overpay places
   * the bid where fills really happen (still clamped by the cap). Falls back to
   * the marginal when there is no second tier. Default off (undefined) in the
   * pure controller; the daemon defaults it on. #tracks NiceHash cyan line.
   */
  readonly anchor_next_filled_tier?: boolean;
  /**
   * Track-to-fill: treat the order as "filled" once delivered speed reaches this
   * percent of the (effective) target. Below it, the bidder walks the price up.
   * Default 80.
   */
  readonly min_fill_pct?: number;
  /**
   * Track-to-fill: when true, while under-filled the bidder walks the price up
   * to just above the next filled order on the book (the next tier with miners)
   * + overpay, climbing tier by tier until filled or a cap binds - every tick,
   * since raises are unconstrained on NiceHash. While filled it never chases the
   * floor up; it only walks down. When false, pure floor-tracking (both ways, no
   * escalation). Default false.
   */
  readonly walk_up_enabled?: boolean;
  /**
   * Grace period (seconds) the order must be continuously under-filled before the
   * bidder walks the price up. Gives a freshly placed or just-repriced order time
   * to attract miners before escalating, and paces floor-tracking walk-ups (the
   * timer resets on each such raise; the escalation ladder's raises don't reset
   * it - episode-based). 0 disables the grace (walk up as soon as under-filled).
   * Only affects walk-ups (walk_up_enabled); pure floor-tracking ignores it.
   * Default 0.
   */
  readonly walk_up_grace_seconds?: number;
  /**
   * Escalation ladder step (BTC/unit/day). When the order stays under-filled
   * at the normal floor (anchor + overpay) past the walk-up grace, the bid
   * escalates ABOVE the floor by this much per escalation interval, bounded by
   * the effective cap - a pure ladder, one step at a time (no market-hint
   * jump). After sustained fills the offset decays one probe step per NiceHash
   * decrease-cooldown window (never snapping back to the floor). Only active
   * with walk_up_enabled. Default 0.0002.
   */
  readonly escalation_step_btc?: number;
  /**
   * Seconds between UPWARD escalation-ladder moves while under-filled. The
   * walk-up grace gates entry into escalation and re-entry after a filled
   * spell drops back under-filled; steps within a continuous under-filled
   * episode pace on this interval alone. Decay while filled paces on max(this,
   * NiceHash decrease cooldown) - one probe step per executable walk-down
   * window, so the ladder never drains faster than the gate lets the price
   * follow. Default 60.
   */
  readonly escalation_interval_seconds?: number;
  /** Minimum speed limit (display units), from algorithm metadata. */
  readonly min_speed_limit_units: number;
  /** Absolute price granularity / down step (BTC/unit/day), from metadata. */
  readonly price_down_step_btc: number;
  /**
   * Speed display-unit label for this market (e.g. "EH" for SHA256ASICBOOST),
   * derived from the algorithm's marketFactor. All speed values in this config
   * and the observed state are in this unit; the dashboard labels/scales from
   * it. Optional; the dashboard falls back to PH when absent.
   */
  readonly speed_display_unit?: string;
  /** Cheap-mode scale-up: engage when our bid < this % of hashprice. 0 disables. */
  readonly cheap_threshold_pct: number;
  /** Target speed while cheap mode is engaged (display units). */
  readonly cheap_target_speed_units: number;
  /** NiceHash marketplace fee, percent. Feeds the dynamic cap + P&L. Default 0. */
  readonly nicehash_fee_pct?: number;
  /** Mining-pool fee, percent. Feeds the dynamic cap + P&L. Default 0. */
  readonly pool_fee_pct?: number;
  /**
   * Master switch for the dynamic price cap. When on, the bid is capped at the
   * fee-adjusted, buffered hashprice (see {@link dynamicCapPrice}) whenever a
   * hashprice is available, so the bid plus fees never eats into your chosen
   * profit margin. When off, pricing uses only overpay + the fixed/premium
   * ceilings. Default false.
   */
  readonly dynamic_cap_enabled?: boolean;
  /**
   * Profit buffer for the dynamic cap, an absolute amount in BTC/price-unit/day
   * held back below the fee-adjusted hashprice. dynamic cap = hashprice /
   * (1 + (nicehash_fee + pool_fee)/100) - this. Default 0 (pure break-even).
   */
  readonly dynamic_cap_buffer_btc?: number;
}

/**
 * The dynamic price cap: the most you can bid per price-unit/day and still keep
 * your chosen profit buffer after fees. The fees are a *markup* on what you pay
 * (bid + fees must not exceed the hashprice), so the break-even bid divides them
 * out: `cap = hashprice / (1 + (nicehash_fee + pool_fee)/100) - buffer`. This
 * matches the P&L panel, whose effective cost is `bid x (1 + fees)` - i.e.
 * `cap x (1 + fees) = hashprice` at break-even. Returns null when the hashprice
 * is unavailable.
 */
export function dynamicCapPrice(
  hashprice: number | null,
  niceHashFeePct = 0,
  poolFeePct = 0,
  bufferBtc = 0,
): number | null {
  if (hashprice === null || !Number.isFinite(hashprice)) return null;
  const totalFee = (niceHashFeePct || 0) + (poolFeePct || 0);
  const cap = hashprice / (1 + totalFee / 100) - (bufferBtc || 0);
  // Round UP to the 4-dp price grid the market quotes on, so the bid can climb the
  // final fraction of a tick to the cap (e.g. a 0.457259 break-even becomes 0.4573)
  // instead of `execute()` flooring it a tick below (0.4572). The bid then sits at
  // the grid tick at or just above break-even; use the profit buffer for margin
  // below that. The epsilon keeps a value already on the grid from ticking up.
  return Math.ceil(cap * 1e4 - 1e-6) / 1e4;
}

/**
 * The effective price ceiling for a given tick: the most we will ever bid,
 * `min(fixed hard cap, premium cap, dynamic break-even cap)`. This is the single
 * definition of "our ceiling"; `decide()` reprises the same math inline (it also
 * needs to know *which* bound is binding, for its log label), and `observe()`
 * uses this to bound the reported "next filled tier" so a distant book jump never
 * charts or anchors a price we could never actually bid. Returns at least the
 * fixed cap; a null/absent hashprice simply drops the hashprice-derived bounds.
 */
export function effectiveCapBtc(
  config: NiceHashControllerConfig,
  hashprice: number | null,
): number {
  const fixedCap = config.max_price_btc_per_unit_day;
  const premiumCap =
    config.max_overpay_vs_hashprice_btc_per_unit_day !== null && hashprice !== null
      ? hashprice + config.max_overpay_vs_hashprice_btc_per_unit_day
      : null;
  let cap = premiumCap !== null ? Math.min(fixedCap, premiumCap) : fixedCap;
  const dynamicCap = config.dynamic_cap_enabled
    ? dynamicCapPrice(
        hashprice,
        config.nicehash_fee_pct,
        config.pool_fee_pct,
        config.dynamic_cap_buffer_btc,
      )
    : null;
  if (dynamicCap !== null && dynamicCap < cap) cap = dynamicCap;
  return cap;
}

export interface NiceHashState {
  readonly tick_at: number;
  readonly run_mode: RunMode;
  readonly config: NiceHashControllerConfig;
  /** null when the order book was unavailable this tick. */
  readonly market: MarketAnchor | null;
  /** Available BTC balance; null when the balance read failed. */
  readonly balance_btc: number | null;
  readonly owned_orders: readonly OwnedOrderSnapshot[];
  readonly unknown_orders: readonly UnknownOrderSnapshot[];
  /** Break-even hashprice in BTC/unit/day; null when unavailable. */
  readonly hashprice_btc_per_unit_day: number | null;
  /** Diagnostic: order-book read error this tick (null when it succeeded). */
  readonly market_error?: string | null;
  /** Diagnostic: my-orders read error this tick (null when it succeeded). */
  readonly orders_error?: string | null;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalKind =
  | 'CREATE_ORDER'
  | 'EDIT_PRICE'
  | 'EDIT_LIMIT'
  | 'REFILL_ORDER'
  | 'CANCEL_ORDER'
  | 'PAUSE';

export interface CreateOrderProposal {
  readonly kind: 'CREATE_ORDER';
  readonly price_btc: number;
  readonly amount_btc: number;
  readonly limit_units: number;
  readonly pool_id: string;
  readonly reason: string;
}

export interface EditPriceProposal {
  readonly kind: 'EDIT_PRICE';
  readonly order_id: string;
  readonly new_price_btc: number;
  readonly old_price_btc: number;
  readonly reason: string;
}

export interface EditLimitProposal {
  readonly kind: 'EDIT_LIMIT';
  readonly order_id: string;
  readonly new_limit_units: number;
  readonly old_limit_units: number;
  readonly reason: string;
}

export interface RefillOrderProposal {
  readonly kind: 'REFILL_ORDER';
  readonly order_id: string;
  readonly amount_btc: number;
  readonly reason: string;
}

export interface CancelOrderProposal {
  readonly kind: 'CANCEL_ORDER';
  readonly order_id: string;
  readonly reason: string;
}

export interface PauseProposal {
  readonly kind: 'PAUSE';
  readonly reason: string;
}

export type Proposal =
  | CreateOrderProposal
  | EditPriceProposal
  | EditLimitProposal
  | RefillOrderProposal
  | CancelOrderProposal
  | PauseProposal;

/** Order statuses that mean the order is gone - never edit/refill/cancel them. */
const TERMINAL_STATUSES = new Set(['DEAD', 'CANCELLED', 'COMPLETED', 'ERROR', 'EXPIRED']);

export function isActionableOrder(order: { status: string }): boolean {
  return !TERMINAL_STATUSES.has(order.status.toUpperCase());
}

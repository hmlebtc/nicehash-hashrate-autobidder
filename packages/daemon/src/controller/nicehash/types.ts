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
  /** NiceHash status code, e.g. ACTIVE / DEAD / CANCELLED / COMPLETED. */
  readonly status: string;
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
  /** Re-price only when the move exceeds this % of the overpay cushion. */
  readonly price_edit_deadband_pct: number;
  /**
   * Track-to-fill: treat the order as "filled" once delivered speed reaches this
   * percent of the (effective) target. Below it, the bidder walks the price up.
   * Default 80.
   */
  readonly min_fill_pct?: number;
  /**
   * Track-to-fill: when true, while under-filled the bidder walks the price up
   * to just above the next filled order on the book (the next tier with miners)
   * + overpay, climbing tier by tier until filled or a cap binds. When false,
   * pure floor-tracking (no escalation). Default false.
   */
  readonly walk_up_enabled?: boolean;
  /**
   * Track-to-fill: minimum time (ms) to wait after a price change before the
   * next walk-up step, so a raise has time to attract miners. Default 0.
   */
  readonly walk_up_settle_ms?: number;
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
  /** NiceHash marketplace fee, percent. Default 0 (no fee effect). */
  readonly nicehash_fee_pct?: number;
  /** Mining-pool fee, percent. Default 0. */
  readonly pool_fee_pct?: number;
  /**
   * Master switch for the fees & break-even feature. When false, the fee
   * percentages and the break-even cap are ignored entirely by the bidder
   * (pricing falls back to overpay + fixed/dynamic ceilings). Default false.
   */
  readonly use_break_even?: boolean;
  /**
   * When true (and `use_break_even` is on), the bid is capped at the
   * fee-adjusted break-even hashprice (= hashprice / (1 + (nicehash_fee_pct +
   * pool_fee_pct)/100)) whenever a hashprice is available, so bid + fees never
   * exceed the hashrate's earnings. When false, fees are still shown in the
   * dashboard but the bid is not capped. Default false.
   */
  readonly cap_at_break_even?: boolean;
}

/**
 * Fee-adjusted break-even bid: the most you can pay per price-unit/day and still
 * cover the bid plus the NiceHash + pool fees out of the hashprice. Returns null
 * when the hashprice is unavailable.
 */
export function breakEvenPrice(
  hashprice: number | null,
  niceHashFeePct = 0,
  poolFeePct = 0,
): number | null {
  if (hashprice === null || !Number.isFinite(hashprice)) return null;
  const totalFee = (niceHashFeePct || 0) + (poolFeePct || 0);
  return hashprice / (1 + totalFee / 100);
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

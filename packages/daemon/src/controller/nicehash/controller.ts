/**
 * NiceHashController - the stateful tick driver that binds the pure loop to the
 * SQLite ownership ledger.
 *
 * Each tick it:
 *   1. loads the owned-order ids + price-decrease timestamps from the ledger,
 *   2. runs the pure `tick()` (observe -> decide -> gate -> execute), persisting
 *      executed side effects back to the ledger via the `onExecuted` hook
 *      (created order id, price-decrease timestamp, cancellation), and
 *   3. reconciles the ledger rows against what `myOrders` reported this tick
 *      (status / price / limit / cumulative spend).
 *
 * In DRY-RUN the gate denies every mutation, so nothing is persisted - the
 * ledger only fills in LIVE. Ownership reconciliation keeps the daemon from
 * treating its own order as a stranger (which would PAUSE it).
 */

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import type { NiceHashOrdersRepo } from '../../state/repos/nicehash_orders.js';
import type {
  NiceHashMetricRow,
  NiceHashMetricsRepo,
} from '../../state/repos/nicehash_tick_metrics.js';
import type {
  NiceHashEventsRepo,
  NiceHashOrderEventInput,
} from '../../state/repos/nicehash_order_events.js';
import type {
  NiceHashDecisionLogRepo,
  NiceHashLogInput,
} from '../../state/repos/nicehash_decision_log.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import { tick as runTick, type NiceHashTickResult, type TickOutcome } from './tick.js';
import { isActionableOrder, type NiceHashState, type RunMode } from './types.js';
import type { NiceHashControllerConfig } from './types.js';

export interface NiceHashControllerDeps {
  readonly service: NiceHashService;
  readonly client: NiceHashClient;
  readonly ledger: NiceHashOrdersRepo;
  readonly config: NiceHashControllerConfig;
  readonly currency: string;
  readonly balanceCurrency: string;
  /** Resolved per tick so the run mode can change at runtime. */
  readonly runMode: () => RunMode;
  readonly hashprice?: () => number | null;
  readonly priceDecreaseCooldownMs?: number;
  readonly orderType?: string;
  readonly now?: () => number;
  /** Optional time-series sink: one row recorded per tick (charts/tiles/P&L). */
  readonly metrics?: NiceHashMetricsRepo;
  /** Optional audit sink: one row per attempted order mutation (History page). */
  readonly events?: NiceHashEventsRepo;
  /** Optional debug sink: one decision summary row per tick (Logs page). */
  readonly decisionLog?: NiceHashDecisionLogRepo;
  /**
   * Conversion from a speed-display unit (e.g. PH) to a price-display unit
   * (e.g. EH): marketFactor / priceFactor. Used to express the burn rate
   * (price x delivered) in BTC/day. Defaults to 1 (no conversion).
   */
  readonly speedToPriceUnit?: number;
}

export class NiceHashController {
  constructor(private readonly deps: NiceHashControllerDeps) {}

  async tick(): Promise<NiceHashTickResult> {
    const now = this.deps.now ?? Date.now;
    const hashprice = this.deps.hashprice?.() ?? null;
    const [knownOrderIds, lastPriceDecreaseById, lastPriceChangeById] = await Promise.all([
      this.deps.ledger.getIds(),
      this.deps.ledger.lastPriceDecreaseMap(),
      this.deps.ledger.lastPriceChangeMap(),
    ]);

    const result = await runTick({
      service: this.deps.service,
      client: this.deps.client,
      config: this.deps.config,
      currency: this.deps.currency,
      balanceCurrency: this.deps.balanceCurrency,
      knownOrderIds,
      lastPriceDecreaseById,
      lastPriceChangeById,
      runMode: this.deps.runMode(),
      hashprice,
      ...(this.deps.orderType ? { orderType: this.deps.orderType } : {}),
      ...(this.deps.priceDecreaseCooldownMs !== undefined
        ? { priceDecreaseCooldownMs: this.deps.priceDecreaseCooldownMs }
        : {}),
      now,
      onExecuted: (outcome) => this.persist(outcome, now),
    });

    // Bring ledger rows in line with what NiceHash reported this tick.
    await this.deps.ledger.reconcileFromApi(
      result.state.owned_orders.map((o) => ({
        order_id: o.order_id,
        status: o.status,
        price_btc: o.price_btc,
        amount_btc: o.amount_btc,
        limit_units: o.limit_units,
        payed_amount_btc: o.payed_amount_btc,
      })),
    );

    // Record the per-tick metrics row + any order-mutation events. Best-effort:
    // a persistence hiccup must not break the control loop.
    if (this.deps.metrics) {
      try {
        await this.deps.metrics.record(
          buildMetricsRow(result.state, hashprice, this.deps.speedToPriceUnit ?? 1),
        );
      } catch {
        /* ignore - metrics are non-critical */
      }
    }
    if (this.deps.events) {
      for (const outcome of result.outcomes) {
        const ev = toOrderEvent(outcome, result.state);
        if (ev) {
          try {
            await this.deps.events.record(ev);
          } catch {
            /* ignore - history is non-critical */
          }
        }
      }
    }
    if (this.deps.decisionLog) {
      try {
        await this.deps.decisionLog.record(buildDecisionRow(result));
      } catch {
        /* ignore - the debug log is non-critical */
      }
    }

    return result;
  }

  private async persist(outcome: TickOutcome, now: () => number): Promise<void> {
    if (outcome.outcome !== 'EXECUTED') return;
    const p = outcome.proposal;
    switch (p.kind) {
      case 'CREATE_ORDER':
        if (outcome.orderId) {
          await this.deps.ledger.insert({
            order_id: outcome.orderId,
            created_at: now(),
            price_btc: p.price_btc,
            amount_btc: p.amount_btc,
            limit_units: p.limit_units,
            pool_id: p.pool_id,
            last_known_status: 'CREATED',
          });
        }
        return;
      case 'EDIT_PRICE':
        if (p.new_price_btc < p.old_price_btc) {
          await this.deps.ledger.setLastPriceDecrease(p.order_id, now(), p.new_price_btc);
        } else if (p.new_price_btc > p.old_price_btc) {
          // Upward move: no decrease cooldown, but reset the walk-up settle window.
          await this.deps.ledger.setLastPriceChange(p.order_id, now(), p.new_price_btc);
        }
        return;
      case 'CANCEL_ORDER':
        await this.deps.ledger.markCancelled(p.order_id);
        return;
      case 'EDIT_LIMIT':
      case 'REFILL_ORDER':
      case 'PAUSE':
        return; // picked up by reconcileFromApi / no ledger effect
    }
  }
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let total = 0;
  for (const x of xs) total += f(x) || 0;
  return total;
}

/** Build the per-tick metrics row from the observed state. */
function buildMetricsRow(
  state: NiceHashState,
  hashprice: number | null,
  speedToPriceUnit: number,
): NiceHashMetricRow {
  const owned = state.owned_orders;
  const primary = owned.find((o) => isActionableOrder(o)) ?? owned[0];
  // The hashrate-chart reference line is the fill threshold the bot acts on:
  // target × min-fill %. (Replaces the old cosmetic "minimum floor".)
  const fillThresholdUnits =
    state.config.target_speed_units * ((state.config.min_fill_pct ?? 100) / 100);
  return {
    ts: state.tick_at,
    run_mode: state.run_mode,
    api_ok: state.market ? 1 : 0,
    balance_btc: state.balance_btc,
    anchor_price_btc: state.market?.anchor_price_btc ?? null,
    // The next filled tier above the marginal (2nd-cheapest order with miners).
    next_filled_price_btc: state.market?.filled_prices?.[1] ?? null,
    our_price_btc: primary?.price_btc ?? null,
    total_speed_units: state.market?.total_speed_units ?? null,
    accepted_speed_units: sum(owned, (o) => o.accepted_speed_units),
    limit_units: sum(owned, (o) => o.limit_units),
    target_units: state.config.target_speed_units,
    floor_units: fillThresholdUnits,
    available_amount_btc: sum(owned, (o) => o.available_amount_btc),
    // Burn rate in BTC/day = price (BTC per price-unit/day) x delivered speed
    // converted from the speed unit (PH) to the price unit (EH).
    spend_rate_btc_day: sum(owned, (o) => o.price_btc * o.accepted_speed_units) * speedToPriceUnit,
    hashprice_btc_per_unit_day: hashprice,
    owned_count: owned.length,
    unknown_count: state.unknown_orders.length,
  };
}

/**
 * Map a tick outcome to a History event row, or null when it should not be
 * recorded.
 *
 * History records only *real* order actions: EXECUTED and FAILED (LIVE).
 * DRY_RUN/PAUSED proposals are BLOCKED by the gate before they reach the
 * marketplace and would otherwise re-log the same "would create" every tick -
 * dry-run intent is surfaced in the live "Next action" panel instead. PAUSE is
 * a run-mode transition, not an order mutation.
 */
function toOrderEvent(outcome: TickOutcome, state: NiceHashState): NiceHashOrderEventInput | null {
  if (outcome.outcome !== 'EXECUTED' && outcome.outcome !== 'FAILED') return null;
  const p = outcome.proposal;
  if (p.kind === 'PAUSE') return null;

  const base = {
    ts: state.tick_at,
    run_mode: state.run_mode,
    outcome: outcome.outcome,
    anchor_price_btc: state.market?.anchor_price_btc ?? null,
    reason: p.reason,
    detail: outcome.outcome === 'FAILED' ? outcome.error : outcome.note,
    order_id: null as string | null,
    price_before: null as number | null,
    price_after: null as number | null,
    limit_before: null as number | null,
    limit_after: null as number | null,
    amount_btc: null as number | null,
  };

  switch (p.kind) {
    case 'CREATE_ORDER':
      return {
        ...base,
        action: 'CREATE',
        order_id: outcome.outcome === 'EXECUTED' ? (outcome.orderId ?? null) : null,
        price_after: p.price_btc,
        limit_after: p.limit_units,
        amount_btc: p.amount_btc,
      };
    case 'EDIT_PRICE':
      return {
        ...base,
        action: 'EDIT_PRICE',
        order_id: p.order_id,
        price_before: p.old_price_btc,
        price_after: p.new_price_btc,
      };
    case 'EDIT_LIMIT':
      return {
        ...base,
        action: 'EDIT_LIMIT',
        order_id: p.order_id,
        limit_before: p.old_limit_units,
        limit_after: p.new_limit_units,
      };
    case 'REFILL_ORDER':
      return { ...base, action: 'REFILL', order_id: p.order_id, amount_btc: p.amount_btc };
    case 'CANCEL_ORDER':
      return { ...base, action: 'CANCEL', order_id: p.order_id };
  }
}

/** Build the per-tick decision-log row (Logs page) summarising what happened. */
function buildDecisionRow(result: NiceHashTickResult): NiceHashLogInput {
  const s = result.state;
  const outs = result.outcomes;
  const failed = outs.some((o) => o.outcome === 'FAILED');
  const blocked = outs.some((o) => o.outcome === 'BLOCKED');
  const paused = result.proposals.some((p) => p.kind === 'PAUSE');
  const marketDown = !s.market;

  // A read that actually threw (orders/market error) is an error - it blocks all
  // action and is what the operator needs to debug; a market that is merely
  // empty/unpriceable is a warn.
  const readErrored = Boolean(s.orders_error || s.market_error);
  const level: NiceHashLogInput['level'] =
    failed || (marketDown && readErrored)
      ? 'error'
      : blocked || paused || marketDown
        ? 'warn'
        : 'info';

  let message: string;
  if (marketDown) {
    const cause = s.orders_error
      ? `my-orders read failed: ${s.orders_error}`
      : s.market_error
        ? `order book read failed: ${s.market_error}`
        : 'order book / my-orders read failed';
    message = `market unavailable (${cause})`;
  } else if (result.proposals.length === 0) message = 'holding — no action';
  else message = result.proposals.map((p, i) => `${p.kind} → ${outs[i]?.outcome ?? '?'}`).join(', ');

  const lines = result.proposals.map((p, i) => {
    const o = outs[i];
    let verdict = '?';
    if (o) {
      if (o.outcome === 'BLOCKED') verdict = `BLOCKED(${o.reason})`;
      else if (o.outcome === 'FAILED') verdict = `FAILED: ${o.error}`;
      else verdict = o.outcome + ('note' in o && o.note ? ` · ${o.note}` : '');
    }
    return `${p.kind}: ${p.reason} -> ${verdict}`;
  });
  const detail = [
    `run=${s.run_mode} balance=${s.balance_btc ?? '?'} anchor=${s.market?.anchor_price_btc ?? 'n/a'} ` +
      `hashprice=${s.hashprice_btc_per_unit_day ?? 'n/a'} owned=${s.owned_orders.length} unknown=${s.unknown_orders.length}`,
    ...(s.orders_error ? [`my-orders error: ${s.orders_error}`] : []),
    ...(s.market_error ? [`order-book error: ${s.market_error}`] : []),
    ...lines,
  ].join('\n');

  return { ts: s.tick_at, level, kind: 'TICK', run_mode: s.run_mode, message, detail };
}

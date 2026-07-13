/**
 * Hold explainer for the NiceHash loop - "why is the bot not acting, and when
 * will it?".
 *
 * `explainTick()` runs after decide() + gate() each tick and emits a STRUCTURED
 * hold reason (kind + absolute timestamps + the intended move where one was
 * held) into the tick result. It never influences decisions - observability
 * only - and deliberately re-derives the pricing pieces from the same state
 * decide() consumed (the codebase's existing pattern: observe's ladder block
 * reprises the same math).
 *
 * Timestamps are ABSOLUTE (epoch ms): the HTTP layer formats them against
 * Date.now() on every /api/status request, so the dashboard's 3s poll renders
 * a live countdown instead of a number frozen at tick time.
 */

import { DEFAULT_PRICE_DECREASE_COOLDOWN_MS } from './observe.js';
import {
  effectiveCapBtc,
  isActionableOrder,
  type NiceHashState,
  type Proposal,
} from './types.js';
import type { NiceHashGateOutcome } from './gate.js';

/** NiceHash 4-dp price grid (mirrors decide.ts's PRICE_STEP_BTC). */
const PRICE_STEP_BTC = 0.0001;

export type HoldReasonKind =
  | 'DECREASE_COOLDOWN' // intended walk-down held by NiceHash's decrease cooldown
  | 'GRACE_WAIT' // under-filled; walk-up/escalation grace still running
  | 'ESCALATION_STEP_WAIT' // ladder engaged; next step waits on the interval
  | 'AT_CAP_UNDERFILLED' // bid at the cap, still under-filled - market clears above break-even
  | 'MARKET_ABOVE_CAP' // whole book above the cap - parked at the cap, ready if it dips
  | 'FILLED_ESCALATED' // filled at an escalated price - probe-down pending
  | 'AT_TARGET'; // in-band at the (possibly escalated) target

export interface HoldReason {
  readonly kind: HoldReasonKind;
  /** Absolute epoch ms when the wait ends; null when no timer applies. */
  readonly until: number | null;
  /** Intended move of a held walk-down (DECREASE_COOLDOWN). */
  readonly from_btc?: number;
  readonly to_btc?: number;
  /** Mode label of the held proposal, e.g. "walk down (de-escalating)". */
  readonly label?: string;
  /** Ladder step size for ESCALATION_STEP_WAIT (the upcoming +X). */
  readonly step_btc?: number;
  /** AT_TARGET flavor: the target includes an escalation offset. */
  readonly escalated?: boolean;
}

export function explainTick(args: {
  readonly state: NiceHashState;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly NiceHashGateOutcome[];
  readonly priceDecreaseCooldownMs?: number;
}): HoldReason | null {
  const { state, proposals, gated } = args;
  const cooldownMs = args.priceDecreaseCooldownMs ?? DEFAULT_PRICE_DECREASE_COOLDOWN_MS;
  const { config } = state;

  // 1. A walk-down held by the decrease cooldown - the one BLOCKED case with a
  //    hard timer worth narrating. (Run-mode blocks are not a hold story: the
  //    dashboard already shows the would-be action itself in DRY_RUN/PAUSED.)
  for (const g of gated) {
    if (!g.allowed && g.reason === 'PRICE_DECREASE_COOLDOWN' && g.proposal.kind === 'EDIT_PRICE') {
      const p = g.proposal;
      const order = state.owned_orders.find((o) => o.order_id === p.order_id);
      const lastMove = Math.max(
        order?.last_price_decrease_at ?? 0,
        order?.last_price_change_at ?? 0,
      );
      const until =
        order?.decrease_available_at ??
        (lastMove > 0 ? lastMove + cooldownMs : state.tick_at + cooldownMs);
      return {
        kind: 'DECREASE_COOLDOWN',
        until,
        from_btc: p.old_price_btc,
        to_btc: p.new_price_btc,
        label: p.reason.split(':')[0] ?? 'walk down',
      };
    }
  }

  // 2. Any other proposal tells its own story (executed / dry-run / failed).
  if (proposals.length > 0) return null;

  // 3. Nothing proposed: derive WHY we're holding, mirroring decide()'s
  //    pricing guards and derivations over the identical inputs.
  if (!config.pool_id) return null;
  if (!state.market || state.market.anchor_price_btc === null) return null;
  const hashprice = state.hashprice_btc_per_unit_day;
  if (config.max_overpay_vs_hashprice_btc_per_unit_day !== null && hashprice === null) return null;

  const actionable = state.owned_orders.filter(isActionableOrder);
  const primary = [...actionable].sort((a, b) => a.order_id.localeCompare(b.order_id))[0];
  if (!primary) return null;

  const effectiveCap = effectiveCapBtc(config, hashprice);
  const marginal = state.market.anchor_price_btc;
  const ladder = state.market.filled_prices ?? [];
  const nextTier = ladder.length > 1 ? ladder[1]! : null;
  const anchor = config.anchor_next_filled_tier && nextTier !== null ? nextTier : marginal;
  const desired = anchor + config.overpay_btc_per_unit_day;

  // Cheap-mode-adjusted target, exactly as decide() measures the fill.
  let effectiveTarget = config.target_speed_units;
  if (
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_speed_units > config.target_speed_units &&
    hashprice !== null &&
    hashprice > 0 &&
    anchor + config.overpay_btc_per_unit_day < hashprice * (config.cheap_threshold_pct / 100)
  ) {
    effectiveTarget = config.cheap_target_speed_units;
  }
  const fillThreshold = (effectiveTarget * (config.min_fill_pct ?? 100)) / 100;
  const underFilled = primary.accepted_speed_units < fillThreshold;

  const graceMs = Math.max(0, (config.walk_up_grace_seconds ?? 0) * 1000);
  const gracePassed =
    graceMs === 0 ||
    (primary.under_filled_since != null && state.tick_at - primary.under_filled_since >= graceMs);
  const graceUntil =
    graceMs > 0 && primary.under_filled_since != null
      ? primary.under_filled_since + graceMs
      : null;

  const walkUpEnabled = config.walk_up_enabled ?? false;
  const escalationRaw = walkUpEnabled ? Math.max(0, primary.escalation_offset_btc ?? 0) : 0;
  const room = Math.max(0, effectiveCap - desired);
  const escalationOffset = Math.min(escalationRaw, room);
  const stepBtc = Math.max(0.0001, config.escalation_step_btc ?? 0.0002);
  const intervalMs = Math.max(5, Math.round(config.escalation_interval_seconds ?? 60)) * 1000;
  const decayIntervalMs = Math.max(intervalMs, cooldownMs);
  const lastStepAt = primary.escalation_last_step_at ?? null;

  // Whole book above the cap: the existing forcing has already parked the bid
  // at the cap (or a proposal would exist) - not a fill-chasing wait.
  if (marginal > effectiveCap) {
    return { kind: 'MARKET_ABOVE_CAP', until: null };
  }

  if (underFilled && walkUpEnabled && !gracePassed) {
    return { kind: 'GRACE_WAIT', until: graceUntil };
  }

  if (underFilled && walkUpEnabled && gracePassed) {
    // Target pinned at the cap and no room to climb: paying more is not an
    // option the operator allowed - a persistent partial fill here means the
    // market clears above break-even.
    if (desired + escalationRaw >= effectiveCap - 1e-9) {
      return { kind: 'AT_CAP_UNDERFILLED', until: null };
    }
    // Ladder engaged and at its current rung: the next step waits on the
    // escalation interval.
    if (escalationOffset > 0 && lastStepAt !== null) {
      return {
        kind: 'ESCALATION_STEP_WAIT',
        until: lastStepAt + intervalMs,
        step_btc: stepBtc,
      };
    }
  }

  if (!underFilled && escalationOffset > PRICE_STEP_BTC / 2) {
    // Filled at an escalated price: the next probe down lands when both the
    // ladder decay AND NiceHash's decrease cooldown allow it.
    const decayAt = (lastStepAt ?? state.tick_at) + decayIntervalMs;
    const until = Math.max(decayAt, primary.decrease_available_at ?? 0);
    return { kind: 'FILLED_ESCALATED', until };
  }

  return { kind: 'AT_TARGET', until: null, escalated: escalationOffset > PRICE_STEP_BTC / 2 };
}

/** Format a remaining wait as m:ss (clamped at 0:00). */
export function formatRemaining(untilMs: number, nowMs: number): string {
  const s = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const fmtGrid = (n: number): string => n.toFixed(4);

/**
 * Render a hold reason as the dashboard's "Next:" line, against a LIVE clock -
 * call with Date.now() per request so the countdown ticks on every poll.
 */
export function formatHoldReason(
  hold: HoldReason | null | undefined,
  nowMs: number,
): string | null {
  if (!hold) return null;
  const rem = hold.until !== null ? formatRemaining(hold.until, nowMs) : null;
  switch (hold.kind) {
    case 'DECREASE_COOLDOWN':
      return (
        `${hold.label ?? 'walk down'} ${fmtGrid(hold.from_btc ?? 0)} -> ${fmtGrid(hold.to_btc ?? 0)}` +
        ` — waiting on NiceHash decrease cooldown, ~${rem ?? '?'} remaining`
      );
    case 'GRACE_WAIT':
      return rem !== null
        ? `under-filled — walk-up/escalation opens in ${rem} (grace)`
        : 'under-filled — waiting out the walk-up grace';
    case 'ESCALATION_STEP_WAIT':
      return `escalating — next step (+${fmtGrid(hold.step_btc ?? 0)}) in ${rem ?? '?'}`;
    case 'AT_CAP_UNDERFILLED':
      return 'at dynamic cap — market clears above break-even; holding';
    case 'MARKET_ABOVE_CAP':
      return 'market above cap — holding at the cap, ready if it dips';
    case 'FILLED_ESCALATED':
      return `filled at escalated price — next probe down in ~${rem ?? '?'}`;
    case 'AT_TARGET':
      return hold.escalated ? 'holding — at escalated target' : 'holding — at target (anchor + overpay)';
  }
}

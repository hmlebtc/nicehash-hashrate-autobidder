/**
 * gate() - applies the SPEC §7.3 mutation-gate to every proposal and also
 * enforces client-side pacing rules the market settings give us.
 *
 * The core `canMutate()` check lives in `@hashrate-autopilot/shared`. This
 * wrapper adapts proposals (CREATE_BID / EDIT_PRICE / CANCEL_BID / PAUSE)
 * to the gate's (create / edit / cancel) vocabulary and layers on the
 * `min_bid_price_decrease_period_s` cooldown.
 */

import { canMutate, type MutationAction } from '@hashrate-autopilot/shared';

import type { GateOutcome, Proposal, State } from './types.js';

export function gate(proposals: readonly Proposal[], state: State): GateOutcome[] {
  return proposals.map((p) => gateOne(p, state));
}

function gateOne(proposal: Proposal, state: State): GateOutcome {
  // PAUSE is not a Braiins mutation - it's an internal run-mode transition.
  // Always "allowed" in the sense that the tick driver will act on it.
  if (proposal.kind === 'PAUSE') {
    return { proposal, allowed: true };
  }

  const action: MutationAction = mapToGateAction(proposal);
  const base = canMutate({ runMode: state.run_mode, action });
  if (!base.allowed) {
    return { proposal, allowed: false, reason: base.reason };
  }

  // #222: fee-threshold halt. If any active owned bid carries a
  // fee_rate_pct above the operator-configured ceiling, block new
  // CREATE / EDIT / EDIT_SPEED. CANCEL_BID is intentionally not
  // gated - the operator (or the Datum-down auto-cancel path) can
  // still bail out of a fee-bearing bid. Halt clears automatically
  // the next tick every active bid is at-or-below the threshold;
  // the threshold *is* the operator's acknowledgement.
  if (proposal.kind !== 'CANCEL_BID' && isFeeThresholdExceeded(state)) {
    return { proposal, allowed: false, reason: 'FEE_THRESHOLD_EXCEEDED' };
  }

  // Layer: price-decrease cooldown applies to EDIT_PRICE only, when going down.
  if (proposal.kind === 'EDIT_PRICE' && proposal.new_price_sat < proposal.old_price_sat) {
    if (isInsidePriceDecreaseCooldown(proposal.braiins_order_id, state)) {
      return { proposal, allowed: false, reason: 'PRICE_DECREASE_COOLDOWN' };
    }
  }

  return { proposal, allowed: true };
}

/**
 * #222: any active owned bid carries a fee_rate_pct above the operator's
 * `max_acceptable_fee_pct` ceiling. Active = `BID_STATUS_ACTIVE`
 * (matches the same active-only check the beta_exit alert uses on
 * the per-bid fee_rate_pct snapshot).
 */
export function isFeeThresholdExceeded(state: State): boolean {
  const ceiling = state.config.max_acceptable_fee_pct;
  return state.owned_bids.some(
    (b) =>
      b.status === 'BID_STATUS_ACTIVE' &&
      b.fee_rate_pct !== null &&
      b.fee_rate_pct > ceiling,
  );
}

function mapToGateAction(proposal: Exclude<Proposal, { kind: 'PAUSE' }>): MutationAction {
  switch (proposal.kind) {
    case 'CREATE_BID':
      return 'create';
    case 'EDIT_PRICE':
    case 'EDIT_SPEED':
      return 'edit';
    case 'CANCEL_BID':
      return 'cancel';
  }
}

function isInsidePriceDecreaseCooldown(braiinsOrderId: string, state: State): boolean {
  const bid = state.owned_bids.find((b) => b.braiins_order_id === braiinsOrderId);
  if (!bid || bid.last_price_decrease_at === null) return false;
  const periodMs = (state.market?.settings.min_bid_price_decrease_period_s ?? 600) * 1000;
  return state.tick_at - bid.last_price_decrease_at < periodMs;
}

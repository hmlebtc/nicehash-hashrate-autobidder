/**
 * Mutation gate for the NiceHash loop - the analogue of the upstream
 * `controller/gate.ts`.
 *
 * Two layers:
 *   1. The run-mode rule (DRY-RUN / LIVE / PAUSED) via the shared `canMutate`.
 *      In any non-LIVE mode every marketplace mutation is denied, so DRY-RUN
 *      surfaces "what it would do" (the proposal) without touching the API.
 *   2. The NiceHash price-decrease throttle: a STANDARD order's price may only
 *      be lowered once per cooldown window. EDIT_PRICE *decreases* inside the
 *      window are denied; raises and all other proposals pass.
 *
 * PAUSE is an internal run-mode transition, not a marketplace call, so it is
 * always allowed through to the loop.
 */

import { canMutate } from '@hashrate-autopilot/shared';

import type { NiceHashState, Proposal } from './types.js';

export type NiceHashGateDenialReason =
  | 'RUN_MODE_NOT_LIVE'
  | 'RUN_MODE_PAUSED'
  | 'PRICE_DECREASE_COOLDOWN';

export type NiceHashGateOutcome =
  | { readonly proposal: Proposal; readonly allowed: true }
  | { readonly proposal: Proposal; readonly allowed: false; readonly reason: NiceHashGateDenialReason };

export interface NiceHashGateOptions {
  /** Minimum time between price decreases on a single order (ms). */
  readonly priceDecreaseCooldownMs: number;
}

export function gate(
  proposals: readonly Proposal[],
  state: NiceHashState,
  opts: NiceHashGateOptions,
): NiceHashGateOutcome[] {
  return proposals.map((p) => gateOne(p, state, opts));
}

function gateOne(
  proposal: Proposal,
  state: NiceHashState,
  opts: NiceHashGateOptions,
): NiceHashGateOutcome {
  // PAUSE is an internal transition, never a marketplace mutation.
  if (proposal.kind === 'PAUSE') return { proposal, allowed: true };

  const base = canMutate({ runMode: state.run_mode, action: 'edit' });
  if (!base.allowed) return { proposal, allowed: false, reason: base.reason };

  // Price-decrease cooldown applies only to EDIT_PRICE moving down.
  if (proposal.kind === 'EDIT_PRICE' && proposal.new_price_btc < proposal.old_price_btc) {
    if (isInsidePriceDecreaseCooldown(proposal.order_id, state, opts.priceDecreaseCooldownMs)) {
      return { proposal, allowed: false, reason: 'PRICE_DECREASE_COOLDOWN' };
    }
  }

  return { proposal, allowed: true };
}

function isInsidePriceDecreaseCooldown(
  orderId: string,
  state: NiceHashState,
  cooldownMs: number,
): boolean {
  const order = state.owned_orders.find((o) => o.order_id === orderId);
  if (!order) return false;
  // API-truth clock when available: the controller arms `decrease_available_at`
  // on every executed price change and resyncs it from NiceHash's own "Seconds
  // till available" answer on a 5061 rejection - always the best knowledge.
  if (order.decrease_available_at != null) {
    return state.tick_at < order.decrease_available_at;
  }
  // Fallback (fresh restart, or a pure-controller run without the clock map):
  // NiceHash's rule is 10 minutes since ANY price change - raises included -
  // not just since the last decrease. Gating on the decrease stamp alone let a
  // probe-down right after a ladder climb through to a guaranteed 400/5061
  // rejection, so use the later of the two persisted stamps.
  const lastMove = Math.max(order.last_price_decrease_at ?? 0, order.last_price_change_at ?? 0);
  return lastMove > 0 && state.tick_at - lastMove < cooldownMs;
}

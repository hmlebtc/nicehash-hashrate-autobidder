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

import { effectiveDecreaseAvailableAt } from './types.js';
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
  // The ONE decrease clock ({@link effectiveDecreaseAvailableAt}): API-truth
  // `decrease_available_at` when known (armed on executed price changes,
  // resynced from 5061 answers), else the persisted last-change stamps + the
  // cooldown (NiceHash's rule counts ANY price change, raises included). The
  // hold explainer consults the same helper, so the countdown the dashboard
  // shows is by construction the moment this gate opens.
  const availableAt = effectiveDecreaseAvailableAt(order, cooldownMs);
  return availableAt !== null && state.tick_at < availableAt;
}

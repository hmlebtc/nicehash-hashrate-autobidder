/**
 * One NiceHash control-loop tick: observe -> decide -> gate -> execute.
 *
 * Mirrors the upstream `controller/tick.ts` orchestration but for the NiceHash
 * order model. Holds no business logic itself - it sequences the pure pieces
 * and performs the (gated) marketplace mutations.
 *
 * Ledger persistence (recording a created order's id, refreshing
 * last-price-decrease timestamps) is delegated to the optional `onExecuted`
 * hook so this stays usable both from the DB-backed daemon and from the
 * standalone DRY-RUN runner.
 */

import { decide } from './decide.js';
import { executeProposal, type ExecutionResult, type NiceHashExecuteContext } from './execute.js';
import { gate, type NiceHashGateOutcome } from './gate.js';
import { observe, type NiceHashObserveDeps } from './observe.js';
import type { NiceHashState, Proposal } from './types.js';
import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

/** Default NiceHash price-decrease cooldown: 10 minutes. */
export const DEFAULT_PRICE_DECREASE_COOLDOWN_MS = 10 * 60_000;

export type TickOutcome =
  | ExecutionResult
  | { readonly proposal: Proposal; readonly outcome: 'BLOCKED'; readonly reason: string };

export interface NiceHashTickResult {
  readonly state: NiceHashState;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly NiceHashGateOutcome[];
  readonly outcomes: readonly TickOutcome[];
}

export interface NiceHashTickDeps extends Omit<NiceHashObserveDeps, 'now'> {
  readonly client: NiceHashClient;
  /** Order type to create, e.g. "STANDARD". */
  readonly orderType?: string;
  readonly priceDecreaseCooldownMs?: number;
  readonly now?: () => number;
  /** Hook to persist side effects (created order id, price-decrease ts). */
  readonly onExecuted?: (outcome: TickOutcome) => void | Promise<void>;
}

export async function tick(deps: NiceHashTickDeps): Promise<NiceHashTickResult> {
  // Algorithm metadata supplies the marketFactor/displayMarketFactor echoed on
  // every mutation (cached by the service).
  const algo = await deps.service.getAlgorithmSetting(deps.config.algorithm);

  const state = await observe(deps);
  const proposals = decide(state);
  const gated = gate(proposals, state, {
    priceDecreaseCooldownMs: deps.priceDecreaseCooldownMs ?? DEFAULT_PRICE_DECREASE_COOLDOWN_MS,
  });

  const ctx: NiceHashExecuteContext = {
    client: deps.client,
    market: deps.config.market,
    algorithm: deps.config.algorithm,
    type: deps.orderType ?? 'STANDARD',
    marketFactor: algo.marketFactor,
    displayMarketFactor: algo.displayMarketFactor,
  };

  const outcomes: TickOutcome[] = [];
  for (const g of gated) {
    const outcome: TickOutcome = g.allowed
      ? await executeProposal(ctx, state.run_mode, g.proposal)
      : { proposal: g.proposal, outcome: 'BLOCKED', reason: g.reason };
    outcomes.push(outcome);
    if (deps.onExecuted) await deps.onExecuted(outcome);
  }

  return { state, proposals, gated, outcomes };
}

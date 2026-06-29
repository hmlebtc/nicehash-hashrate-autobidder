/**
 * Translate controller proposals into NiceHash marketplace mutations.
 *
 * The NiceHash analogue of the upstream `execute()` side-effect mapping. This
 * module owns ONLY the marketplace calls; ledger writes (owned-order rows) and
 * the PAUSE run-mode transition are the daemon loop's responsibility (they need
 * the DB) and are layered on top when this is wired in.
 *
 * DRY-RUN vs LIVE is honoured here: in any non-LIVE mode every mutating
 * proposal becomes a "would ..." note and no NiceHash endpoint is touched.
 */

import { type NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import type { Proposal } from './types.js';

export type RunMode = 'DRY_RUN' | 'LIVE' | 'PAUSED';

export interface NiceHashExecuteContext {
  readonly client: NiceHashClient;
  readonly market: string;
  readonly algorithm: string;
  /** Order type, e.g. "STANDARD". */
  readonly type: string;
  /** Echoed verbatim from the algorithm metadata on every order mutation. */
  readonly marketFactor: string;
  readonly displayMarketFactor: string;
  /** Price-side factors - required alongside the speed factors (see types). */
  readonly priceFactor: string;
  readonly displayPriceFactor: string;
}

export type ExecutionResult =
  | { readonly proposal: Proposal; readonly outcome: 'DRY_RUN'; readonly note: string }
  | {
      readonly proposal: Proposal;
      readonly outcome: 'EXECUTED';
      readonly note: string;
      readonly orderId?: string;
    }
  | { readonly proposal: Proposal; readonly outcome: 'FAILED'; readonly error: string };

/** Format a number for the wire, trimming trailing zeros to avoid over-precision rejects. */
function dec(n: number, decimals = 8): string {
  return parseFloat(n.toFixed(decimals)).toString();
}

/**
 * Format an order PRICE for the wire. NiceHash quotes hash-power prices to 4
 * decimal places (the order book is all 0.4488, 0.4546, …) and rejects finer
 * precision with `2997 Invalid input: PRICE_DATA_SCALE`. The dynamic cap
 * (hashprice × fees − buffer) and other derived prices carry many decimals, so
 * snap to 4 dp here. Floor (not round) so a cap-/break-even-clamped bid never
 * creeps back above its ceiling; the epsilon absorbs float noise on 4-dp values.
 */
function decPrice(n: number): string {
  return dec(Math.floor(n * 1e4 + 1e-6) / 1e4, 8);
}

function dryRunNote(proposal: Proposal): string {
  switch (proposal.kind) {
    case 'CREATE_ORDER':
      return `would createOrder price=${dec(proposal.price_btc)} amount=${dec(proposal.amount_btc)} limit=${dec(proposal.limit_units)} pool=${proposal.pool_id}`;
    case 'EDIT_PRICE':
      return `would updatePriceAndLimit ${proposal.order_id} price ${dec(proposal.old_price_btc)} -> ${dec(proposal.new_price_btc)}`;
    case 'EDIT_LIMIT':
      return `would updatePriceAndLimit ${proposal.order_id} limit ${dec(proposal.old_limit_units)} -> ${dec(proposal.new_limit_units)}`;
    case 'REFILL_ORDER':
      return `would refillOrder ${proposal.order_id} +${dec(proposal.amount_btc)} BTC`;
    case 'CANCEL_ORDER':
      return `would cancelOrder ${proposal.order_id}`;
    case 'PAUSE':
      return `would PAUSE (${proposal.reason})`;
  }
}

export async function executeProposal(
  ctx: NiceHashExecuteContext,
  runMode: RunMode,
  proposal: Proposal,
): Promise<ExecutionResult> {
  // PAUSE is a run-mode transition handled by the loop, not a marketplace call.
  if (proposal.kind === 'PAUSE') {
    return {
      proposal,
      outcome: runMode === 'LIVE' ? 'EXECUTED' : 'DRY_RUN',
      note: `pause: ${proposal.reason}`,
    };
  }

  if (runMode !== 'LIVE') {
    return { proposal, outcome: 'DRY_RUN', note: dryRunNote(proposal) };
  }

  try {
    switch (proposal.kind) {
      case 'CREATE_ORDER': {
        const res = await ctx.client.createOrder({
          market: ctx.market,
          algorithm: ctx.algorithm,
          type: ctx.type,
          amount: dec(proposal.amount_btc),
          price: decPrice(proposal.price_btc),
          limit: dec(proposal.limit_units),
          poolId: proposal.pool_id,
          marketFactor: ctx.marketFactor,
          displayMarketFactor: ctx.displayMarketFactor,
          priceFactor: ctx.priceFactor,
          displayPriceFactor: ctx.displayPriceFactor,
        });
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `createOrder OK id=${res.id}`,
          orderId: res.id,
        };
      }
      case 'EDIT_PRICE': {
        await ctx.client.updatePriceAndLimit(proposal.order_id, {
          price: decPrice(proposal.new_price_btc),
          marketFactor: ctx.marketFactor,
          displayMarketFactor: ctx.displayMarketFactor,
          priceFactor: ctx.priceFactor,
          displayPriceFactor: ctx.displayPriceFactor,
        });
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `updatePriceAndLimit OK price ${dec(proposal.old_price_btc)} -> ${dec(proposal.new_price_btc)}`,
        };
      }
      case 'EDIT_LIMIT': {
        await ctx.client.updatePriceAndLimit(proposal.order_id, {
          limit: dec(proposal.new_limit_units),
          marketFactor: ctx.marketFactor,
          displayMarketFactor: ctx.displayMarketFactor,
          priceFactor: ctx.priceFactor,
          displayPriceFactor: ctx.displayPriceFactor,
        });
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `updatePriceAndLimit OK limit ${dec(proposal.old_limit_units)} -> ${dec(proposal.new_limit_units)}`,
        };
      }
      case 'REFILL_ORDER': {
        await ctx.client.refillOrder(proposal.order_id, dec(proposal.amount_btc));
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `refillOrder OK +${dec(proposal.amount_btc)} BTC`,
        };
      }
      case 'CANCEL_ORDER': {
        await ctx.client.cancelOrder(proposal.order_id);
        return { proposal, outcome: 'EXECUTED', note: `cancelOrder OK id=${proposal.order_id}` };
      }
    }
  } catch (err) {
    return { proposal, outcome: 'FAILED', error: (err as Error)?.message ?? String(err) };
  }
}

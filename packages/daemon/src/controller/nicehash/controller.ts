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
import type { NiceHashService } from '../../services/nicehash-service.js';
import { tick as runTick, type NiceHashTickResult, type TickOutcome } from './tick.js';
import type { NiceHashControllerConfig, RunMode } from './types.js';

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
}

export class NiceHashController {
  constructor(private readonly deps: NiceHashControllerDeps) {}

  async tick(): Promise<NiceHashTickResult> {
    const now = this.deps.now ?? Date.now;
    const [knownOrderIds, lastPriceDecreaseById] = await Promise.all([
      this.deps.ledger.getIds(),
      this.deps.ledger.lastPriceDecreaseMap(),
    ]);

    const result = await runTick({
      service: this.deps.service,
      client: this.deps.client,
      config: this.deps.config,
      currency: this.deps.currency,
      balanceCurrency: this.deps.balanceCurrency,
      knownOrderIds,
      lastPriceDecreaseById,
      runMode: this.deps.runMode(),
      hashprice: this.deps.hashprice?.() ?? null,
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

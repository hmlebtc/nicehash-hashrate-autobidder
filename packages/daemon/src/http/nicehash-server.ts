/**
 * HTTP API for the NiceHash daemon - the backend the dashboard binds to.
 *
 * Minimal Fastify surface that exposes the latest control-loop tick (from the
 * in-memory {@link NiceHashStateStore}) plus the owned-order ledger, and lets
 * the dashboard flip the run mode. Deliberately small and self-contained; the
 * full Braiins HTTP server is not reused.
 *
 * Routes:
 *   GET  /api/health                 - liveness + build number
 *   GET  /api/nicehash/status        - latest observed state + proposals/outcomes
 *   GET  /api/nicehash/orders        - owned-order ledger rows
 *   POST /api/nicehash/run-mode      - { mode: DRY_RUN | LIVE | PAUSED }
 */

import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import type { NiceHashStateStore } from '../controller/nicehash/state-store.js';
import type { NiceHashControllerConfig, Proposal, RunMode } from '../controller/nicehash/types.js';
import type { NiceHashTickResult, TickOutcome } from '../controller/nicehash/tick.js';
import type { NiceHashOrdersRepo } from '../state/repos/nicehash_orders.js';

export interface NiceHashHttpDeps {
  readonly store: NiceHashStateStore;
  readonly ledger: NiceHashOrdersRepo;
  readonly config: NiceHashControllerConfig;
  readonly buildNumber: number;
  /** Seconds between ticks - surfaced so the UI can show the next-tick countdown. */
  readonly tickSeconds: number;
}

const RUN_MODES: readonly RunMode[] = ['DRY_RUN', 'LIVE', 'PAUSED'];

function proposalView(p: Proposal): { kind: string; reason: string } {
  return { kind: p.kind, reason: p.reason };
}

function outcomeView(o: TickOutcome): { kind: string; outcome: string; detail: string } {
  const detail =
    o.outcome === 'BLOCKED'
      ? o.reason
      : o.outcome === 'FAILED'
        ? o.error
        : 'note' in o
          ? (o.note ?? '')
          : '';
  return { kind: o.proposal.kind, outcome: o.outcome, detail };
}

function statusView(result: NiceHashTickResult | null, deps: NiceHashHttpDeps): unknown {
  const cfg = deps.config;
  const configView = {
    algorithm: cfg.algorithm,
    market: cfg.market,
    pool_id: cfg.pool_id,
    target_speed_units: cfg.target_speed_units,
    overpay_btc_per_unit_day: cfg.overpay_btc_per_unit_day,
    max_price_btc_per_unit_day: cfg.max_price_btc_per_unit_day,
    refill_amount_btc: cfg.refill_amount_btc,
    refill_when_runway_hours: cfg.refill_when_runway_hours,
  };
  if (!result) {
    return {
      run_mode: deps.store.getRunMode(),
      tick_at: null,
      tick_seconds: deps.tickSeconds,
      build: deps.buildNumber,
      config: configView,
      market: null,
      balance_btc: null,
      owned_orders: [],
      unknown_orders: [],
      proposals: [],
      outcomes: [],
    };
  }
  const s = result.state;
  return {
    run_mode: s.run_mode,
    tick_at: s.tick_at,
    tick_seconds: deps.tickSeconds,
    build: deps.buildNumber,
    config: configView,
    market: s.market,
    balance_btc: s.balance_btc,
    hashprice_btc_per_unit_day: s.hashprice_btc_per_unit_day,
    owned_orders: s.owned_orders,
    unknown_orders: s.unknown_orders,
    proposals: result.proposals.map(proposalView),
    outcomes: result.outcomes.map(outcomeView),
  };
}

export async function createNiceHashHttpServer(deps: NiceHashHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, build: deps.buildNumber }));

  app.get('/api/nicehash/status', async () => statusView(deps.store.getLast(), deps));

  app.get('/api/nicehash/orders', async () => {
    const rows = await deps.ledger.list();
    return { orders: rows };
  });

  app.post('/api/nicehash/run-mode', async (req, reply) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode;
    if (typeof mode !== 'string' || !RUN_MODES.includes(mode as RunMode)) {
      return reply.code(400).send({ error: `mode must be one of ${RUN_MODES.join(', ')}` });
    }
    deps.store.setRunMode(mode as RunMode);
    return { run_mode: deps.store.getRunMode() };
  });

  return app;
}

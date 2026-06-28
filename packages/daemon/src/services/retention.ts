/**
 * Periodic retention maintenance for the append-only log tables
 * (tick_metrics, decisions, alerts). Deletes rows older than per-table
 * cutoffs configured on AppConfig. Runs on a long interval (hourly by
 * default) so it doesn't thrash the DB.
 *
 * Keep two retention horizons for `decisions`:
 *   - uneventful (empty proposed array) - short, default 7 days
 *   - eventful (at least one proposal) - long, default keep-forever
 *
 * The vast majority of decisions rows are uneventful ticks that carry
 * no forensic value; pruning them aggressively is the whole point of
 * this service.
 *
 * `alerts` (#119): prune by age, gated on terminal delivery_status so
 * a long-running outage's still-retrying row is never dropped on age
 * alone.
 */

import type { AlertsRepo } from '../state/repos/alerts.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { DecisionsRepo } from '../state/repos/decisions.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionServiceOptions {
  /** Milliseconds between runs. Defaults to 1 hour. */
  readonly intervalMs?: number;
  /** For tests: override the clock. */
  readonly now?: () => number;
  /** For tests: override the scheduler. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Caller-facing log hook; defaults to console.warn. */
  readonly log?: (msg: string) => void;
}

export class RetentionService {
  private readonly configRepo: ConfigRepo;
  private readonly tickMetricsRepo: TickMetricsRepo;
  private readonly decisionsRepo: DecisionsRepo;
  private readonly alertsRepo: AlertsRepo;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    configRepo: ConfigRepo,
    tickMetricsRepo: TickMetricsRepo,
    decisionsRepo: DecisionsRepo,
    alertsRepo: AlertsRepo,
    opts: RetentionServiceOptions = {},
  ) {
    this.configRepo = configRepo;
    this.tickMetricsRepo = tickMetricsRepo;
    this.decisionsRepo = decisionsRepo;
    this.alertsRepo = alertsRepo;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  start(): void {
    if (this.timer) return;
    // Run once on boot so a just-upgraded daemon drops excess rows
    // immediately rather than waiting up to an hour.
    void this.guardedRun();
    this.timer = this.setIntervalFn(() => {
      void this.guardedRun();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  private async guardedRun(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try { await this.runOnce(); } catch { /* logged inside runOnce */ } finally { this.inFlight = false; }
  }

  async runOnce(): Promise<{
    tick_metrics_deleted: number;
    decisions_uneventful_deleted: number;
    decisions_eventful_deleted: number;
    alerts_deleted: number;
  }> {
    const cfg = await this.configRepo.get();
    if (!cfg) {
      return {
        tick_metrics_deleted: 0,
        decisions_uneventful_deleted: 0,
        decisions_eventful_deleted: 0,
        alerts_deleted: 0,
      };
    }
    const t = this.now();

    let tickMetricsDeleted = 0;
    if (cfg.tick_metrics_retention_days > 0) {
      const cutoff = t - cfg.tick_metrics_retention_days * DAY_MS;
      try {
        await this.tickMetricsRepo.pruneOlderThan(cutoff);
        // tick_metrics's prune returns void; we don't get a count.
        // That's fine - the summary line just won't populate this.
      } catch (err) {
        this.log(`[retention] tick_metrics prune failed: ${(err as Error).message}`);
      }
    }

    let unevDeleted = 0;
    if (cfg.decisions_uneventful_retention_days > 0) {
      const cutoff = t - cfg.decisions_uneventful_retention_days * DAY_MS;
      try {
        unevDeleted = await this.decisionsRepo.pruneUneventfulOlderThan(cutoff);
      } catch (err) {
        this.log(`[retention] decisions uneventful prune failed: ${(err as Error).message}`);
      }
    }

    let evDeleted = 0;
    if (cfg.decisions_eventful_retention_days > 0) {
      const cutoff = t - cfg.decisions_eventful_retention_days * DAY_MS;
      try {
        evDeleted = await this.decisionsRepo.pruneEventfulOlderThan(cutoff);
      } catch (err) {
        this.log(`[retention] decisions eventful prune failed: ${(err as Error).message}`);
      }
    }

    let alertsDeleted = 0;
    if (cfg.alerts_retention_days > 0) {
      const cutoff = t - cfg.alerts_retention_days * DAY_MS;
      try {
        alertsDeleted = await this.alertsRepo.pruneOlderThan(cutoff);
      } catch (err) {
        this.log(`[retention] alerts prune failed: ${(err as Error).message}`);
      }
    }

    if (tickMetricsDeleted + unevDeleted + evDeleted + alertsDeleted > 0) {
      this.log(
        `[retention] pruned: tick_metrics=${tickMetricsDeleted} decisions_uneventful=${unevDeleted} decisions_eventful=${evDeleted} alerts=${alertsDeleted}`,
      );
    }
    return {
      tick_metrics_deleted: tickMetricsDeleted,
      decisions_uneventful_deleted: unevDeleted,
      decisions_eventful_deleted: evDeleted,
      alerts_deleted: alertsDeleted,
    };
  }
}

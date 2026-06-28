/**
 * #149: repository for the `solo_miners` config table and the
 * companion `solo_miner_samples` per-tick history.
 *
 * The config table is operator-curated (manual add / edit / delete
 * via Config -> Solo miners on the dashboard). The samples table
 * is daemon-written: every tick the AxeOSPoller writes one row per
 * enabled device. Reads are by dashboard `/api/solo-miners` and by
 * the alert evaluator (delta computation for share-rejection,
 * timer arming for overheating / zero-hashrate / stratum-drift).
 */

import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export interface SoloMinerRow {
  readonly id: number;
  readonly label: string;
  readonly ip: string;
  readonly enabled: boolean;
  readonly sort_order: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface CreateSoloMinerArgs {
  readonly label: string;
  readonly ip: string;
  readonly enabled?: boolean;
}

export interface UpdateSoloMinerArgs {
  readonly label?: string;
  readonly ip?: string;
  readonly enabled?: boolean;
  readonly sort_order?: number;
}

export interface SoloMinerSampleRow {
  readonly device_id: number;
  readonly tick_at: number;
  readonly reachable: boolean;
  readonly hashrate_instant_ghs: number | null;
  readonly hashrate_1m_ghs: number | null;
  readonly hashrate_10m_ghs: number | null;
  readonly hashrate_1h_ghs: number | null;
  readonly expected_hashrate_ghs: number | null;
  readonly temp_c: number | null;
  readonly vr_temp_c: number | null;
  readonly power_w: number | null;
  readonly voltage_v: number | null;
  readonly current_a: number | null;
  readonly shares_accepted: number | null;
  readonly shares_rejected: number | null;
  readonly uptime_seconds: number | null;
  readonly asic_model: string | null;
  readonly version: string | null;
  readonly stratum_url: string | null;
  readonly stratum_port: number | null;
  readonly stratum_user: string | null;
  readonly best_diff_text: string | null;
  readonly best_session_diff_text: string | null;
  readonly best_diff_numeric: number | null;
}

export interface InsertSampleArgs {
  readonly device_id: number;
  readonly tick_at: number;
  readonly reachable: boolean;
  readonly hashrate_instant_ghs?: number | null;
  readonly hashrate_1m_ghs?: number | null;
  readonly hashrate_10m_ghs?: number | null;
  readonly hashrate_1h_ghs?: number | null;
  readonly expected_hashrate_ghs?: number | null;
  readonly temp_c?: number | null;
  readonly vr_temp_c?: number | null;
  readonly power_w?: number | null;
  readonly voltage_v?: number | null;
  readonly current_a?: number | null;
  readonly shares_accepted?: number | null;
  readonly shares_rejected?: number | null;
  readonly uptime_seconds?: number | null;
  readonly asic_model?: string | null;
  readonly version?: string | null;
  readonly stratum_url?: string | null;
  readonly stratum_port?: number | null;
  readonly stratum_user?: string | null;
  readonly best_diff_text?: string | null;
  readonly best_session_diff_text?: string | null;
  readonly best_diff_numeric?: number | null;
}

export class SoloMinersRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<SoloMinerRow[]> {
    const rows = await this.db
      .selectFrom('solo_miners')
      .selectAll()
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toRow);
  }

  async listEnabled(): Promise<SoloMinerRow[]> {
    const all = await this.list();
    return all.filter((r) => r.enabled);
  }

  async findById(id: number): Promise<SoloMinerRow | null> {
    const row = await this.db
      .selectFrom('solo_miners')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toRow(row) : null;
  }

  async create(args: CreateSoloMinerArgs, now: number = Date.now()): Promise<SoloMinerRow> {
    // Place new rows at the end of the sort order so the operator's
    // existing arrangement isn't disturbed.
    const maxRow = await this.db
      .selectFrom('solo_miners')
      .select((eb) => eb.fn.max<number>('sort_order').as('m'))
      .executeTakeFirst();
    const nextSort = (maxRow?.m ?? -1) + 1;

    const inserted = await this.db
      .insertInto('solo_miners')
      .values({
        label: args.label,
        ip: args.ip,
        enabled: (args.enabled ?? true) ? 1 : 0,
        sort_order: nextSort,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRow(inserted);
  }

  async update(
    id: number,
    args: UpdateSoloMinerArgs,
    now: number = Date.now(),
  ): Promise<SoloMinerRow | null> {
    const patch: Record<string, unknown> = { updated_at: now };
    if (args.label !== undefined) patch.label = args.label;
    if (args.ip !== undefined) patch.ip = args.ip;
    if (args.enabled !== undefined) patch.enabled = args.enabled ? 1 : 0;
    if (args.sort_order !== undefined) patch.sort_order = args.sort_order;
    await this.db.updateTable('solo_miners').set(patch).where('id', '=', id).execute();
    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    // ON DELETE CASCADE drops the matching solo_miner_samples rows.
    await this.db.deleteFrom('solo_miners').where('id', '=', id).execute();
  }

  /**
   * Batch-insert one tick's samples (one per device). Single
   * transaction so a partial fan-out failure doesn't leave the
   * table half-written.
   */
  async insertSamples(samples: ReadonlyArray<InsertSampleArgs>): Promise<void> {
    if (samples.length === 0) return;
    const values = samples.map((s) => ({
      device_id: s.device_id,
      tick_at: s.tick_at,
      reachable: (s.reachable ? 1 : 0) as 0 | 1,
      hashrate_instant_ghs: s.hashrate_instant_ghs ?? null,
      hashrate_1m_ghs: s.hashrate_1m_ghs ?? null,
      hashrate_10m_ghs: s.hashrate_10m_ghs ?? null,
      hashrate_1h_ghs: s.hashrate_1h_ghs ?? null,
      expected_hashrate_ghs: s.expected_hashrate_ghs ?? null,
      temp_c: s.temp_c ?? null,
      vr_temp_c: s.vr_temp_c ?? null,
      power_w: s.power_w ?? null,
      voltage_v: s.voltage_v ?? null,
      current_a: s.current_a ?? null,
      shares_accepted: s.shares_accepted ?? null,
      shares_rejected: s.shares_rejected ?? null,
      uptime_seconds: s.uptime_seconds ?? null,
      asic_model: s.asic_model ?? null,
      version: s.version ?? null,
      stratum_url: s.stratum_url ?? null,
      stratum_port: s.stratum_port ?? null,
      stratum_user: s.stratum_user ?? null,
      best_diff_text: s.best_diff_text ?? null,
      best_session_diff_text: s.best_session_diff_text ?? null,
      best_diff_numeric: s.best_diff_numeric ?? null,
    }));
    await this.db.insertInto('solo_miner_samples').values(values).execute();
  }

  /**
   * Latest sample per device. Used by `/api/solo-miners/snapshot` to
   * feed the Status card and by alert evaluators for the live read.
   */
  async latestSamples(): Promise<Map<number, SoloMinerSampleRow>> {
    const rows = await this.db
      .selectFrom('solo_miner_samples as s')
      .innerJoin(
        (eb) =>
          eb
            .selectFrom('solo_miner_samples')
            .select((eb2) => ['device_id', eb2.fn.max<number>('tick_at').as('max_tick')])
            .groupBy('device_id')
            .as('latest'),
        (join) =>
          join
            .onRef('s.device_id', '=', 'latest.device_id')
            .onRef('s.tick_at', '=', 'latest.max_tick'),
      )
      .selectAll('s')
      .execute();
    const out = new Map<number, SoloMinerSampleRow>();
    for (const row of rows) out.set(row.device_id, toSampleRow(row));
    return out;
  }

  /**
   * Samples since `since_tick_at` (exclusive). Used for chart-series
   * back-fill on /status's hashrate + price charts.
   */
  async samplesSince(since_tick_at: number): Promise<SoloMinerSampleRow[]> {
    const rows = await this.db
      .selectFrom('solo_miner_samples')
      .selectAll()
      .where('tick_at', '>', since_tick_at)
      .orderBy('tick_at', 'asc')
      .execute();
    return rows.map(toSampleRow);
  }

  /** Drop samples older than `cutoff_ms`. Used by the retention service. */
  async pruneSamplesOlderThan(cutoff_ms: number): Promise<number> {
    const result = await this.db
      .deleteFrom('solo_miner_samples')
      .where('tick_at', '<', cutoff_ms)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /**
   * #149: aggregated per-tick fleet series for the chart right-axis.
   * One row per `tick_at`, summed / maxed across the devices that
   * reported data for that tick. Used by `GET /api/solo-miners/series`
   * which feeds the four new chart right-axis options.
   */
  async fleetSeriesSince(since_tick_at: number): Promise<
    Array<{
      tick_at: number;
      total_hashrate_ghs: number | null;
      total_power_w: number | null;
      max_temp_c: number | null;
      device_count: number;
      max_best_diff: number | null;
    }>
  > {
    const rows = await this.db
      .selectFrom('solo_miner_samples')
      .where('tick_at', '>=', since_tick_at)
      .groupBy('tick_at')
      .select((eb) => [
        'tick_at',
        eb.fn.sum<number | null>('hashrate_10m_ghs').as('hr_10m_sum'),
        eb.fn.sum<number | null>('hashrate_1m_ghs').as('hr_1m_sum'),
        eb.fn.sum<number | null>('hashrate_instant_ghs').as('hr_instant_sum'),
        eb.fn.sum<number | null>('power_w').as('power_sum'),
        eb.fn.max<number | null>('temp_c').as('temp_max'),
        eb.fn.max<number | null>('vr_temp_c').as('vr_temp_max'),
        eb.fn.max<number | null>('best_diff_numeric').as('best_diff_max'),
        eb.fn
          .sum<number>(
            eb
              .case()
              .when(
                eb.and([
                  eb('reachable', '=', 1),
                  eb.or([
                    eb('hashrate_10m_ghs', '>', 0),
                    eb('hashrate_1m_ghs', '>', 0),
                    eb('hashrate_instant_ghs', '>', 0),
                  ]),
                ]),
              )
              .then(1)
              .else(0)
              .end(),
          )
          .as('active_count'),
      ])
      .orderBy('tick_at', 'asc')
      .execute();
    return rows.map((r) => {
      const hr =
        coalesceNum(r.hr_10m_sum) ?? coalesceNum(r.hr_1m_sum) ?? coalesceNum(r.hr_instant_sum);
      const temp = maxNullable(coalesceNum(r.temp_max), coalesceNum(r.vr_temp_max));
      const active = Number(r.active_count ?? 0);
      return {
        tick_at: Number(r.tick_at),
        total_hashrate_ghs: hr ?? (active === 0 ? 0 : null),
        total_power_w: coalesceNum(r.power_sum) ?? (active === 0 ? 0 : null),
        max_temp_c: temp ?? (active === 0 ? 0 : null),
        device_count: active,
        max_best_diff: coalesceNum(r.best_diff_max),
      };
    });
  }

  /** #204: insert a record-breaking best difficulty event. */
  async insertBestDiffEvent(args: {
    recorded_at: number;
    difficulty: number;
    previous_difficulty: number | null;
    device_label: string;
    device_ip: string;
  }): Promise<void> {
    await this.db
      .insertInto('solo_best_difficulty_events')
      .values(args)
      .execute();
  }

  /** #204: best difficulty events for chart trophy markers. */
  async bestDiffEventsSince(since_ms: number): Promise<
    Array<{ recorded_at: number; difficulty: number }>
  > {
    const rows = await this.db
      .selectFrom('solo_best_difficulty_events')
      .select(['recorded_at', 'difficulty'])
      .where('recorded_at', '>=', since_ms)
      .orderBy('recorded_at', 'asc')
      .execute();
    return rows.map((r) => ({
      recorded_at: Number(r.recorded_at),
      difficulty: Number(r.difficulty),
    }));
  }
}

function coalesceNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function toRow(row: {
  id: number;
  label: string;
  ip: string;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}): SoloMinerRow {
  return {
    id: row.id,
    label: row.label,
    ip: row.ip,
    enabled: row.enabled === 1,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toSampleRow(row: {
  device_id: number;
  tick_at: number;
  reachable: number;
  hashrate_instant_ghs: number | null;
  hashrate_1m_ghs: number | null;
  hashrate_10m_ghs: number | null;
  hashrate_1h_ghs: number | null;
  expected_hashrate_ghs: number | null;
  temp_c: number | null;
  vr_temp_c: number | null;
  power_w: number | null;
  voltage_v: number | null;
  current_a: number | null;
  shares_accepted: number | null;
  shares_rejected: number | null;
  uptime_seconds: number | null;
  asic_model: string | null;
  version: string | null;
  stratum_url: string | null;
  stratum_port: number | null;
  stratum_user: string | null;
  best_diff_text: string | null;
  best_session_diff_text: string | null;
  best_diff_numeric: number | null;
}): SoloMinerSampleRow {
  return { ...row, reachable: row.reachable === 1 };
}

/**
 * #149: per-tick poller for the operator's solo-mining devices
 * (Bitaxe / AxeOS).
 *
 * Reads the live config every tick. When `solo_mining_enabled` is
 * false the poller idles entirely (no AxeOS HTTP calls, no DB
 * writes); flipping the toggle on in Config takes effect on the
 * next tick without a daemon restart.
 *
 * Fan-out across N devices uses `Promise.allSettled` so one
 * unreachable unit can't slow a healthy fleet's poll. Each call
 * has its own 2s timeout in the AxeOSClient. The poller also
 * keeps the latest per-device snapshot in memory so HTTP routes
 * (`/api/solo-miners/snapshot`) can return without a DB round-trip.
 */

import type { AppConfig } from '../config/schema.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { SoloMinerRow, SoloMinersRepo } from '../state/repos/solo_miners.js';
import { AxeOSClient, type AxeOSFetchResult } from './axeos.js';
import { assessSoloHashing, type SoloHaltReason } from './solo-hashing.js';

export interface SoloMinerSnapshotEntry {
  readonly device: SoloMinerRow;
  readonly last_polled_at: number;
  readonly reachable: boolean;
  /** AxeOS `hashRate` (instantaneous). Fallback when windowed fields are null. */
  readonly hashrate_instant_ghs: number | null;
  readonly hashrate_1m_ghs: number | null;
  readonly hashrate_10m_ghs: number | null;
  readonly hashrate_1h_ghs: number | null;
  readonly expected_hashrate_ghs: number | null;
  readonly temp_c: number | null;
  readonly vr_temp_c: number | null;
  readonly power_w: number | null;
  /** #291: stock-Bitaxe `overheat_mode` normalised to a boolean. */
  readonly overheat_mode: boolean | null;
  /** #291: NerdQAxe `shutdown` flag. */
  readonly shutdown: boolean | null;
  /** #291: ASIC frequency (MHz), corroborates a halt. */
  readonly frequency_mhz: number | null;
  /** #291: reachable but provably not producing the hashrate it
   *  reports (overheated / shut down / stale frozen reading). When
   *  true the card and fleet tiles treat hashrate as 0 and the
   *  zero-hashrate alert must not "recover". */
  readonly halted: boolean;
  /** Why we think it's halted, for the alert/card copy. */
  readonly halted_reason: SoloHaltReason | null;
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
  /** Lifetime best share difficulty (e.g. "149.53G"). */
  readonly best_diff_text: string | null;
  /** Since-current-boot best share difficulty. */
  readonly best_session_diff_text: string | null;
  /**
   * Lifetime best share difficulty as a raw number. Exact when the
   * firmware reports a number (NerdAxe, #260); parsed from the
   * suffixed string (3 significant digits) on stock Bitaxe.
   */
  readonly best_diff_numeric: number | null;
  readonly error: string | null;
}

export interface SoloMinerSnapshot {
  readonly enabled: boolean;
  readonly entries: ReadonlyArray<SoloMinerSnapshotEntry>;
}

/** #204: result of the per-tick best difficulty check. */
export interface BestDiffResult {
  readonly isNewRecord: boolean;
  readonly fleetMax: number | null;
  readonly previousRecord: number | null;
  readonly deviceLabel: string | null;
  readonly deviceIp: string | null;
}

export interface AxeOSPollerOptions {
  readonly cfgRef: { value: AppConfig };
  readonly repo: SoloMinersRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly client?: AxeOSClient;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

const MAGNITUDE_RE = /^([\d.]+)\s*([KMGTPE]?)$/i;
const MAGNITUDE_MAP: Record<string, number> = {
  '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

export function parseMagnitudeSuffixed(s: string | number | null | undefined): number | null {
  // NerdAxe / NerdQAxe firmware reports best difficulty as a raw
  // number rather than Bitaxe's suffixed string (#260) - same unit
  // (share difficulty vs diff 1), no parsing needed.
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (!s) return null;
  const m = MAGNITUDE_RE.exec(s.trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = MAGNITUDE_MAP[m[2]!.toUpperCase()] ?? 1;
  return base * multiplier;
}

const MAGNITUDE_STEPS: ReadonlyArray<readonly [string, number]> = [
  ['E', 1e18], ['P', 1e15], ['T', 1e12], ['G', 1e9], ['M', 1e6], ['K', 1e3],
];

/**
 * Inverse of parseMagnitudeSuffixed: render a raw difficulty number
 * the way AxeOS renders it ("58.39M", "4.29G") so numeric-reporting
 * firmwares (NerdAxe, #260) display consistently with Bitaxes in
 * the same fleet.
 */
export function formatMagnitudeSuffixed(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  for (const [suffix, mult] of MAGNITUDE_STEPS) {
    if (Math.abs(n) >= mult) {
      const scaled = n / mult;
      const text = scaled >= 100 ? scaled.toFixed(1) : scaled.toFixed(2);
      return `${text.replace(/\.?0+$/, '')}${suffix}`;
    }
  }
  return String(n);
}

/**
 * Normalise AxeOS best-difficulty values to display text. Bitaxe
 * sends a pre-formatted string - pass through. NerdAxe sends a raw
 * number - format it ourselves (#260).
 */
function bestDiffDisplayText(v: string | number | null | undefined): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? formatMagnitudeSuffixed(v) : null;
  return v ?? null;
}

export class AxeOSPoller {
  private readonly client: AxeOSClient;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private snapshot: SoloMinerSnapshot = { enabled: false, entries: [] };
  private lastBestDiffResult: BestDiffResult = {
    isNewRecord: false, fleetMax: null, previousRecord: null,
    deviceLabel: null, deviceIp: null,
  };

  constructor(private readonly options: AxeOSPollerOptions) {
    this.client = options.client ?? new AxeOSClient();
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  getSnapshot(): SoloMinerSnapshot {
    return this.snapshot;
  }

  getLastBestDiffResult(): BestDiffResult {
    return this.lastBestDiffResult;
  }

  /**
   * One iteration. Called from the main daemon tick loop. Never
   * throws - any per-device error is captured into that device's
   * snapshot entry as `reachable: false, error: <message>`.
   *
   * `canonicalTickAt` (optional, post-#149-part4 follow-up) lets
   * the caller pin the persisted sample's tick_at to the same
   * value `tick_metrics` uses for the same tick. Without it, each
   * subsystem captured its own `Date.now()` and produced ~500ms-
   * 1s drift between the two tables - which broke the chart's
   * exact-match `tick_at` join and rendered the new right-axis
   * series empty even with thousands of samples in the table.
   */
  async tick(canonicalTickAt?: number): Promise<void> {
    const cfg = this.options.cfgRef.value;
    if (!cfg.solo_mining_enabled) {
      this.snapshot = { enabled: false, entries: [] };
      return;
    }

    const devices = await this.options.repo.listEnabled();
    if (devices.length === 0) {
      this.snapshot = { enabled: true, entries: [] };
      return;
    }

    const tickAt = canonicalTickAt ?? this.now();
    const results = await Promise.allSettled(
      devices.map(async (d) => ({ device: d, result: await this.client.getSystemInfo(d.ip) })),
    );

    const entries: SoloMinerSnapshotEntry[] = [];
    const sampleInserts = [];
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i]!;
      const settled = results[i]!;
      let fetched: AxeOSFetchResult;
      if (settled.status === 'fulfilled') {
        fetched = settled.value.result;
      } else {
        // allSettled rejection shouldn't happen because getSystemInfo
        // never throws, but defensively treat it as unreachable.
        fetched = {
          reachable: false,
          info: null,
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        };
      }
      const info = fetched.info ?? null;
      let entry: SoloMinerSnapshotEntry;
      try {
        // #291: normalise the firmware halt flags (stock Bitaxe sends
        // overheat_mode as 0/1, NerdQAxe sends shutdown as a bool;
        // NerdAxe sends neither) and derive the "actually hashing"
        // verdict from flags + a hashrate-per-watt sanity check.
        const overheatRaw = info?.overheat_mode;
        const overheat_mode =
          overheatRaw === undefined || overheatRaw === null
            ? null
            : overheatRaw === 1 || overheatRaw === true;
        const shutdown = typeof info?.shutdown === 'boolean' ? info.shutdown : null;
        const frequency_mhz = info?.frequency ?? null;
        const liveHashrate =
          (info?.hashRate_10m ?? 0) > 0
            ? info!.hashRate_10m!
            : (info?.hashRate_1m ?? 0) > 0
              ? info!.hashRate_1m!
              : (info?.hashRate_1h ?? 0) > 0
                ? info!.hashRate_1h!
                : (info?.hashRate ?? 0) > 0
                  ? info!.hashRate!
                  : null;
        const hashing = assessSoloHashing({
          reachable: fetched.reachable,
          live_hashrate_ghs: liveHashrate,
          power_w: info?.power ?? null,
          overheat_mode,
          shutdown,
        });
        entry = {
          device,
          last_polled_at: tickAt,
          reachable: fetched.reachable,
          hashrate_instant_ghs: info?.hashRate ?? null,
          hashrate_1m_ghs: info?.hashRate_1m ?? null,
          hashrate_10m_ghs: info?.hashRate_10m ?? null,
          hashrate_1h_ghs: info?.hashRate_1h ?? null,
          expected_hashrate_ghs: info?.expectedHashrate ?? null,
          temp_c: info?.temp ?? null,
          vr_temp_c: info?.vrTemp ?? null,
          power_w: info?.power ?? null,
          overheat_mode,
          shutdown,
          frequency_mhz,
          halted: hashing.halted,
          halted_reason: hashing.reason,
          voltage_v: info?.voltage ?? null,
          current_a: info?.current ?? null,
          shares_accepted: info?.sharesAccepted ?? null,
          shares_rejected: info?.sharesRejected ?? null,
          uptime_seconds: info?.uptimeSeconds ?? null,
          asic_model: info?.ASICModel ?? null,
          version: info?.version ?? null,
          stratum_url: info?.stratumURL ?? null,
          stratum_port: info?.stratumPort ?? null,
          stratum_user: info?.stratumUser ?? null,
          best_diff_text: bestDiffDisplayText(info?.bestDiff),
          best_session_diff_text: bestDiffDisplayText(info?.bestSessionDiff),
          best_diff_numeric: parseMagnitudeSuffixed(info?.bestDiff),
          error: fetched.error,
        };
      } catch (e) {
        // #260 post-mortem: a payload-shape surprise (NerdAxe's
        // numeric bestDiff crashing the string parser) threw out of
        // tick() *before* the snapshot assignment below - so every
        // successful poll was discarded while failed polls rendered,
        // freezing the Status card on the last failure forever. One
        // device's odd payload must never take down the fleet tick:
        // degrade that device to an error entry and keep going.
        const message = e instanceof Error ? e.message : String(e);
        this.log(`[axeos-poller] payload mapping failed for ${device.ip}: ${message}`);
        entry = {
          device,
          last_polled_at: tickAt,
          reachable: false,
          hashrate_instant_ghs: null,
          hashrate_1m_ghs: null,
          hashrate_10m_ghs: null,
          hashrate_1h_ghs: null,
          expected_hashrate_ghs: null,
          temp_c: null,
          vr_temp_c: null,
          power_w: null,
          overheat_mode: null,
          shutdown: null,
          frequency_mhz: null,
          halted: false,
          halted_reason: null,
          voltage_v: null,
          current_a: null,
          shares_accepted: null,
          shares_rejected: null,
          uptime_seconds: null,
          asic_model: null,
          version: null,
          stratum_url: null,
          stratum_port: null,
          stratum_user: null,
          best_diff_text: null,
          best_session_diff_text: null,
          best_diff_numeric: null,
          error: `payload mapping failed: ${message}`,
        };
      }
      const bestDiffNumeric = entry.best_diff_numeric;
      entries.push(entry);
      sampleInserts.push({
        device_id: device.id,
        tick_at: tickAt,
        reachable: entry.reachable,
        hashrate_instant_ghs: entry.hashrate_instant_ghs,
        hashrate_1m_ghs: entry.hashrate_1m_ghs,
        hashrate_10m_ghs: entry.hashrate_10m_ghs,
        hashrate_1h_ghs: entry.hashrate_1h_ghs,
        expected_hashrate_ghs: entry.expected_hashrate_ghs,
        temp_c: entry.temp_c,
        vr_temp_c: entry.vr_temp_c,
        power_w: entry.power_w,
        voltage_v: entry.voltage_v,
        current_a: entry.current_a,
        shares_accepted: entry.shares_accepted,
        shares_rejected: entry.shares_rejected,
        uptime_seconds: entry.uptime_seconds,
        asic_model: entry.asic_model,
        version: entry.version,
        stratum_url: entry.stratum_url,
        stratum_port: entry.stratum_port,
        stratum_user: entry.stratum_user,
        best_diff_text: entry.best_diff_text,
        best_session_diff_text: entry.best_session_diff_text,
        best_diff_numeric: bestDiffNumeric,
      });
    }

    try {
      await this.options.repo.insertSamples(sampleInserts);
    } catch (e) {
      this.log(`[axeos-poller] sample persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.snapshot = { enabled: true, entries };

    // #204: detect fleet-wide best difficulty records.
    await this.checkBestDifficulty(entries, tickAt);
  }

  private async checkBestDifficulty(
    entries: SoloMinerSnapshotEntry[],
    tickAt: number,
  ): Promise<void> {
    let fleetMax: number | null = null;
    let bestLabel: string | null = null;
    let bestIp: string | null = null;
    for (const e of entries) {
      if (!e.reachable) continue;
      // Prefer the exact numeric (lossless for NerdAxe-style numeric
      // firmwares, #260) over re-parsing the 3-significant-digit
      // display text.
      const val = e.best_diff_numeric ?? parseMagnitudeSuffixed(e.best_diff_text);
      if (val !== null && (fleetMax === null || val > fleetMax)) {
        fleetMax = val;
        bestLabel = e.device.label;
        bestIp = e.device.ip;
      }
    }
    if (fleetMax === null) {
      this.lastBestDiffResult = {
        isNewRecord: false, fleetMax: null, previousRecord: null,
        deviceLabel: null, deviceIp: null,
      };
      return;
    }

    let stored: number | null = null;
    try {
      const rs = await this.options.runtimeRepo.get();
      stored = rs?.solo_best_difficulty_all_time ?? null;
    } catch {
      // First boot or missing row - treat as no prior record.
    }

    // First measurement (stored === null) silently baselines the
    // high-water mark without firing a notification or logging an
    // event - the device has likely held this difficulty for a while
    // before the feature was enabled.
    if (stored === null) {
      try {
        await this.options.runtimeRepo.patch({ solo_best_difficulty_all_time: fleetMax });
        this.log(`[axeos-poller] baselined fleet best difficulty: ${fleetMax}`);
      } catch (e) {
        this.log(`[axeos-poller] best-diff baseline persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.lastBestDiffResult = {
        isNewRecord: false, fleetMax, previousRecord: null,
        deviceLabel: bestLabel, deviceIp: bestIp,
      };
      return;
    }

    const isNewRecord = fleetMax > stored;
    if (isNewRecord) {
      try {
        await this.options.runtimeRepo.patch({ solo_best_difficulty_all_time: fleetMax });
        await this.options.repo.insertBestDiffEvent({
          recorded_at: tickAt,
          difficulty: fleetMax,
          previous_difficulty: stored,
          device_label: bestLabel!,
          device_ip: bestIp!,
        });
        this.log(`[axeos-poller] new fleet best difficulty: ${fleetMax} (prev: ${stored})`);
      } catch (e) {
        this.log(`[axeos-poller] best-diff event persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.lastBestDiffResult = {
      isNewRecord, fleetMax, previousRecord: stored,
      deviceLabel: bestLabel, deviceIp: bestIp,
    };
  }
}

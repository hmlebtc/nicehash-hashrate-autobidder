/**
 * #149 follow-up: local-network scanner for the "Scan local network"
 * button on Config -> Solo miners. Mirrors what the AxeOS Swarm tab
 * does client-side: walk a /24, probe each IP for `/api/system/info`
 * with a short timeout, and collect every host that responds with a
 * parseable JSON body (so non-Bitaxe hosts on the same subnet -
 * routers, NAS, printers - get filtered out by the failed JSON parse
 * rather than polluting the suggestion list).
 *
 * Subnet selection (#156):
 * - If the caller passes a CIDR, scanner uses it directly. Needed on
 *   Umbrel where the daemon container sees `10.21.0.0/24` (docker
 *   bridge) and never the host LAN where the Bitaxes live - the
 *   operator types e.g. `192.168.1.0/24` explicitly.
 * - Otherwise scanner deduces the /24 from the daemon's first
 *   non-loopback IPv4 interface via `os.networkInterfaces()`. Works
 *   on bare-metal where daemon shares the LAN with the miners.
 *
 * Progress streaming (#156 follow-up):
 * v1 fired all 254 probes in one `Promise.all` with a 200ms per-IP
 * timeout. From a Docker container the path is
 *   container -> docker bridge -> host NAT -> switch -> AP -> ESP32
 * which cold-ARP can blow past 200ms easily; ESP32-S3's small HTTP
 * stack under a 254-way SYN burst also drops packets. Operators saw
 * intermittent "No AxeOS devices found" even when the device was
 * obviously reachable, with success appearing once the per-tick
 * poller had kept ARP warm.
 *
 * Redesign:
 * - Scanner becomes a singleton-stateful background sweeper. POST
 *   /scan kicks off a run that stays in memory; the route returns
 *   immediately, the UI polls GET /scan/status to render a progress
 *   bar + live candidate list as discoveries happen.
 * - Probe loop runs at concurrency 8 (chunked rather than all-at-once)
 *   with a 1500ms per-IP timeout. Worst-case full-sweep ~48s; in
 *   practice much faster because most non-existent IPs RST quickly.
 * - One scan at a time. A POST while a scan is running returns 409
 *   so duplicate clicks don't fork the worker.
 */

import { networkInterfaces } from 'node:os';

import type { SoloMinersRepo } from '../state/repos/solo_miners.js';
import { AxeOSClient } from './axeos.js';

export interface ScanCandidate {
  /** IP that answered /api/system/info. */
  readonly ip: string;
  /** ASIC model reported by AxeOS (e.g. "BM1370"). null when the firmware doesn't expose it. */
  readonly asic_model: string | null;
  /** Firmware version string. */
  readonly version: string | null;
  /** Live hashrate (GH/s) at scan time - lets the operator pick the live one if duplicates appear. */
  readonly hashrate_ghs: number | null;
  /** True when an existing solo_miners row already owns this IP. */
  readonly already_added: boolean;
}

export type ScanState = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface ScanStatus {
  readonly state: ScanState;
  /** The CIDR being / that was scanned, or '' before the first run. */
  readonly cidr: string;
  /** Probes completed so far. */
  readonly done: number;
  /** Total probes for the active / most recent scan. 0 before the first run. */
  readonly total: number;
  /** Discovered AxeOS hosts so far (or the final list for state='done'). */
  readonly candidates: ReadonlyArray<ScanCandidate>;
  /** Set when state='error', otherwise null. */
  readonly error: string | null;
  /** Unix-ms when the active / most recent scan started. 0 if idle on first call. */
  readonly started_at: number;
  /** Unix-ms when the scan finished. null while running, set on done/error. */
  readonly finished_at: number | null;
}

export interface ScanStartResult {
  readonly ok: boolean;
  /** Set when ok=false; e.g. 'scan in progress' or 'invalid cidr'. */
  readonly error: string | null;
  /** Current status snapshot (initial state of the new scan when ok=true). */
  readonly status: ScanStatus;
}

export interface AxeOSScannerOptions {
  readonly repo: SoloMinersRepo;
  readonly client?: AxeOSClient;
  readonly interfaces?: typeof networkInterfaces;
  /**
   * Per-IP timeout for the scan probe. Default 1500ms - enough headroom
   * for cold-ARP + Docker NAT + ESP32's small HTTP stack on a busy LAN.
   */
  readonly probeTimeoutMs?: number;
  /** Number of probes in flight at once. Default 8. */
  readonly concurrency?: number;
}

export class AxeOSScanner {
  private readonly repo: SoloMinersRepo;
  private readonly client: AxeOSClient;
  private readonly interfaces: typeof networkInterfaces;
  private readonly concurrency: number;

  /**
   * #259 follow-up: cancellation flag for the in-flight worker loop.
   * Operator closing the scan dialog with X calls `cancel()`, which
   * flips this to true; the workers check it at every iteration and
   * exit early, the run() finaliser marks the status `cancelled`. A
   * subsequent `start()` resets the flag and kicks off a fresh sweep.
   */
  private cancelRequested = false;

  /**
   * #259 follow-up v2: abort controller plumbed through to every
   * in-flight probe's fetch. Build 605's cancel only set the
   * cancelRequested flag, which workers checked between probes - so
   * an 8-worker sweep with the 1.5 s probe timeout took up to 1.5 s
   * to actually wind down per worker. With the signal forwarded into
   * `getSystemInfo`, cancel aborts every fetch in-flight immediately;
   * workers see the rejection and bail on the next loop tick.
   */
  private currentAbort: AbortController | null = null;

  private status: ScanStatus = {
    state: 'idle',
    cidr: '',
    done: 0,
    total: 0,
    candidates: [],
    error: null,
    started_at: 0,
    finished_at: null,
  };

  constructor(options: AxeOSScannerOptions) {
    this.repo = options.repo;
    this.client =
      options.client ?? new AxeOSClient({ timeoutMs: options.probeTimeoutMs ?? 1_500 });
    this.interfaces = options.interfaces ?? networkInterfaces;
    this.concurrency = Math.max(1, options.concurrency ?? 8);
  }

  getStatus(): ScanStatus {
    return this.status;
  }

  /**
   * Kick off a background scan. Returns immediately. Poll getStatus()
   * to follow progress.
   */
  start(requestedCidr?: string | null): ScanStartResult {
    if (this.status.state === 'running') {
      return {
        ok: false,
        error: 'scan already in progress',
        status: this.status,
      };
    }

    let cidr: string | null;
    if (requestedCidr && requestedCidr.trim().length > 0) {
      const normalized = normalizeSlash24(requestedCidr.trim());
      if (!normalized) {
        const status: ScanStatus = {
          state: 'error',
          cidr: requestedCidr,
          done: 0,
          total: 0,
          candidates: [],
          error: `Invalid CIDR: ${requestedCidr}. Expected a /24 like 192.168.1.0/24.`,
          started_at: Date.now(),
          finished_at: Date.now(),
        };
        this.status = status;
        return { ok: false, error: status.error, status };
      }
      cidr = normalized;
    } else {
      cidr = deduceLocalSlash24(this.interfaces);
    }
    if (!cidr) {
      const status: ScanStatus = {
        state: 'error',
        cidr: '',
        done: 0,
        total: 0,
        candidates: [],
        error: 'No non-loopback IPv4 interface found - cannot infer local /24',
        started_at: Date.now(),
        finished_at: Date.now(),
      };
      this.status = status;
      return { ok: false, error: status.error, status };
    }

    const ips = expandSlash24(cidr);
    this.cancelRequested = false;
    this.currentAbort = new AbortController();
    this.status = {
      state: 'running',
      cidr,
      done: 0,
      total: ips.length,
      candidates: [],
      error: null,
      started_at: Date.now(),
      finished_at: null,
    };

    // Fire-and-forget. Status updates land on this.status as it runs.
    void this.run(cidr, ips, this.currentAbort.signal).catch((e) => {
      this.status = {
        ...this.status,
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
        finished_at: Date.now(),
      };
    });

    return { ok: true, error: null, status: this.status };
  }

  private async run(
    cidr: string,
    ips: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const existing = new Set((await this.repo.list()).map((r) => r.ip));
    const found: ScanCandidate[] = [];
    let cursor = 0;
    let completed = 0;

    const probe = async (ip: string): Promise<void> => {
      try {
        const r = await this.client.getSystemInfo(ip, signal);
        if (r.reachable && r.info) {
          const info = r.info;
          const looksLikeBitaxe =
            typeof info.ASICModel === 'string' ||
            typeof info.hashRate === 'number' ||
            typeof info.hashRate_1m === 'number';
          if (looksLikeBitaxe) {
            found.push({
              ip,
              asic_model: typeof info.ASICModel === 'string' ? info.ASICModel : null,
              version: typeof info.version === 'string' ? info.version : null,
              hashrate_ghs:
                typeof info.hashRate_10m === 'number'
                  ? info.hashRate_10m
                  : typeof info.hashRate === 'number'
                    ? info.hashRate
                    : null,
              already_added: existing.has(ip),
            });
            found.sort((a, b) => compareIpv4(a.ip, b.ip));
          }
        }
      } catch {
        // Per-IP probe failure is expected for the vast majority of
        // IPs on a normal /24 (no host there). Swallow and keep going.
      }
      if (signal.aborted) return;
      completed += 1;
      // Snapshot the latest state into a fresh object so the route
      // hand-out is immutable from the consumer's perspective.
      this.status = {
        ...this.status,
        done: completed,
        candidates: [...found],
      };
    };

    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < this.concurrency; w++) {
      workers.push(
        (async () => {
          while (cursor < ips.length) {
            // #259 follow-up v2: check both the in-process flag AND
            // the abort signal. The signal is what makes cancel
            // near-instant: in-flight probes abort immediately
            // instead of running out their 1.5 s timeout.
            if (this.cancelRequested || signal.aborted) break;
            const i = cursor++;
            const ip = ips[i];
            if (ip === undefined) break;
            await probe(ip);
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Distinguish "operator cancelled" from a normal completion so
    // the dashboard can render the right state hint instead of
    // pretending the sweep finished naturally.
    if (this.cancelRequested) {
      this.status = {
        ...this.status,
        state: 'cancelled',
        candidates: [...found],
        finished_at: Date.now(),
      };
    } else {
      this.status = {
        ...this.status,
        state: 'done',
        done: ips.length,
        candidates: [...found],
        finished_at: Date.now(),
      };
    }
    // Silence unused-variable lint in callers that destructured cidr.
    void cidr;
  }

  /**
   * #259 follow-up: ask the in-flight worker loop to stop. Idempotent;
   * harmless when no scan is running. Returns the status snapshot so
   * the caller can echo it back to the client.
   *
   * v2: also aborts the per-scan AbortController so every fetch in
   * flight unwinds immediately instead of running out its 1.5 s
   * timeout - worst-case latency from cancel POST to state ===
   * 'cancelled' drops from ~1.5 s to a few ms.
   */
  cancel(): ScanStatus {
    if (this.status.state === 'running') {
      this.cancelRequested = true;
      this.currentAbort?.abort();
    }
    return this.status;
  }
}

/**
 * First non-loopback non-link-local IPv4 interface -> "<a>.<b>.<c>.0/24".
 * Returns null when no qualifying interface exists.
 */
export function deduceLocalSlash24(getIfaces: typeof networkInterfaces): string | null {
  const ifaces = getIfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const addr of list) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      // Skip link-local 169.254.0.0/16.
      if (addr.address.startsWith('169.254.')) continue;
      const parts = addr.address.split('.');
      if (parts.length !== 4) continue;
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  return null;
}

/**
 * Accept a /24 in canonical form (e.g. `192.168.1.0/24`) or a "host on
 * the subnet" form (`192.168.1.42/24`) and return the canonical `.0/24`.
 * Returns null on any other shape - we deliberately don't accept /23 or
 * /16 because the probe budget is sized for ~254 addresses.
 */
export function normalizeSlash24(input: string): string | null {
  const m = input.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/24$/);
  if (!m) return null;
  const [, a, b, c, d] = m;
  for (const octet of [a, b, c, d]) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return `${a}.${b}.${c}.0/24`;
}

function expandSlash24(cidr: string): string[] {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
  if (!m) return [];
  const [, a, b, c] = m;
  const out: string[] = [];
  // Skip .0 (network) and .255 (broadcast).
  for (let i = 1; i < 255; i++) out.push(`${a}.${b}.${c}.${i}`);
  return out;
}

function compareIpv4(a: string, b: string): number {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

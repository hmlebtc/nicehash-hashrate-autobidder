/**
 * #259 follow-up v2: when the operator closes the scan dialog with X,
 * the daemon must abort in-flight HTTP probes (not just stop spawning
 * new ones) so the run finalises in milliseconds rather than waiting
 * up to one probe-timeout per worker.
 *
 * Build 605 only set a `cancelRequested` flag that workers checked
 * between probes - cancel latency was bounded below by the per-probe
 * timeout (~1.5 s × concurrency in the worst case). v2 plumbs an
 * AbortController signal into `getSystemInfo`, so cancel aborts every
 * fetch in flight and workers see the rejection on the next loop tick.
 */

import { describe, expect, it } from 'vitest';

import { AxeOSScanner } from './axeos-scanner.js';
import { AxeOSClient } from './axeos.js';
import type { SoloMinerRow, SoloMinersRepo } from '../state/repos/solo_miners.js';

/** Repo stub - the scanner only calls `list()` to mark known IPs. */
function fakeRepo(rows: SoloMinerRow[] = []): SoloMinersRepo {
  return {
    list: async () => rows,
  } as unknown as SoloMinersRepo;
}

/** Single non-loopback IPv4 interface so deduceLocalSlash24 picks it up. */
const fakeInterfaces = () =>
  ({
    eth0: [{ family: 'IPv4', address: '192.168.1.42', internal: false } as never],
  }) as ReturnType<typeof import('node:os').networkInterfaces>;

describe('AxeOSScanner.cancel', () => {
  it('aborts in-flight probes so the run finalises quickly', async () => {
    // Fetch that never resolves on its own - only an abort can unblock
    // it. Mimics a /24 sweep where most IPs would otherwise sit in the
    // full 1.5 s probe timeout.
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
          else
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
        }
      });

    const scanner = new AxeOSScanner({
      repo: fakeRepo(),
      client: new AxeOSClient({ timeoutMs: 60_000, fetchImpl }),
      interfaces: fakeInterfaces,
      concurrency: 8,
      probeTimeoutMs: 60_000,
    });

    const startedAt = Date.now();
    const result = scanner.start();
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe('running');

    // Let the worker loop spin up and dispatch its first probes.
    await new Promise((r) => setTimeout(r, 20));

    scanner.cancel();

    // Wait for the worker loop to finalise. With the abort plumbed
    // through, all 8 in-flight probes reject immediately and the run
    // finishes well under the 60 s timeout we set above.
    for (let i = 0; i < 50; i++) {
      if (scanner.getStatus().state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const elapsed = Date.now() - startedAt;
    expect(scanner.getStatus().state).toBe('cancelled');
    // Generous bound - the point is "far below the 60 s probe timeout"
    // not "milliseconds-exact". CI jitter is the real adversary.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('a subsequent start() after cancel kicks off a fresh sweep', async () => {
    // Resolve every probe immediately as "unreachable" so the sweep
    // walks the full /24 without depending on real HTTP.
    const fetchImpl: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed'));

    const scanner = new AxeOSScanner({
      repo: fakeRepo(),
      client: new AxeOSClient({ timeoutMs: 100, fetchImpl }),
      interfaces: fakeInterfaces,
      concurrency: 16,
      probeTimeoutMs: 100,
    });

    scanner.start();
    scanner.cancel();
    // Drain the previous run.
    for (let i = 0; i < 50; i++) {
      if (scanner.getStatus().state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(scanner.getStatus().state).toBe('cancelled');

    const result = scanner.start();
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe('running');
  });
});

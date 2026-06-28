/**
 * #291: decide whether a *reachable* solo miner is actually hashing.
 *
 * The bug: a Bitaxe-family board that thermally halts (or otherwise
 * stops the ASIC) keeps its web API up but, depending on firmware,
 * keeps publishing its last hashrate forever. So "reachable + reports
 * a hashrate" is NOT proof of hashing - a halted NerdAxe reports a
 * frozen number with idle power and low temp, and HA believed it had
 * recovered.
 *
 * Firmware landscape (confirmed from source, June 2026):
 *   - Stock Bitaxe (bitaxeorg/ESP-Miner): exposes `overheat_mode`
 *     (0/1); hashRate stays frozen on halt.
 *   - NerdQAxe (shufps/ESP-Miner-NerdQAxePlus): exposes `shutdown`
 *     (bool) and already zeroes hashRate while shut down.
 *   - NerdAxe (BitMaker-hub/ESP-Miner-NerdAxe): NO halt/overheat flag
 *     at all, and hashRate stays frozen on halt. This is the board in
 *     the report, so a flag-only fix would miss it.
 *
 * Strategy: trust an explicit firmware flag when present; otherwise
 * fall back to a physical-impossibility check on hashrate-per-watt.
 */

/**
 * Best real ASIC efficiency today is ~60-70 GH/s per watt (Bitaxe
 * Gamma / BM1370, NerdQAxe++). A reachable miner reporting more
 * hashrate per watt than any ASIC can physically deliver is not
 * hashing - it's a frozen reading from a board that halted while its
 * firmware kept publishing the last value. 100 GH/s/W sits ~1.4x above
 * the best real silicon, so a genuinely hashing board cannot cross it,
 * while a halted board drawing idle power easily does. Revisit if ASIC
 * efficiency ever climbs near this bound.
 */
export const MAX_PLAUSIBLE_EFFICIENCY_GH_PER_W = 100;

export type SoloHaltReason = 'overheat' | 'shutdown' | 'stale_hashrate';

export interface SoloHashingInputs {
  readonly reachable: boolean;
  /** The best live-hashrate reading (GH/s), e.g. 10m window. */
  readonly live_hashrate_ghs: number | null;
  readonly power_w: number | null;
  /** Stock Bitaxe `overheat_mode`, normalised to a boolean. */
  readonly overheat_mode: boolean | null;
  /** NerdQAxe `shutdown`, normalised to a boolean. */
  readonly shutdown: boolean | null;
}

export interface SoloHashingAssessment {
  /** Reachable, but provably not producing the hashrate it reports. */
  readonly halted: boolean;
  readonly reason: SoloHaltReason | null;
}

export function assessSoloHashing(s: SoloHashingInputs): SoloHashingAssessment {
  // Unreachable is a separate state the callers already handle; halt
  // detection only applies to a device we can actually talk to.
  if (!s.reachable) return { halted: false, reason: null };
  // Explicit firmware flags are authoritative when present.
  if (s.overheat_mode === true) return { halted: true, reason: 'overheat' };
  if (s.shutdown === true) return { halted: true, reason: 'shutdown' };
  // Flagless firmwares (NerdAxe) and the general reachable-but-stuck
  // case: an impossible hashrate-per-watt means the hashrate is stale.
  if (
    s.live_hashrate_ghs !== null &&
    s.live_hashrate_ghs > 0 &&
    s.power_w !== null &&
    s.power_w > 0 &&
    s.live_hashrate_ghs / s.power_w > MAX_PLAUSIBLE_EFFICIENCY_GH_PER_W
  ) {
    return { halted: true, reason: 'stale_hashrate' };
  }
  return { halted: false, reason: null };
}

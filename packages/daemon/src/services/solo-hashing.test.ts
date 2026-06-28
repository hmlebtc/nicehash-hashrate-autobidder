import { describe, expect, it } from 'vitest';
import { assessSoloHashing, type SoloHashingInputs } from './solo-hashing.js';

const base: SoloHashingInputs = {
  reachable: true,
  live_hashrate_ghs: 1100,
  power_w: 17,
  overheat_mode: null,
  shutdown: null,
};

describe('assessSoloHashing', () => {
  it('a healthy hashing board is not halted (~65 GH/s/W)', () => {
    expect(assessSoloHashing(base)).toEqual({ halted: false, reason: null });
  });

  it('overheat_mode flag wins (stock Bitaxe)', () => {
    expect(assessSoloHashing({ ...base, overheat_mode: true })).toEqual({
      halted: true,
      reason: 'overheat',
    });
  });

  it('shutdown flag wins (NerdQAxe)', () => {
    expect(assessSoloHashing({ ...base, shutdown: true })).toEqual({
      halted: true,
      reason: 'shutdown',
    });
  });

  it('detects a frozen hashrate at idle power (NerdAxe, no flag)', () => {
    // 1100 GH/s reported but only 4 W drawn = 275 GH/s/W, impossible.
    expect(assessSoloHashing({ ...base, power_w: 4 })).toEqual({
      halted: true,
      reason: 'stale_hashrate',
    });
  });

  it('does not false-flag a genuinely efficient board near the real ceiling', () => {
    // ~70 GH/s/W - the best real silicon, must stay below the bound.
    expect(assessSoloHashing({ ...base, live_hashrate_ghs: 1200, power_w: 17 }).halted).toBe(false);
  });

  it('unreachable is never "halted" (handled separately)', () => {
    expect(
      assessSoloHashing({ ...base, reachable: false, power_w: 1, live_hashrate_ghs: 1100 }),
    ).toEqual({ halted: false, reason: null });
  });

  it('zero / null hashrate is not stale-halted (the plain 0 H/s case)', () => {
    expect(assessSoloHashing({ ...base, live_hashrate_ghs: 0 }).halted).toBe(false);
    expect(assessSoloHashing({ ...base, live_hashrate_ghs: null }).halted).toBe(false);
  });

  it('missing power data falls back to flags only (no false stale-flag)', () => {
    expect(assessSoloHashing({ ...base, power_w: null }).halted).toBe(false);
    expect(assessSoloHashing({ ...base, power_w: 0 }).halted).toBe(false);
  });

  it('flag takes precedence even when efficiency looks fine', () => {
    expect(
      assessSoloHashing({ ...base, overheat_mode: true, power_w: 17, live_hashrate_ghs: 1100 })
        .reason,
    ).toBe('overheat');
  });
});

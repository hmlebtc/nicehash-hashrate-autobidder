/**
 * #227 follow-up #2: regression test for the test-notification path.
 *
 * Before this fix, SAMPLE_BUILDERS hardcoded English numeric literals
 * (`'948,512'`, `'1,062,144'`, `'~40,635 sat'`) so the preview never
 * reflected Display & Logging → Number format. Operator with
 * `1.234,56` selected still got `948,512` in the preview Telegram
 * message, concluded the locale plumbing was broken, and re-tested
 * across multiple commits. The actual live alert path was fine
 * (state-driven `numberLocale(state)`); only the test path was wrong.
 *
 * This test pins each sample builder against both en-US and nl-NL so
 * any future regression that re-introduces a literal number gets
 * caught at test time rather than at "I sent a test from Telegram
 * and it's still wrong" time.
 */

import { describe, expect, it } from 'vitest';

import { resolveDisplayLocale } from '../../i18n/format-numbers.js';
import { SAMPLE_BUILDERS } from './notifications-test-event.js';

const EN = resolveDisplayLocale('en-US');
const NL = resolveDisplayLocale('nl-NL');

describe('SAMPLE_BUILDERS locale routing', () => {
  it('pool_block_credited preview uses NL number format under nl-NL', () => {
    const en = SAMPLE_BUILDERS.pool_block_credited!('en', EN);
    const nl = SAMPLE_BUILDERS.pool_block_credited!('en', NL);
    // en-US: comma thousands.
    expect(en.title).toContain('948,512');
    expect(en.body).toContain('40,635');
    expect(en.body).toContain('1,048,576');
    // nl-NL: period thousands, comma decimal.
    expect(nl.title).toContain('948.512');
    expect(nl.body).toContain('40.635');
    expect(nl.body).toContain('1.048.576');
    // Neither leaks the opposite separator.
    expect(nl.title).not.toContain('948,512');
    expect(nl.body).not.toContain('40,635');
  });

  it('payout_initiated preview uses NL number format under nl-NL', () => {
    const en = SAMPLE_BUILDERS.payout_initiated!('en', EN);
    const nl = SAMPLE_BUILDERS.payout_initiated!('en', NL);
    expect(en.title).toContain('0.01062144');
    expect(en.body).toContain('1,062,144');
    expect(en.body).toContain('1,074,562');
    expect(en.body).toContain('12,418');
    expect(nl.title).toContain('0,01062144');
    expect(nl.body).toContain('1.062.144');
    expect(nl.body).toContain('1.074.562');
    expect(nl.body).toContain('12.418');
    expect(nl.body).not.toContain('1,062,144');
  });

  it('payout_confirmed preview uses NL number format under nl-NL', () => {
    const nl = SAMPLE_BUILDERS.payout_confirmed!('en', NL);
    expect(nl.title).toContain('0,01062144');
    expect(nl.body).toContain('1.062.144');
    expect(nl.body).toContain('951.602');
  });

  it('wallet_runway preview uses NL number format under nl-NL', () => {
    const nl = SAMPLE_BUILDERS.wallet_runway!('en', NL);
    expect(nl.body).toContain('210.000');
    expect(nl.body).toContain('140.000');
    expect(nl.body).not.toContain('210,000');
  });

  it('braiins_deposit preview uses NL number format under nl-NL', () => {
    const nl = SAMPLE_BUILDERS.braiins_deposit!('en', NL);
    expect(nl.body).toContain('1.000.000');
    expect(nl.body).toContain('0,01000000');
  });

  it('solo_share_rejection preview uses NL number format under nl-NL', () => {
    const nl = SAMPLE_BUILDERS.solo_share_rejection!('en', NL);
    expect(nl.body).toContain('1.000');
    expect(nl.body).toContain('12,40');
  });

  it('every builder accepts (locale, fmt) without throwing', () => {
    // Belt-and-braces: catch a future builder added without the fmt
    // parameter wired through. If a builder ignores fmt it still
    // works at runtime; this loop just verifies the signature
    // contract is honored for every entry in the map.
    for (const [eventClass, builder] of Object.entries(SAMPLE_BUILDERS)) {
      expect(() => builder('en', NL), `${eventClass} threw`).not.toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { selectVanishedLedgerBids, type PrunableBidRow } from './stale-bid-prune.js';

const NOW = 1_000_000_000;
const GRACE = 3 * 60_000;
const old = NOW - GRACE - 1;
const fresh = NOW - 1_000;

const row = (id: string, status: string | null, created_at = old): PrunableBidRow => ({
  braiins_order_id: id,
  last_known_status: status,
  created_at,
});

describe('selectVanishedLedgerBids', () => {
  it('prunes an active ledger bid that Braiins no longer returns', () => {
    const rows = [row('A', 'BID_STATUS_ACTIVE'), row('B', 'BID_STATUS_PENDING_CANCEL')];
    expect(selectVanishedLedgerBids(rows, new Set(['A']), GRACE, NOW)).toEqual(['B']);
  });

  it('keeps bids Braiins still lists', () => {
    const rows = [row('A', 'BID_STATUS_ACTIVE'), row('B', 'BID_STATUS_ACTIVE')];
    expect(selectVanishedLedgerBids(rows, new Set(['A', 'B']), GRACE, NOW)).toEqual([]);
  });

  it('empty present set (no bids at Braiins) prunes all active rows', () => {
    const rows = [row('A', 'BID_STATUS_ACTIVE'), row('B', 'BID_STATUS_CREATED')];
    expect(selectVanishedLedgerBids(rows, new Set(), GRACE, NOW).sort()).toEqual(['A', 'B']);
  });

  it('never prunes a freshly-created bid (grace window) even if absent', () => {
    const rows = [row('NEW', 'BID_STATUS_CREATED', fresh)];
    expect(selectVanishedLedgerBids(rows, new Set(), GRACE, NOW)).toEqual([]);
  });

  it('ignores terminal rows (already cancelled / fulfilled)', () => {
    const rows = [
      row('C', 'BID_STATUS_CANCELED'),
      row('F', 'BID_STATUS_FULFILLED'),
    ];
    expect(selectVanishedLedgerBids(rows, new Set(), GRACE, NOW)).toEqual([]);
  });

  it('treats a null/empty status (just-created, past grace) as prunable when absent', () => {
    expect(selectVanishedLedgerBids([row('N', null)], new Set(), GRACE, NOW)).toEqual(['N']);
  });

  it('handles the reporter case: two stale (ACTIVE + PENDING_CANCEL), Braiins lists none', () => {
    const rows = [
      row('ord-active', 'BID_STATUS_ACTIVE'),
      row('ord-pending', 'BID_STATUS_PENDING_CANCEL'),
    ];
    expect(selectVanishedLedgerBids(rows, new Set(), GRACE, NOW).sort()).toEqual([
      'ord-active',
      'ord-pending',
    ]);
  });
});

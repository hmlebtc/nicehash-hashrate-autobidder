/**
 * #295: decide which local ledger bids have vanished from Braiins.
 *
 * When a bid is deleted at Braiins out-of-band (operator cancels it
 * manually, the port/URL changes and they remove it, etc.) the local
 * `owned_bids` ledger keeps the row at an active status forever -
 * tick reconciliation only *updates* bids Braiins still returns, it
 * never removes a vanished one. That stale row makes the stale-URL
 * banner show a ghost bid and "Cancel & recreate" choke on an order
 * that no longer exists.
 *
 * Self-heal: cross-check the ledger against a SUCCESSFUL full bid-list
 * fetch. Any active ledger bid that Braiins no longer returns is gone
 * and gets cleared. This function is the pure decision so it can be
 * unit-tested without a DB; the caller supplies the candidate rows and
 * the set of order ids Braiins currently returns.
 *
 * Safety rails (all enforced here):
 *  - The caller must ONLY pass a `presentIds` derived from a fetch that
 *    definitively succeeded - never prune on an API hiccup, or we'd
 *    wipe live bids.
 *  - A grace window protects a freshly-created bid that hasn't surfaced
 *    in the list yet (Braiins can lag a tick between POST and listing).
 */

/** Statuses that mean "still live in our ledger" - candidates for the
 *  vanished check. Terminal (CANCELED / FULFILLED) and abandoned rows
 *  are excluded by the caller's query. A null/empty status is the brief
 *  just-created window, also a candidate (the grace window guards it). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'BID_STATUS_CANCELED',
  'BID_STATUS_FULFILLED',
]);

export interface PrunableBidRow {
  readonly braiins_order_id: string;
  readonly last_known_status: string | null;
  readonly created_at: number;
}

export function selectVanishedLedgerBids(
  rows: ReadonlyArray<PrunableBidRow>,
  presentIds: ReadonlySet<string>,
  graceMs: number,
  now: number,
): string[] {
  const cutoff = now - graceMs;
  return rows
    .filter(
      (r) =>
        // Not already terminal.
        (r.last_known_status === null || !TERMINAL_STATUSES.has(r.last_known_status)) &&
        // Old enough that a real bid would have surfaced in the list.
        r.created_at < cutoff &&
        // Braiins's current list does not contain it -> it's gone.
        !presentIds.has(r.braiins_order_id),
    )
    .map((r) => r.braiins_order_id);
}

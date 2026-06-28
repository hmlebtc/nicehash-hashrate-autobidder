-- #120: capture historical overpay + max-overpay-vs-hashprice on
-- every bid_events row at write time. Without this snapshot the
-- chart-marker tooltip's "MARKET AT THIS TICK" rows had to read
-- from live config and silently drifted whenever the operator
-- edited those values - so an EDIT_PRICE marker fired under
-- overpay=300 would later display overpay=200 next to a formula
-- that reconstructed it as 300 from price - fillable. Operator-
-- spotted bug.
--
-- Both columns nullable so existing rows stay readable. The
-- dashboard tooltip falls back to the live config when the
-- column is NULL (legacy rows), and uses the snapshot otherwise.
-- Internal sat/EH/day storage matches the pricing convention
-- elsewhere in this table (old_price_sat / new_price_sat).

ALTER TABLE bid_events
  ADD COLUMN overpay_sat_per_eh_day INTEGER;

ALTER TABLE bid_events
  ADD COLUMN max_overpay_vs_hashprice_sat_per_eh_day INTEGER;

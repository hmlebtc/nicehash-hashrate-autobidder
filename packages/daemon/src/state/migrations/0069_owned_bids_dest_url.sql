-- #113: persist the destination URL on every owned bid so the dashboard
-- can flag stale-URL bids when the operator changes destination_pool_url.
--
-- Braiins's SpotEditBidRequest does not allow editing dest_upstream after
-- a bid is created - only price / amount / speed_limit / memo. So once
-- the URL on a live bid drifts from current config, the only recovery
-- is cancel-and-recreate. The dashboard banner needs a deterministic
-- way to detect the mismatch; querying /spot/bid/detail per tick was
-- rejected (more API calls, breaks during Braiins outages, no offline
-- visibility). Persisting the URL at create time gives a local, durable,
-- comparable value.
--
-- Nullable because legacy rows (created before this migration) don't
-- know what URL they were created with. Banner logic skips NULL rows -
-- they age out as their bids finish and new bids carry the column.

ALTER TABLE owned_bids ADD COLUMN dest_url TEXT;

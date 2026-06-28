-- #149 follow-up: capture the bare AxeOS `hashRate` field alongside
-- the windowed `_1m / _10m / _1h` variants. Older firmware versions
-- (or in some empirical operator setups, current firmware on certain
-- ASIC families) leave the windowed fields null while the
-- instantaneous one is populated. Without a fallback the Status
-- Solo-miners card renders "-" for hashrate even though the device
-- is otherwise healthy and the AxeOS Swarm screen reports a number.

ALTER TABLE solo_miner_samples ADD COLUMN hashrate_instant_ghs REAL;

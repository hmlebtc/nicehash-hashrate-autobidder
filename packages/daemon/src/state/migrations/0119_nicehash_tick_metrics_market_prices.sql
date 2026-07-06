-- Record the market's median and speed-weighted-average filled-order price per
-- tick, for the MARKET chart (hashprice / next filled tier / median / average).
--   median = middle price among filled orders (those receiving hashrate)
--   avg    = sum(price * speed) / sum(speed) over filled orders - the effective
--            price per delivered EH, the closest proxy to NiceHash's "Paying".
ALTER TABLE nicehash_tick_metrics ADD COLUMN market_median_price_btc REAL;
ALTER TABLE nicehash_tick_metrics ADD COLUMN market_avg_price_btc REAL;

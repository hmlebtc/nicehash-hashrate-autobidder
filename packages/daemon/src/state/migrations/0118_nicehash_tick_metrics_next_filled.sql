-- Record the next filled tier above the marginal (the second-cheapest order
-- with miners) per tick, so the price chart can plot the fill band: marginal
-- floor + the next filled bid above the gap of zero-miner orders.
ALTER TABLE nicehash_tick_metrics ADD COLUMN next_filled_price_btc REAL;

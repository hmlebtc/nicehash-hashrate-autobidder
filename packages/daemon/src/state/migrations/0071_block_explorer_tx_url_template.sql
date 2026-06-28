-- Add a separate transaction-URL template so the dashboard's
-- on-chain payout tooltip can deep-link to the actual transaction
-- rather than the block. Operator caught it on review: the existing
-- `block_explorer_url_template` only knows about /block/{hash}, but
-- a payout dot on the chart wants /tx/{txid}, and not every explorer
-- follows a clean /block <-> /tx replacement (blockchair uses
-- /transaction/, btc.com uses /btc/transaction/).
--
-- Default value is auto-derived from the operator's existing block
-- template: when it matches a known preset, the tx template gets the
-- preset's known-good tx URL; otherwise we fall back to a simple
-- /block/{hash} -> /tx/{txid} string replacement (works for the
-- common cases including the local-Umbrel mempool variant, which is
-- exactly what triggered the original bug report).

ALTER TABLE config ADD COLUMN block_explorer_tx_url_template TEXT NOT NULL DEFAULT 'https://mempool.space/tx/{txid}';

UPDATE config SET block_explorer_tx_url_template = CASE
  WHEN block_explorer_url_template LIKE 'https://mempool.space/block/%'
    THEN 'https://mempool.space/tx/{txid}'
  WHEN block_explorer_url_template LIKE 'https://blockstream.info/block/%'
    THEN 'https://blockstream.info/tx/{txid}'
  WHEN block_explorer_url_template LIKE 'https://blockchair.com/bitcoin/block/%'
    THEN 'https://blockchair.com/bitcoin/transaction/{txid}'
  WHEN block_explorer_url_template LIKE 'https://btcscan.org/block/%'
    THEN 'https://btcscan.org/tx/{txid}'
  WHEN block_explorer_url_template LIKE 'https://btc.com/btc/block/%'
    THEN 'https://btc.com/btc/transaction/{txid}'
  WHEN block_explorer_url_template LIKE '%/block/{hash}'
    THEN REPLACE(block_explorer_url_template, '/block/{hash}', '/tx/{txid}')
  ELSE 'https://mempool.space/tx/{txid}'
END;

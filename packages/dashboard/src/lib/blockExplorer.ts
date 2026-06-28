/**
 * Block-explorer URL templating (issue #22).
 *
 * Two flavours of template:
 *   - Block: `block_explorer_url_template` - `{hash}` / `{height}`
 *     placeholders. Used for pool-block markers.
 *   - Transaction: `block_explorer_tx_url_template` - `{txid}` /
 *     `{hash}` placeholders. Used for the Price chart's on-chain
 *     payout dots so they deep-link to the actual transaction
 *     rather than just the containing block.
 *
 * Same `applyExplorerTemplate` helper handles both - the placeholders
 * the template uses determine which fields it needs from the
 * caller's context object.
 */

export function applyExplorerTemplate(
  template: string,
  ctx: { block_hash?: string; height?: number; txid?: string },
): string {
  let url = template;
  if (ctx.txid !== undefined) {
    url = url.split('{txid}').join(encodeURIComponent(ctx.txid));
  }
  if (ctx.block_hash !== undefined) {
    url = url.split('{hash}').join(encodeURIComponent(ctx.block_hash));
  }
  if (ctx.height !== undefined) {
    url = url.split('{height}').join(String(ctx.height));
  }
  if (url && !/^https?:\/\/|^\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url;
}

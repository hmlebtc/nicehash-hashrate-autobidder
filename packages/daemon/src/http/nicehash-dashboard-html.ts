/**
 * Self-contained NiceHash dashboard (no build step).
 *
 * A single HTML page (inline CSS + vanilla JS) served by the NiceHash HTTP
 * server at `/`. It polls `/api/nicehash/status` and renders the live control
 * state in NiceHash terms - order / escrow / BTC-per-EH-day pricing - with a
 * DRY-RUN / LIVE / PAUSED toggle wired to `POST /api/nicehash/run-mode`.
 *
 * This is a focused operator UI, not the full upstream charting dashboard
 * (that remains a larger port). Kept as a string constant so it works
 * identically under tsx and a dist build with no asset-copy step.
 */

export const NICEHASH_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NiceHash Hashrate Autobidder</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0e1116; color: #e6edf3; }
  header { display: flex; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid #222; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .sub { color: #8b949e; font-size: 12px; }
  .grow { flex: 1; }
  .badge { padding: 4px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .mode-DRY_RUN { background: #1f6feb33; color: #58a6ff; }
  .mode-LIVE { background: #2ea04333; color: #3fb950; }
  .mode-PAUSED { background: #d2992233; color: #e3b341; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; margin: 0 0 8px; }
  .big { font-size: 22px; font-weight: 700; }
  .muted { color: #8b949e; font-size: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  th { color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .controls button { font: inherit; font-weight: 600; padding: 7px 14px; margin-left: 8px; border-radius: 8px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; }
  .controls button.active { outline: 2px solid #58a6ff; }
  .warn { background: #f8514922; border: 1px solid #f85149; color: #ff7b72; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .pill { padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .ok { background: #2ea04333; color: #3fb950; }
  .blocked { background: #6e768133; color: #8b949e; }
  .failed { background: #f8514933; color: #ff7b72; }
  .dry { background: #1f6feb33; color: #58a6ff; }
  h2.section { font-size: 13px; color: #8b949e; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
  code { color: #79c0ff; }
  footer { padding: 16px 24px; color: #586069; font-size: 11px; border-top: 1px solid #222; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<header>
  <div>
    <h1>NiceHash Hashrate Autobidder</h1>
    <div class="sub" id="sub">connecting…</div>
  </div>
  <div class="grow"></div>
  <span class="badge" id="modeBadge">—</span>
  <div class="controls">
    <button data-mode="DRY_RUN">Dry-run</button>
    <button data-mode="PAUSED">Pause</button>
    <button data-mode="LIVE">Live</button>
  </div>
</header>
<main>
  <div id="unknownWarn"></div>
  <div class="grid">
    <div class="card"><h2>Available balance</h2><div class="big" id="balance">—</div><div class="muted" id="balanceCur"></div></div>
    <div class="card"><h2>Market anchor</h2><div class="big" id="anchor">—</div><div class="muted">BTC / EH / day · price to beat</div></div>
    <div class="card"><h2>Market supply</h2><div class="big" id="supply">—</div><div class="muted" id="thin"></div></div>
    <div class="card"><h2>Strategy</h2>
      <div class="row"><span class="muted">Algorithm</span><span id="algo">—</span></div>
      <div class="row"><span class="muted">Market</span><span id="market">—</span></div>
      <div class="row"><span class="muted">Target speed</span><span id="target">—</span></div>
      <div class="row"><span class="muted">Overpay</span><span id="overpay">—</span></div>
      <div class="row"><span class="muted">Max price</span><span id="maxprice">—</span></div>
    </div>
  </div>

  <h2 class="section">Our orders</h2>
  <table>
    <thead><tr><th>Order</th><th>Price (BTC/EH/day)</th><th>Limit (PH/s)</th><th>Delivered</th><th>Escrow left</th><th>Runway</th><th>Status</th></tr></thead>
    <tbody id="orders"><tr><td colspan="7" class="muted">—</td></tr></tbody>
  </table>

  <h2 class="section">Next action</h2>
  <table>
    <thead><tr><th>Proposal</th><th>Reason</th><th>Outcome</th></tr></thead>
    <tbody id="actions"><tr><td colspan="3" class="muted">holding — no action</td></tr></tbody>
  </table>
</main>
<footer>
  <span id="build"></span> · auto-refreshes every 5s · DRY-RUN mutates nothing.
  Not affiliated with NiceHash Ltd.
</footer>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function fmt(n, d) { return (n === null || n === undefined) ? '—' : Number(n).toFixed(d === undefined ? 8 : d); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]; }); }
  function runwayHours(o) {
    var rate = (o.price_btc || 0) * ((o.accepted_speed_units > 0 ? o.accepted_speed_units : o.limit_units) || 0);
    if (!(o.available_amount_btc > 0)) return '0h';
    if (rate <= 0) return '∞';
    return ((o.available_amount_btc / rate) * 24).toFixed(1) + 'h';
  }

  async function setMode(mode) {
    if (mode === 'LIVE' && !confirm('Switch to LIVE? The bidder will place and manage REAL orders.')) return;
    await fetch('/api/nicehash/run-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode }) });
    refresh();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });

  function render(s) {
    var badge = $('modeBadge');
    badge.textContent = s.run_mode;
    badge.className = 'badge mode-' + s.run_mode;
    Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === s.run_mode);
    });
    $('sub').textContent = s.tick_at ? ('last tick ' + new Date(s.tick_at).toLocaleTimeString()) : 'no tick yet';
    $('build').textContent = 'build ' + s.build;

    $('balance').textContent = fmt(s.balance_btc, 8);
    $('balanceCur').textContent = 'BTC';
    $('anchor').textContent = s.market ? fmt(s.market.anchor_price_btc) : '—';
    $('supply').textContent = s.market ? fmt(s.market.total_speed_units, 2) + ' PH/s' : '—';
    $('thin').textContent = s.market && s.market.thin ? 'thin market' : '';

    var c = s.config || {};
    $('algo').textContent = c.algorithm || '—';
    $('market').textContent = c.market || '—';
    $('target').textContent = (c.target_speed_units != null ? c.target_speed_units : '—') + ' PH/s';
    $('overpay').textContent = fmt(c.overpay_btc_per_unit_day);
    $('maxprice').textContent = fmt(c.max_price_btc_per_unit_day);

    var orders = s.owned_orders || [];
    $('orders').innerHTML = orders.length ? orders.map(function (o) {
      return '<tr><td><code>' + esc((o.order_id || '').slice(0, 8)) + '</code></td><td>' + fmt(o.price_btc) +
        '</td><td>' + fmt(o.limit_units, 2) + '</td><td>' + fmt(o.accepted_speed_units, 2) + ' PH/s</td><td>' +
        fmt(o.available_amount_btc) + '</td><td>' + runwayHours(o) + '</td><td>' + esc(o.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">no order — ' + (s.market ? 'holding' : 'market unavailable') + '</td></tr>';

    var warn = '';
    if ((s.unknown_orders || []).length) {
      warn = '⚠️ ' + s.unknown_orders.length + ' unknown order(s) detected on the account — the controller PAUSES until resolved.';
    }
    $('unknownWarn').innerHTML = warn ? '<div class="warn">' + esc(warn) + '</div>' : '';

    var props = s.proposals || [], outs = s.outcomes || [];
    $('actions').innerHTML = props.length ? props.map(function (p, i) {
      var o = outs[i] || {};
      var cls = o.outcome === 'EXECUTED' ? 'ok' : o.outcome === 'FAILED' ? 'failed' : o.outcome === 'DRY_RUN' ? 'dry' : 'blocked';
      var label = o.outcome ? (o.outcome + (o.detail ? (' · ' + o.detail) : '')) : '';
      return '<tr><td>' + esc(p.kind) + '</td><td class="muted">' + esc(p.reason) + '</td><td><span class="pill ' + cls + '">' + esc(label) + '</span></td></tr>';
    }).join('') : '<tr><td colspan="3" class="muted">holding — no action</td></tr>';
  }

  async function refresh() {
    try {
      var r = await fetch('/api/nicehash/status');
      render(await r.json());
    } catch (e) {
      $('sub').textContent = 'connection error';
    }
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;

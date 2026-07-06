/**
 * Self-contained NiceHash dashboard (no build step).
 *
 * A single HTML page (inline CSS + vanilla JS, hand-rolled canvas charts) served
 * by the NiceHash HTTP server at `/`. Three tabs:
 *
 *   - Status  : run-mode + "Run decision now", summary tiles, hashrate + price
 *               charts, our orders, profit & loss, and the next action.
 *   - History : the order-mutation audit trail with action / order / Δ-price
 *               filters.
 *   - Config  : credentials, connection, strategy, cheap mode, pool, and
 *               daemon/data settings, plus a connectivity test.
 *
 * Kept as a string constant so it works identically under tsx and a dist build
 * with no asset-copy step and no external/CDN dependencies (Umbrel-friendly).
 * Modelled on Hashrate Autopilot, adapted to NiceHash terms (BTC/EH/day prices,
 * PH/s speeds, escrow/refill). Not the full upstream charting stack - a focused,
 * dependency-free port.
 */

export const NICEHASH_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2032%2032%27%3E%3Crect%20width%3D%2732%27%20height%3D%2732%27%20rx%3D%277%27%20fill%3D%27%230b1220%27/%3E%3Cg%20fill%3D%27%23fb923c%27%3E%3Crect%20x%3D%276.5%27%20y%3D%2717%27%20width%3D%274%27%20height%3D%278.5%27%20rx%3D%271%27/%3E%3Crect%20x%3D%2714%27%20y%3D%2711.5%27%20width%3D%274%27%20height%3D%2714%27%20rx%3D%271%27/%3E%3Crect%20x%3D%2721.5%27%20y%3D%276.5%27%20width%3D%274%27%20height%3D%2719%27%20rx%3D%271%27/%3E%3C/g%3E%3C/svg%3E" />
<title>NiceHash Hashrate Autobidder</title>
<style>
  /* Palette mirrors Hashrate Autopilot: Tailwind slate background + orange/gold
     accent and the Tailwind chart hues. */
  :root {
    color-scheme: dark;
    --bg: #0f172a;        /* slate-900 */
    --panel: #18223a;     /* card / chart / fieldset */
    --input: #0b1224;     /* input / select */
    --border: #1e293b;    /* slate-800 */
    --border2: #334155;   /* slate-700 */
    --text: #e2e8f0;      /* slate-200 */
    --muted: #94a3b8;     /* slate-400 */
    --faint: #64748b;     /* slate-500 */
    --orange: #fb923c;    /* orange-400 - brand / links / section heads */
    --gold: #facc15;      /* yellow-400 - accent / primary / active */
    --green: #34d399; --red: #f87171; --blue: #3b82f6; --cyan: #22d3ee;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 14px; padding: 12px 22px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 700; color: var(--orange); }
  .sub { color: var(--muted); font-size: 12px; }
  .grow { flex: 1; }
  nav { display: flex; gap: 4px; }
  nav button { font: inherit; font-weight: 600; padding: 6px 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; }
  nav button.active { color: var(--gold); background: var(--panel); border-color: var(--border2); }
  .badge { padding: 4px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; }
  .mode-DRY_RUN { background: #3b82f633; color: #60a5fa; }
  .mode-LIVE { background: #34d39933; color: var(--green); }
  .mode-PAUSED { background: #facc1533; color: var(--gold); }
  .badge.switching { animation: nhpulse 1s ease-in-out infinite; }
  .badge.switching::before { content: ""; display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: nhspin .7s linear infinite; }
  @keyframes nhspin { to { transform: rotate(360deg); } }
  @keyframes nhpulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
  .controls button:disabled, .toggle button:disabled { opacity: .45; cursor: default; }
  main { padding: 20px; max-width: 1180px; margin: 0 auto; }
  .page { display: none; }
  .page.active { display: block; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 6px; }
  .big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); font-size: 12px; }
  .pos { color: var(--green); } .neg { color: var(--red); }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .controls button, .toggle button { font: inherit; font-weight: 600; padding: 6px 12px; margin-left: 6px; border-radius: 8px; border: 1px solid var(--border2); background: var(--panel); color: var(--text); cursor: pointer; }
  .controls button.active, .toggle button.active { outline: 2px solid var(--gold); }
  .toggle button { margin-left: 0; padding: 4px 8px; font-size: 11px; }
  .toggle { display: inline-flex; gap: 4px; align-items: center; }
  .primary { background: var(--gold) !important; border-color: var(--gold) !important; color: var(--bg) !important; }
  .warn { background: #f8717122; border: 1px solid var(--red); color: var(--red); border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; }
  .pill { padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .ok { background: #34d39933; color: var(--green); } .blocked { background: #64748b33; color: var(--muted); }
  .failed { background: #f8717133; color: var(--red); } .dry { background: #3b82f633; color: #60a5fa; }
  .lvl-info { background: #64748b33; color: var(--muted); } .lvl-warn { background: #facc1533; color: var(--gold); } .lvl-error { background: #f8717133; color: var(--red); }
  .logdetail { color: var(--faint); font-size: 11px; white-space: pre-wrap; margin-top: 5px; font-family: ui-monospace, monospace; }
  h2.section { font-size: 13px; color: var(--orange); margin: 24px 0 6px; text-transform: uppercase; letter-spacing: .06em; }
  .activity { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .activity-head { display: flex; align-items: center; gap: 10px; }
  .activity-head h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--orange); margin: 0; }
  .activity-head .act-next-in { margin-left: auto; font-size: 12px; color: var(--muted); }
  .activity-now { font-size: 17px; font-weight: 600; margin: 10px 0 3px; }
  .activity-next { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  .tickbar { height: 6px; background: var(--border); border-radius: 4px; overflow: hidden; }
  .tickbar > div { height: 100%; width: 0%; background: var(--orange); transition: width .9s linear; }
  .activity-foot { display: flex; align-items: center; gap: 12px; margin-top: 11px; }
  .chartcard { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-top: 12px; }
  .chartcard .head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .chartcard h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--orange); margin: 0; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  /* Drag the ⇕ handle below a chart to stretch it taller/shorter; scroll to zoom, drag to pan. */
  .chartwrap { height: 220px; min-height: 140px; margin-top: 8px; overflow: hidden; }
  .chartwrap canvas { width: 100%; height: 100%; display: block; margin: 0; cursor: grab; }
  .chart-resize { height: 16px; margin-top: 2px; display: flex; align-items: center; justify-content: center;
    cursor: ns-resize; color: var(--muted); border-radius: 4px; user-select: none; font-size: 12px; line-height: 1; }
  .chart-resize:hover { background: var(--border); color: var(--text); }
  canvas { width: 100%; height: 220px; display: block; margin-top: 8px; }
  .btn-reset { margin-left: auto; font-size: 11px; padding: 2px 9px; background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); cursor: pointer; }
  .btn-reset:hover { color: var(--text); border-color: var(--muted); }
  /* Rearrangeable tiles: any card in a .grid[data-tilegrid] can be dragged to
     reorder; the order persists per-grid in localStorage. */
  .card.draggable { cursor: grab; }
  .card.draggable:active { cursor: grabbing; }
  .card.dragging { opacity: .45; outline: 1px dashed var(--border2); }
  .tiles-toolbar { display: flex; justify-content: flex-end; margin: 0 0 8px; }
  .chart-hint { font-size: 10px; color: var(--muted); margin: 2px 0 0 2px; }
  .rangebar { display: flex; gap: 4px; margin: 6px 0 2px; flex-wrap: wrap; }
  .rangebar button { font: inherit; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--border2); background: var(--panel); color: var(--muted); cursor: pointer; }
  .rangebar button.active { background: var(--panel); color: var(--gold); outline: 1px solid var(--gold); }
  fieldset { border: 1px solid var(--border); border-radius: 10px; margin: 0 0 14px; padding: 10px 14px; }
  legend { color: var(--orange); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: 0 6px; }
  .formgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 16px; }
  .formgrid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .formgrid .chkrow { display: flex; align-items: center; gap: 8px; }
  .formgrid .help { color: var(--faint); font-size: 11px; font-weight: 400; line-height: 1.35; }
  .formgrid input, .formgrid select { font: inherit; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--border2); background: var(--input); color: var(--text); }
  .formgrid input:focus, .formgrid select:focus { outline: 2px solid var(--gold); border-color: var(--gold); }
  .btnrow { display: flex; align-items: center; gap: 10px; margin: 6px 0 8px; flex-wrap: wrap; }
  .btnrow button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border2); background: var(--panel); color: var(--text); cursor: pointer; }
  .msg { font-size: 12px; color: var(--muted); }
  code { color: var(--gold); }
  footer { padding: 14px 22px; color: var(--faint); font-size: 11px; border-top: 1px solid var(--border); }
  a { color: var(--orange); }
</style>
</head>
<body>
<header>
  <div>
    <h1>NiceHash Hashrate Autobidder</h1>
    <div class="sub" id="sub">connecting…</div>
  </div>
  <nav>
    <button data-page="status" class="active">Status</button>
    <button data-page="history">History</button>
    <button data-page="logs">Logs</button>
    <button data-page="config">Config</button>
  </nav>
  <div class="grow"></div>
  <div class="toggle" title="Speed unit">
    <button data-speed="TH">TH</button><button data-speed="PH">PH</button><button data-speed="EH">EH</button>
  </div>
  <div class="toggle" title="Price denomination">
    <button data-price="sat">sat</button><button data-price="BTC">BTC</button>
  </div>
  <span class="badge" id="modeBadge">—</span>
  <div class="controls">
    <button data-mode="DRY_RUN">Dry-run</button>
    <button data-mode="PAUSED">Pause</button>
    <button data-mode="LIVE">Live</button>
  </div>
</header>
<main>
  <!-- ===================== STATUS ===================== -->
  <section id="page-status" class="page active">
    <div id="unknownWarn"></div>

    <div class="activity">
      <div class="activity-head">
        <h2>What's happening</h2>
        <span class="badge" id="actMode">—</span>
        <span class="act-next-in" id="nextTick"></span>
      </div>
      <div class="activity-now" id="actNow">—</div>
      <div class="activity-next" id="nextAction">—</div>
      <div class="tickbar" title="time until the next decision"><div id="tickFill"></div></div>
      <div class="activity-foot">
        <button id="runNow" class="primary">Run decision now</button>
        <span class="msg" id="actLast"></span>
      </div>
    </div>

    <div class="tiles-toolbar"><button class="btn-reset" id="resetTiles" title="Restore the default tile order">⤢ reset tile layout</button></div>

    <div class="grid" data-tilegrid="market">
      <div class="card" data-tile="curPrice"><h2>Price (current bid)</h2><div class="big" id="curPrice" style="color:#fb923c">—</div><div class="muted" id="curPriceUnit"></div></div>
      <div class="card" data-tile="curDelivered"><h2>Delivered</h2><div class="big" id="curDelivered" style="color:#fb923c">—</div><div class="muted" id="curDeliveredUnit"></div></div>
      <div class="card" data-tile="orderBalance"><h2>Order balance</h2><div class="big" id="orderBalance">—</div><div class="muted" id="orderBalanceSub">escrow left in order</div></div>
      <div class="card" data-tile="orderRunway"><h2>Time remaining</h2><div class="big" id="orderRunway">—</div><div class="muted" id="orderRunwaySub">until escrow runs out</div></div>
      <div class="card" data-tile="anchor"><h2>Market anchor</h2><div class="big" id="anchor" style="color:#a855f7">—</div><div class="muted" id="anchorUnit">price to beat</div></div>
      <div class="card" data-tile="nextTier"><h2>Next tier</h2><div class="big" id="nextTier" style="color:#38bdf8">—</div><div class="muted" id="nextTierUnit">next filled tier (cyan)</div></div>
      <div class="card" data-tile="supply"><h2>Market supply</h2><div class="big" id="supply">—</div><div class="muted" id="supplyUnit"></div></div>
    </div>

    <div class="rangebar" id="rangebar">
      <button data-range="30s">30s</button><button data-range="1m">1m</button>
      <button data-range="5m">5m</button><button data-range="10m">10m</button>
      <button data-range="15m">15m</button><button data-range="30m">30m</button>
      <button data-range="1h">1h</button><button data-range="3h">3h</button>
      <button data-range="6h">6h</button><button data-range="12h">12h</button>
      <button data-range="24h" class="active">24h</button><button data-range="1w">1w</button>
      <button data-range="30d">30d</button><button data-range="1y">1y</button>
      <button data-range="all">All</button>
    </div>

    <div class="grid" id="tiles" data-tilegrid="stats"></div>

    <div class="chartcard">
      <div class="head"><h3>Hashrate</h3>
        <div class="legend">
          <span><i class="swatch" style="background:#fb923c"></i>delivered</span>
          <span><i class="swatch" style="background:#3b82f6"></i>limit</span>
          <span><i class="swatch" style="background:#64748b"></i>target</span>
          <span><i class="swatch" style="background:#64748b"></i>min fill</span>
        </div>
        <button class="btn-reset" data-chart="hashChart">⟲ reset zoom &amp; size</button>
      </div>
      <div class="chartwrap"><canvas id="hashChart"></canvas></div>
      <div class="chart-resize" title="drag up/down to stretch the chart">⇕</div>
      <div class="chart-hint">scroll = zoom · shift-scroll = vertical · alt-scroll = horizontal · drag = pan · drag the ⇕ handle to stretch taller/shorter</div>
    </div>

    <div class="chartcard">
      <div class="head"><h3>Price</h3>
        <div class="legend">
          <span><i class="swatch" style="background:#fb923c"></i>our bid</span>
          <span><i class="swatch" style="background:#a855f7"></i>marginal (purple)</span>
          <span><i class="swatch" style="background:#38bdf8"></i>next filled tier</span>
          <span><i class="swatch" style="background:#34d399"></i>dynamic cap</span>
          <span><i class="swatch" style="background:#f87171"></i>hard cap</span>
          <span><i class="swatch" style="background:#34d399;border-radius:50%;width:6px;height:6px"></i>create</span>
          <span><i class="swatch" style="background:#facc15;border-radius:50%;width:6px;height:6px"></i>edit</span>
          <span><i class="swatch" style="background:#f87171;border-radius:50%;width:6px;height:6px"></i>cancel</span>
        </div>
        <button class="btn-reset" data-chart="priceChart">⟲ reset zoom &amp; size</button>
      </div>
      <div class="chartwrap"><canvas id="priceChart"></canvas></div>
      <div class="chart-resize" title="drag up/down to stretch the chart">⇕</div>
      <div class="chart-hint">scroll = zoom · shift-scroll = vertical · alt-scroll = horizontal · drag = pan · drag the ⇕ handle to stretch taller/shorter</div>
    </div>

    <h2 class="section">Our orders</h2>
    <table>
      <thead><tr><th>Order</th><th>Price</th><th>Limit</th><th>Delivered</th><th>Miners</th><th>Escrow left</th><th>Runway</th><th>Status</th></tr></thead>
      <tbody id="orders"><tr><td colspan="7" class="muted">—</td></tr></tbody>
    </table>

    <h2 class="section">Profit &amp; loss <span class="muted" style="text-transform:none">(income/net are estimates from the hashprice oracle)</span></h2>
    <div class="grid" id="pnl" data-tilegrid="pnl"></div>

    <h2 class="section">Next action detail</h2>
    <table>
      <thead><tr><th>Proposal</th><th>Reason</th><th>Outcome</th></tr></thead>
      <tbody id="actions"><tr><td colspan="3" class="muted">holding — no action</td></tr></tbody>
    </table>
  </section>

  <!-- ===================== HISTORY ===================== -->
  <section id="page-history" class="page">
    <h2 class="section">Order history</h2>
    <div class="btnrow">
      <span class="toggle" id="histActions">
        <button data-act="CREATE" class="active">create</button>
        <button data-act="EDIT_PRICE" class="active">price</button>
        <button data-act="EDIT_LIMIT" class="active">limit</button>
        <button data-act="REFILL" class="active">refill</button>
        <button data-act="CANCEL" class="active">cancel</button>
      </span>
      <input id="histOrder" placeholder="order id contains…" style="font:inherit;padding:6px 9px;border-radius:7px;border:1px solid #30363d;background:#0e1116;color:#e6edf3" />
      <label class="muted">min Δ price <input id="histMinDelta" type="number" step="any" value="0" style="width:110px;font:inherit;padding:6px 9px;border-radius:7px;border:1px solid #30363d;background:#0e1116;color:#e6edf3" /></label>
      <button id="histReload">Reload</button>
      <span class="msg" id="histMsg"></span>
    </div>
    <table>
      <thead><tr><th>When</th><th>Order</th><th>Action</th><th>Outcome</th><th>Price before</th><th>Price after</th><th>Δ</th><th>Reason</th></tr></thead>
      <tbody id="histRows"><tr><td colspan="8" class="muted">—</td></tr></tbody>
    </table>
  </section>

  <!-- ===================== LOGS ===================== -->
  <section id="page-logs" class="page">
    <h2 class="section">Decision &amp; error log</h2>
    <p class="muted">One row per control-loop tick (what it decided and why), plus error rows for failed ticks.
      Retention is set on the Config page (Daemon &amp; data → Log retention). Newest first.</p>
    <div class="btnrow">
      <span class="toggle" id="logLevels">
        <button data-lvl="info" class="active">info</button>
        <button data-lvl="warn" class="active">warn</button>
        <button data-lvl="error" class="active">error</button>
      </span>
      <button id="logReload">Reload</button>
      <span class="msg" id="logMsg"></span>
    </div>
    <table>
      <thead><tr><th>When</th><th>Level</th><th>Mode</th><th>Summary</th></tr></thead>
      <tbody id="logRows"><tr><td colspan="4" class="muted">—</td></tr></tbody>
    </table>
  </section>

  <!-- ===================== CONFIG ===================== -->
  <section id="page-config" class="page">
    <h2 class="section">Configuration</h2>
    <p class="muted">Changes <b>auto-save</b> as you edit each field and apply <b>live within one tick</b> — no restart needed.
      The secret is write-only — leave it as the dots to keep the saved value, or type a new one to replace it.
      <b>Test connection</b> uses the values currently in the form (read-only). Heads-up: changing the NiceHash
      <b>API key / secret / org</b> or the <b>base URL</b> still needs an app restart.</p>
    <div id="configForm"></div>
    <div class="btnrow">
      <button id="cfgTest">Test connection</button>
      <button id="cfgSave" class="primary">Save now</button>
      <span class="msg" id="cfgMsg"></span>
    </div>
    <div class="msg" id="testMsg"></div>
  </section>
</main>
<footer>
  <span id="build"></span> · Status auto-refreshes · DRY-RUN mutates nothing. Not affiliated with NiceHash Ltd.
</footer>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]; }); }

  // ---- units (client-side display only) ------------------------------------
  // Speed values from the API are in the market's display unit (e.g. EH/s for
  // SHA256ASICBOOST). baseSpeedUnit is learned from /status; the TH/PH/EH toggle
  // converts from it. We default the toggle to the market's own unit until the
  // operator explicitly picks one.
  var UNIT_HS = { TH: 1e12, PH: 1e15, EH: 1e18 };
  var userPickedSpeed = localStorage.getItem('nh.speed');
  var baseSpeedUnit = 'PH';
  var baseApplied = false;
  var UI = { speed: userPickedSpeed || 'PH', price: localStorage.getItem('nh.price') || 'BTC', range: localStorage.getItem('nh.range') || '24h' };
  function applyBaseUnit(u) {
    if (!u || !UNIT_HS[u]) return;
    baseSpeedUnit = u;
    if (!userPickedSpeed && !baseApplied) { UI.speed = u; baseApplied = true; syncToggles(); }
  }
  function spFactor() { return (UNIT_HS[baseSpeedUnit] || UNIT_HS.PH) / (UNIT_HS[UI.speed] || UNIT_HS.PH); }
  function cvSpeed(v) { return (v == null) ? null : v * spFactor(); }
  function cvPrice(btc) { return (btc == null) ? null : (UI.price === 'sat' ? btc * 1e8 : btc); }
  // Prices are strictly positive; a recorded 0 (or negative) is bad data - a
  // transient oracle/order-book miss, common right after a restart. Map it to
  // null so the line breaks over the gap instead of plunging to 0 and dragging
  // the whole (shared) Y axis down with it on any window that includes the tick.
  function pp(btc) { return (btc == null || !(btc > 0)) ? null : cvPrice(btc); }
  function speedUnit() { return UI.speed + '/s'; }
  function priceUnit() { return (UI.price === 'sat' ? 'sat' : 'BTC') + '/EH/day'; }
  function fmtSpeed(ph, d) {
    var v = cvSpeed(ph);
    if (v == null) return '—';
    if (d != null) return v.toFixed(d);
    // Adaptive precision so a small-but-real fill (e.g. 0.0005 EH/s) is not
    // collapsed to "0.00": more decimals as the magnitude shrinks.
    var av = Math.abs(v);
    if (av === 0) return '0.00';
    if (av < 0.0001) return v.toExponential(1);
    if (av < 1) return v.toFixed(4);
    return v.toFixed(2);
  }
  // Prices default to 4 decimals to match the NiceHash order book's granularity
  // (the price step is 0.0001 BTC/EH/day). Callers that need more precision for a
  // derived/aggregate value (dynamic cap, hashprice, margin, averages, reprice
  // deltas) pass an explicit d.
  function fmtPrice(btc, d) { var v = cvPrice(btc); if (v == null) return '—'; return UI.price === 'sat' ? Math.round(v).toLocaleString() : v.toFixed(d == null ? 4 : d); }
  function fmtBtc(v, d) { return v == null ? '—' : Number(v).toFixed(d == null ? 8 : d); }
  // Adaptive Y-axis tick formatter: keeps small values (e.g. a 0.0005 EH/s fill on
  // the delivered axis) legible instead of rounding them all to "0.00".
  function fmtAxis(v) {
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toPrecision(2);
  }
  function dynamicCapOn() { var c = lastStatus && lastStatus.config; return !!(c && c.dynamic_cap_enabled); }
  function totalFeePct() { if (!dynamicCapOn()) return 0; var c = lastStatus && lastStatus.config; return c ? ((c.nicehash_fee_pct || 0) + (c.pool_fee_pct || 0)) : 0; }
  function capBufferBtc() { var c = lastStatus && lastStatus.config; return (c && c.dynamic_cap_buffer_btc) || 0; }
  function dynamicCapBtc(hp) { return (hp == null || hp <= 0 || !dynamicCapOn()) ? null : hp / (1 + totalFeePct() / 100) - capBufferBtc(); }
  function isLiveOrderStatus(st) { st = (st || '').toString().toUpperCase(); return !!st && ['CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETE', 'DEAD', 'STOPPED', 'EXPIRED', 'ERROR'].indexOf(st) < 0; }

  // ---- routing -------------------------------------------------------------
  function showPage(p) {
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (el) { el.classList.toggle('active', el.id === 'page-' + p); });
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('active', b.getAttribute('data-page') === p); });
    if (p === 'history') loadHistory();
    if (p === 'logs') loadLogs();
    if (p === 'config') { buildConfigForm(); loadConfig(); } // rebuild so unit labels reflect the live market
    if (p === 'status') { loadMetrics(); loadSummary(); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.addEventListener('click', function () { showPage(b.getAttribute('data-page')); });
  });

  // ---- unit toggles --------------------------------------------------------
  function syncToggles() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) { b.classList.toggle('active', b.getAttribute('data-speed') === UI.speed); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-price]'), function (b) { b.classList.toggle('active', b.getAttribute('data-price') === UI.price); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) {
    b.addEventListener('click', function () { UI.speed = b.getAttribute('data-speed'); userPickedSpeed = UI.speed; localStorage.setItem('nh.speed', UI.speed); syncToggles(); renderAll(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-price]'), function (b) {
    b.addEventListener('click', function () { UI.price = b.getAttribute('data-price'); localStorage.setItem('nh.price', UI.price); syncToggles(); renderAll(); });
  });

  // ---- run mode ------------------------------------------------------------
  // The server applies the mode in memory the instant the request lands, so we
  // update the UI optimistically (badge flips to the target mode immediately,
  // with a small spinner while we confirm) rather than waiting on the round
  // trip - switching feels instant and never looks frozen.
  var modeBusy = false;
  function setModeOptimistic(mode) {
    modeBusy = true;
    var badge = $('modeBadge');
    badge.textContent = mode;                         // show the target mode now
    badge.className = 'badge mode-' + mode + ' switching'; // mode colour + spinner = confirming
    Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      b.disabled = true;
    });
  }
  async function setMode(mode) {
    if (modeBusy) return;
    if (mode === 'LIVE' && !confirm('Switch to LIVE? The bidder will place and manage REAL orders.')) return;
    setModeOptimistic(mode); // instant feedback
    try {
      await fetch('/api/nicehash/run-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode }) });
    } catch (e) { /* the refresh below repaints the true state on failure */ }
    modeBusy = false;
    Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) { b.disabled = false; });
    refreshStatus(); // confirm: repaints the solid badge from the server (clears the spinner)
  }
  Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });
  $('runNow').addEventListener('click', async function () {
    $('nextTick').textContent = 'running…';
    try { var r = await fetch('/api/nicehash/run-now', { method: 'POST' }); var j = await r.json();
      $('nextTick').textContent = j.ok ? 'tick done' : ('failed: ' + (j.error || '?')); }
    catch (e) { $('nextTick').textContent = 'failed'; }
    refreshStatus(); loadMetrics(); loadSummary();
  });

  // ---- charts (hand-rolled canvas) ----------------------------------------
  function drawChart(canvas, series, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 600, cssH = canvas.clientHeight || 220;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var padL = 60, padR = opts.rightLabels ? 66 : 12, padT = 8, padB = 22, w = cssW - padL - padR, h = cssH - padT - padB;
    // Single shared Y axis. A series flagged ref:true (a reference line like the
    // order limit/target) contributes only its CURRENT value to the autoscale, not
    // its whole history - so a stale spike in a reference (e.g. the pre-fix limit
    // that briefly recorded ~2) cannot blow up the axis and desync it from the
    // primary line. A series flagged noscale:true contributes NOTHING to the
    // autoscale (e.g. hashprice / hard cap on the price chart, which sit well above
    // the bid/marginal action and would otherwise compress it) - it still draws
    // and gets a right-edge value label, clipping at the top if it's above range.
    // Both kinds still draw fully; any out-of-range portion just clips at the edge.
    var xs = [], ys = [];
    series.forEach(function (s) {
      var lastY = null;
      s.points.forEach(function (p) {
        if (p.y == null || !isFinite(p.y)) return;
        xs.push(p.x);
        if (s.noscale) return;
        if (!s.ref) ys.push(p.y);
        lastY = p.y;
      });
      if (s.ref && lastY != null) ys.push(lastY);
    });
    ctx.font = '10px system-ui';
    if (!xs.length) { ctx.fillStyle = '#586069'; ctx.fillText('no data yet', padL, padT + h / 2); return; }
    // Fallback: if every series is a reference (no primary points), scale to all.
    if (!ys.length) series.forEach(function (s) { s.points.forEach(function (p) { if (p.y != null && isFinite(p.y)) ys.push(p.y); }); });
    function domainOf(arr) {
      var lo = arr.length ? Math.min.apply(null, arr) : 0;
      var hi = arr.length ? Math.max.apply(null, arr) : 1;
      if (opts.yMinZero && lo > 0) lo = 0;
      if (hi === lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
      var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      if (opts.yMinZero && lo < 0) lo = 0;
      return [lo, hi];
    }
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ld = domainOf(ys), ymin = ld[0], ymax = ld[1];
    // Cache the full (auto) domain + inputs so the zoom/pan handlers can redraw,
    // and apply the current zoom view (data-coordinate window) if the user set one.
    var full = { xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax };
    canvas._chart = { series: series, opts: opts, full: full, padL: padL, padR: padR, padT: padT, padB: padB };
    if (canvas._view) { xmin = canvas._view.xmin; xmax = canvas._view.xmax; ymin = canvas._view.ymin; ymax = canvas._view.ymax; }
    if (!canvas._zoomWired) wireZoom(canvas);
    function X(x) { return padL + (xmax === xmin ? 0 : (x - xmin) / (xmax - xmin)) * w; }
    function Y(y) { return padT + h - (y - ymin) / (ymax - ymin) * h; }
    ctx.strokeStyle = '#21262d'; ctx.fillStyle = '#8b949e'; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var yy = padT + h * (i / 4), val = ymax - (ymax - ymin) * (i / 4);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = '#8b949e';
      ctx.fillText(opts.fmtY ? opts.fmtY(val) : val.toFixed(2), 4, yy + 3);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#8b949e';
    // Adaptive x-axis label resolution: seconds for short windows (the new
    // 30s..15m ranges), HH:MM intraday, and month/day beyond a day.
    var span = xmax - xmin;
    var tFmt = span <= 15 * 60_000
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : span <= 24 * 3600_000
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    // One label when the window holds a single timestamp; otherwise left/mid/right,
    // skipping any that would overlap a already-placed one (sparse short windows).
    var labelTs = xmax === xmin ? [xmin] : [xmin, (xmin + xmax) / 2, xmax];
    var placedX = [];
    labelTs.forEach(function (t, idx) {
      var lx = X(t);
      if (placedX.some(function (px) { return Math.abs(px - lx) < 44; })) return;
      placedX.push(lx);
      ctx.textAlign = labelTs.length === 1 ? 'center' : idx === 0 ? 'left' : idx === labelTs.length - 1 ? 'right' : 'center';
      ctx.fillText(new Date(t).toLocaleString([], tFmt), lx, padT + h + 14);
    });
    ctx.textAlign = 'left';
    // Clip data lines + markers to the plot box so a zoomed/panned view never
    // paints over the axes, labels, or the right-edge value column.
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, w, h); ctx.clip();
    series.forEach(function (s) {
      var Yf = Y;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath(); var started = false; var pts = [];
      s.points.forEach(function (pt) {
        if (pt.y == null || !isFinite(pt.y)) { started = false; return; }
        var px = X(pt.x), py = Yf(pt.y);
        pts.push([px, py]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      });
      ctx.stroke();
      // Sparse windows (a handful of ticks) can't form a visible line - a single
      // sample draws nothing - so mark each point with a dot when few enough.
      if (pts.length > 0 && pts.length <= 50) {
        ctx.setLineDash([]); ctx.fillStyle = s.color;
        pts.forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, 6.283); ctx.fill(); });
      }
    });
    ctx.setLineDash([]);
    (opts.markers || []).forEach(function (m) {
      if (m.x < xmin || m.x > xmax) return;
      ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(X(m.x), padT + h - 3, 3, 0, 6.283); ctx.fill();
    });
    ctx.restore();
    // Right-edge value labels: the latest value of each series in its colour, so
    // you can read the actual numbers off the right of the chart.
    if (opts.rightLabels) {
      ctx.textAlign = 'left';
      var placed = [];
      series.forEach(function (s) {
        var lp = null;
        for (var k = s.points.length - 1; k >= 0; k--) { var q = s.points[k]; if (q && q.y != null && isFinite(q.y)) { lp = q; break; } }
        if (!lp) return;
        var ly = Y(lp.y);
        // nudge apart from any label already placed at nearly the same height
        while (placed.some(function (py) { return Math.abs(py - ly) < 10; })) ly += 10;
        placed.push(ly);
        ctx.fillStyle = s.color;
        ctx.fillText(opts.fmtY ? opts.fmtY(lp.y) : lp.y.toFixed(2), padL + w + 4, Math.min(padT + h, Math.max(padT + 6, ly)) + 3);
      });
      ctx.textAlign = 'left';
    }
  }

  function redraw(canvas) { var c = canvas._chart; if (c) drawChart(canvas, c.series, c.opts); }
  function resetZoom(canvas) {
    canvas._view = null;
    // Also undo any manual vertical resize: clearing the wrapper's inline height
    // reverts it to the CSS default (220px).
    var wrap = canvas.parentElement;
    if (wrap && wrap.classList.contains('chartwrap')) wrap.style.height = '';
    redraw(canvas);
  }

  // Wheel = zoom (shift: vertical only, alt: horizontal only), drag = pan. The
  // view is a data-coordinate window kept on the canvas so it survives redraws
  // (auto-refresh won't yank you back to full view); the reset button clears it.
  function wireZoom(canvas) {
    canvas._zoomWired = true;
    function dom() { return canvas._view || (canvas._chart && canvas._chart.full); }
    function pw() { var c = canvas._chart; return Math.max(1, canvas.clientWidth - c.padL - c.padR); }
    function ph() { var c = canvas._chart; return Math.max(1, canvas.clientHeight - c.padT - c.padB); }
    function pxToData(mx, my) {
      var c = canvas._chart, d = dom();
      var tx = Math.max(0, Math.min(1, (mx - c.padL) / pw()));
      var ty = Math.max(0, Math.min(1, (my - c.padT) / ph()));
      return { x: d.xmin + tx * (d.xmax - d.xmin), y: d.ymax - ty * (d.ymax - d.ymin) };
    }
    canvas.addEventListener('wheel', function (e) {
      var c = canvas._chart; if (!c || !c.full) return;
      e.preventDefault();
      var d = dom(); var v = { xmin: d.xmin, xmax: d.xmax, ymin: d.ymin, ymax: d.ymax };
      var rect = canvas.getBoundingClientRect();
      var at = pxToData(e.clientX - rect.left, e.clientY - rect.top);
      var f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
      if (!e.shiftKey) { v.xmin = at.x - (at.x - v.xmin) * f; v.xmax = at.x + (v.xmax - at.x) * f; }
      if (!e.altKey) { v.ymin = at.y - (at.y - v.ymin) * f; v.ymax = at.y + (v.ymax - at.y) * f; }
      canvas._view = v; redraw(canvas);
    }, { passive: false });
    var drag = null;
    canvas.addEventListener('mousedown', function (e) {
      var c = canvas._chart; if (!c || !c.full) return;
      var d = dom(); drag = { x: e.clientX, y: e.clientY, v: { xmin: d.xmin, xmax: d.xmax, ymin: d.ymin, ymax: d.ymax } };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag || !canvas._chart) return;
      var dx = (e.clientX - drag.x) / pw() * (drag.v.xmax - drag.v.xmin);
      var dy = (e.clientY - drag.y) / ph() * (drag.v.ymax - drag.v.ymin);
      canvas._view = { xmin: drag.v.xmin - dx, xmax: drag.v.xmax - dx, ymin: drag.v.ymin + dy, ymax: drag.v.ymax + dy };
      redraw(canvas);
    });
    window.addEventListener('mouseup', function () { if (drag) { drag = null; canvas.style.cursor = 'grab'; } });
    if (window.ResizeObserver) { new ResizeObserver(function () { redraw(canvas); }).observe(canvas); }
  }

  // ---- state caches --------------------------------------------------------
  var lastStatus = null, lastMetrics = [], lastSummary = null, lastEventsForChart = [];

  function setRange(r) {
    UI.range = r; localStorage.setItem('nh.range', r);
    Array.prototype.forEach.call(document.querySelectorAll('#rangebar button'), function (b) { b.classList.toggle('active', b.getAttribute('data-range') === r); });
    loadMetrics(); loadSummary();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.btn-reset'), function (b) {
    b.addEventListener('click', function () { var cv = $(b.getAttribute('data-chart')); if (cv) resetZoom(cv); });
  });
  // Vertical stretch: drag the ⇕ handle to grow/shrink the chart above it. The
  // canvas is height:100% of the wrapper, so the ResizeObserver redraws on change.
  Array.prototype.forEach.call(document.querySelectorAll('.chart-resize'), function (h) {
    var drag = null;
    h.addEventListener('mousedown', function (e) {
      var wrap = h.previousElementSibling;
      if (!wrap) return;
      drag = { y: e.clientY, h: wrap.getBoundingClientRect().height, wrap: wrap };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      drag.wrap.style.height = Math.max(140, drag.h + (e.clientY - drag.y)) + 'px';
    });
    window.addEventListener('mouseup', function () { if (drag) { drag = null; document.body.style.userSelect = ''; } });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#rangebar button'), function (b) {
    b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); });
  });

  function renderCharts() {
    var m = lastMetrics;
    // Delivered (the time series we watch) sets the Y scale; the order limit/cap,
    // target, and fill threshold are reference lines that scale only by their
    // CURRENT value (ref: true), so the pre-fix stale limit history can't blow up
    // the axis - they stay on the same scale as delivered and read in sync.
    var hash = [
      { color: '#fb923c', points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.accepted_speed_units) }; }) },
      { color: '#3b82f6', ref: true, points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.limit_units) }; }) },
      { color: '#64748b', ref: true, dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.target_units) }; }) },
      { color: '#64748b', ref: true, dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.floor_units) }; }) }
    ];
    drawChart($('hashChart'), hash, { yMinZero: true, rightLabels: true, fmtY: fmtAxis });

    var markerColor = { CREATE: '#34d399', EDIT_PRICE: '#facc15', EDIT_LIMIT: '#38bdf8', REFILL: '#c084fc', CANCEL: '#f87171' };
    var markers = lastEventsForChart.map(function (e) { return { x: e.ts, color: markerColor[e.action] || '#64748b' }; });
    // Hard cap = the configured max price (flat reference line). The dynamic cap
    // (if enabled) is the fee-adjusted, buffered hashprice and sits below it.
    var cfg = lastStatus && lastStatus.config;
    var hardcap = cfg && cfg.max_price_btc_per_unit_day ? cfg.max_price_btc_per_unit_day : null;
    // Robust price band. A single-tick blip (a restart / oracle / order-book
    // glitch that records a price near 0) would otherwise plunge a line toward 0
    // and, because the Y axis is shared, drag the whole axis down with it on any
    // window that spans the tick (15m and below miss it; 30m+ don't). Take the
    // median of the real price series - robust to a handful of outliers - and drop
    // points more than 2x off it as bad data. A genuine sustained move shifts the
    // median, so only true one-off spikes get filtered.
    var band = [];
    m.forEach(function (r) {
      [r.our_price_btc, r.anchor_price_btc, r.next_filled_price_btc].forEach(function (v) {
        if (v != null && isFinite(v) && v > 0) band.push(v);
      });
    });
    band.sort(function (a, b) { return a - b; });
    var med = band.length ? band[Math.floor(band.length / 2)] : 0;
    function ppb(btc) {
      if (btc == null || !(btc > 0)) return null;
      if (med > 0 && (btc < med * 0.5 || btc > med * 2)) return null; // outlier -> drop
      return cvPrice(btc);
    }
    // The Y scale follows the action that matters: our bid, the marginal we track,
    // and the (binding) dynamic cap. Hashprice is dropped from this chart (it sits
    // far above the action and is redundant with the green dynamic-cap line + the
    // Hashprice tile). The hard cap and the next-filled tier are kept but flagged
    // noscale - the hard cap is a far backstop, and the next-filled tier swings
    // wildly (a separate market tier) - so they show with their value labels but
    // don't squash the bid/marginal action band.
    var price = [
      { color: '#fb923c', points: m.map(function (r) { return { x: r.ts, y: ppb(r.our_price_btc) }; }) },
      { color: '#a855f7', points: m.map(function (r) { return { x: r.ts, y: ppb(r.anchor_price_btc) }; }) },
      { color: '#38bdf8', noscale: true, points: m.map(function (r) { return { x: r.ts, y: ppb(r.next_filled_price_btc) }; }) },
      { color: '#34d399', dashed: true, points: m.map(function (r) { return { x: r.ts, y: ppb(dynamicCapBtc(r.hashprice_btc_per_unit_day)) }; }) },
      { color: '#f87171', dashed: true, noscale: true, points: m.map(function (r) { return { x: r.ts, y: pp(hardcap) }; }) }
    ];
    drawChart($('priceChart'), price, { markers: markers, rightLabels: true, fmtY: function (v) { return UI.price === 'sat' ? Math.round(v).toLocaleString() : v.toFixed(5); } });
  }

  // Chart line colours, reused to colour the matching tile values so a tile and
  // its line read as the same series (e.g. dynamic cap green, hashprice slate).
  var C = {
    bid: '#fb923c', delivered: '#fb923c', marginal: '#a855f7', nextfill: '#38bdf8',
    hashprice: '#94a3b8', dyncap: '#34d399', hardcap: '#f87171', limit: '#3b82f6',
  };

  function tileKey(label) { return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function tile(label, value, sub, cls, color) {
    var style = color ? ' style="color:' + color + '"' : '';
    return '<div class="card" data-tile="' + tileKey(label) + '"><h2>' + esc(label) + '</h2><div class="big ' + (cls || '') + '"' + style + '>' + value + '</div><div class="muted">' + esc(sub || '') + '</div></div>';
  }

  function renderTiles() {
    var s = lastSummary && lastSummary.summary;
    if (!s) { $('tiles').innerHTML = ''; return; }
    // Dynamic cap + margin must reflect the CURRENT tick, not the range average:
    // the cap tracks the live hashprice (the same value decide() bids against),
    // and the margin compares it to our live bid. Using the range-average made
    // the cap read low and the margin show "OVER cap" when the live bid was
    // actually under the live cap.
    var hpNow = (lastSummary && lastSummary.hashprice_now != null)
      ? lastSummary.hashprice_now : s.avg_hashprice_btc_per_unit_day;
    var cap = dynamicCapBtc(hpNow);
    var liveBid = null;
    if (lastStatus && lastStatus.owned_orders) {
      var lo = lastStatus.owned_orders.filter(function (o) { return isLiveOrderStatus(o.status); })[0];
      if (lo) liveBid = lo.price_btc;
    }
    var margin = (cap != null && liveBid != null) ? (cap - liveBid) : null;
    var html = '';
    // Fill uptime = % of ticks an order was filled (delivering ≥ the fill
    // threshold) out of the ticks an order was active. This is the "is my order
    // winning hashrate" signal, not API reachability.
    html += tile('Fill uptime', s.fill_uptime_pct == null ? '—' : s.fill_uptime_pct.toFixed(1),
      s.fill_uptime_pct == null ? 'no active order in range' : ('% filled · ' + (s.active_samples || 0) + ' active ticks'),
      '', C.delivered);
    html += tile('Avg delivered', fmtSpeed(s.avg_accepted_units), speedUnit(), '', C.delivered);
    html += tile('Avg price', fmtPrice(s.avg_our_price_btc, 6), priceUnit(), '', C.bid);
    html += tile('Hashprice (now)', fmtPrice(hpNow, 6), priceUnit(), '', C.hashprice);
    html += tile('Dynamic cap', fmtPrice(cap, 6), dynamicCapOn() ? (priceUnit() + ' · hashprice ÷ (1 + ' + totalFeePct() + '% fees) − buffer') : 'dynamic cap off', '', C.dyncap);
    html += tile('Margin to cap', margin == null ? '—' : (margin >= 0 ? '+' : '') + fmtPrice(margin, 6), margin == null ? 'no active bid' : (margin >= 0 ? 'under cap' : 'OVER cap'), margin == null ? '' : (margin >= 0 ? 'pos' : 'neg'));
    html += tile('Samples', String(s.samples || 0), 'ticks in range');
    $('tiles').innerHTML = html;
    applyTileOrder($('tiles'));
  }

  function renderPnl() {
    var sum = lastSummary; var s = sum && sum.summary;
    var spend = s ? s.avg_spend_rate_btc_day : null;
    var price = s ? s.avg_our_price_btc : null;
    var hp = sum ? sum.hashprice_now : (s ? s.avg_hashprice_btc_per_unit_day : null);
    var avgHp = s ? s.avg_hashprice_btc_per_unit_day : null;
    var feeMul = 1 + totalFeePct() / 100;
    var effSpend = spend != null ? spend * feeMul : null; // bid + NiceHash + pool fees
    var income = (spend != null && price > 0 && avgHp != null) ? spend * (avgHp / price) : null;
    var net = (income != null && effSpend != null) ? income - effSpend : null;
    var ret = (net != null && effSpend > 0) ? (net / effSpend * 100) : null;
    var bal = sum && sum.current ? sum.current.balance_btc : (lastStatus ? lastStatus.balance_btc : null);
    var html = '';
    html += tile('Balance', fmtBtc(bal), 'BTC');
    html += tile('Lifetime spent', fmtBtc(sum ? sum.lifetime_spent_btc : null), 'BTC');
    html += tile('Spend + fees / day', fmtBtc(effSpend, 6), dynamicCapOn() ? ('BTC/day · incl. ' + totalFeePct() + '% fees') : 'BTC/day · fees off');
    html += tile('Est. income / day', fmtBtc(income, 6), 'BTC/day · at hashprice');
    html += tile('Est. net / day', net == null ? '—' : (net >= 0 ? '+' : '') + fmtBtc(net, 6), 'BTC/day', net == null ? '' : (net >= 0 ? 'pos' : 'neg'));
    html += tile('Est. return', ret == null ? '—' : (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%', 'net / cost', ret == null ? '' : (ret >= 0 ? 'pos' : 'neg'));
    $('pnl').innerHTML = html;
    applyTileOrder($('pnl'));
  }

  function runwayHours(o) {
    var rate = (o.price_btc || 0) * ((o.accepted_speed_units > 0 ? o.accepted_speed_units : o.limit_units) || 0);
    if (!(o.available_amount_btc > 0)) return '0h';
    if (rate <= 0) return '∞';
    return ((o.available_amount_btc / rate) * 24).toFixed(1) + 'h';
  }

  // Live countdown + progress bar to the next decision. Driven both by
  // renderStatus (on each data refresh) and a 1s timer for smooth ticking.
  function updateTickCountdown() {
    var s = lastStatus, fill = $('tickFill'), nt = $('nextTick');
    if (!s || !s.tick_at || !s.tick_seconds) { if (fill) fill.style.width = '0%'; return; }
    var period = s.tick_seconds * 1000;
    var elapsed = Date.now() - s.tick_at;
    var pct = Math.max(0, Math.min(100, (elapsed / period) * 100));
    if (fill) fill.style.width = pct.toFixed(1) + '%';
    if (nt) nt.textContent = 'next decision in ~' + Math.max(0, Math.ceil((period - elapsed) / 1000)) + 's';
  }

  function renderStatus() {
    var s = lastStatus; if (!s) return;
    if (!modeBusy) {
      var badge = $('modeBadge'); badge.textContent = s.run_mode; badge.className = 'badge mode-' + s.run_mode;
      Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) { b.classList.toggle('active', b.getAttribute('data-mode') === s.run_mode); });
    }
    $('sub').textContent = s.tick_at ? ('last tick ' + new Date(s.tick_at).toLocaleTimeString()) : 'no tick yet';
    $('build').textContent = 'build ' + s.build;

    var orders = s.owned_orders || [];
    // Only a LIVE order is "our current bid" - owned_orders also carries recently
    // cancelled/completed rows (from the ledger), which must not drive the tiles.
    var live = orders.filter(function (o) { return isLiveOrderStatus(o.status); });
    var primary = live[0];
    $('curPrice').textContent = primary ? fmtPrice(primary.price_btc) : '—';
    $('curPriceUnit').textContent = primary ? priceUnit() : 'no active order';
    $('curDelivered').textContent = fmtSpeed(live.reduce(function (a, o) { return a + (o.accepted_speed_units || 0); }, 0));
    var liveRigs = live.reduce(function (a, o) { return a + (o.rigs_count || 0); }, 0);
    $('curDeliveredUnit').textContent = speedUnit() + (liveRigs ? (' · ' + liveRigs + ' miner' + (liveRigs === 1 ? '' : 's')) : '');
    // Order balance = escrow remaining in the live order (not the wallet); the
    // wallet balance still shows in the P&L panel.
    $('orderBalance').textContent = primary ? fmtBtc(primary.available_amount_btc) : '—';
    $('orderBalanceSub').textContent = primary ? 'escrow left in order' : 'no active order';
    $('orderRunway').textContent = primary ? runwayHours(primary) : '—';
    $('orderRunwaySub').textContent = primary
      ? (primary.accepted_speed_units > 0 ? 'until escrow runs out' : 'at full limit (not yet filled)')
      : 'no active order';
    $('anchor').textContent = s.market ? fmtPrice(s.market.anchor_price_btc) : '—';
    $('anchorUnit').textContent = priceUnit() + ' · marginal fill (NiceHash purple)';
    var nextTier = s.market && s.market.next_filled_price_btc != null ? s.market.next_filled_price_btc : null;
    $('nextTier').textContent = nextTier != null ? fmtPrice(nextTier) : '—';
    $('nextTierUnit').textContent = priceUnit() + ' · next filled tier (cyan)';
    $('supply').textContent = s.market ? fmtSpeed(s.market.total_speed_units) : '—';
    $('supplyUnit').textContent = speedUnit() + (s.market && s.market.thin ? ' · thin market' : '');

    var props = s.proposals || [];
    var outs = s.outcomes || [];

    // --- "What's happening" panel ---
    var am = $('actMode'); am.textContent = s.run_mode; am.className = 'badge mode-' + s.run_mode;
    var nowMsg;
    if (s.run_mode === 'PAUSED') nowMsg = 'Paused — no decisions are running.';
    else if (s.orders_error) nowMsg = 'Holding — can’t read your NiceHash orders.';
    else if (!s.market) nowMsg = 'Holding — market unavailable.';
    else if (primary) nowMsg = 'Tracking order ' + (primary.order_id || '').slice(0, 8) + ' at ' + fmtPrice(primary.price_btc) + ' ' + priceUnit() + ' · delivering ' + fmtSpeed(primary.accepted_speed_units) + ' ' + speedUnit() + (primary.rigs_count ? (' · ' + primary.rigs_count + ' miner' + (primary.rigs_count === 1 ? '' : 's')) : '');
    else if (props.length && props[0].kind === 'CREATE_ORDER') nowMsg = 'No active order — placing a new bid this cycle.';
    else nowMsg = 'Holding — no order yet, waiting for conditions.';
    $('actNow').textContent = nowMsg;
    $('nextAction').innerHTML = props.length
      ? ('Next: ' + props.map(function (p) { return esc(p.kind) + ' — ' + esc(p.reason); }).join('<br>'))
      : 'Next: hold — no action expected next tick.';
    var lastOut = outs.length ? outs.map(function (o) { return o.outcome + (o.detail ? (' · ' + o.detail) : ''); }).join(' / ') : '';
    $('actLast').textContent = (s.tick_at ? ('last decision ' + new Date(s.tick_at).toLocaleTimeString()) : 'no decision yet') + (lastOut ? (' · ' + lastOut) : '');
    updateTickCountdown();

    $('orders').innerHTML = orders.length ? orders.map(function (o) {
      return '<tr><td><code>' + esc((o.order_id || '').slice(0, 8)) + '</code></td><td>' + fmtPrice(o.price_btc) +
        '</td><td>' + fmtSpeed(o.limit_units) + ' ' + speedUnit() + '</td><td>' + fmtSpeed(o.accepted_speed_units) + ' ' + speedUnit() +
        '</td><td>' + (o.rigs_count || 0) + '</td><td>' + fmtBtc(o.available_amount_btc) + '</td><td>' + runwayHours(o) + '</td><td>' + esc(o.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted">no order — ' + (s.market ? 'holding' : 'market unavailable') + '</td></tr>';

    var warns = [];
    if ((s.unknown_orders || []).length) warns.push('⚠️ ' + s.unknown_orders.length + ' unknown order(s) on the account — the controller PAUSES until resolved.');
    if (s.orders_error) warns.push('⚠️ Can’t read your NiceHash orders: ' + s.orders_error + ' — the bot is holding (no action) until this clears. Check your API key/secret/permissions on the Config tab.');
    else if (s.market_error) warns.push('⚠️ Can’t read the order book: ' + s.market_error + ' — the bot is holding (no action) until this clears.');
    $('unknownWarn').innerHTML = warns.length ? warns.map(function (w) { return '<div class="warn">' + esc(w) + '</div>'; }).join('') : '';

    var outs = s.outcomes || [];
    $('actions').innerHTML = props.length ? props.map(function (p, i) {
      var o = outs[i] || {};
      var cls = o.outcome === 'EXECUTED' ? 'ok' : o.outcome === 'FAILED' ? 'failed' : o.outcome === 'DRY_RUN' ? 'dry' : 'blocked';
      var label = o.outcome ? (o.outcome + (o.detail ? (' · ' + o.detail) : '')) : '';
      return '<tr><td>' + esc(p.kind) + '</td><td class="muted">' + esc(p.reason) + '</td><td><span class="pill ' + cls + '">' + esc(label) + '</span></td></tr>';
    }).join('') : '<tr><td colspan="3" class="muted">holding — no action</td></tr>';
  }

  function renderAll() { renderStatus(); renderTiles(); renderPnl(); renderCharts(); }

  // ---- fetchers ------------------------------------------------------------
  async function refreshStatus() {
    try { var r = await fetch('/api/nicehash/status'); lastStatus = await r.json();
      if (lastStatus && lastStatus.config) applyBaseUnit(lastStatus.config.speed_unit);
      renderStatus(); renderPnl();
      // Keep the summary tiles (dynamic cap / margin / hashprice-now / averages)
      // in step with the live status instead of a slow 30s cache.
      if ($('page-status').classList.contains('active')) loadSummary(); }
    catch (e) { $('sub').textContent = 'connection error'; }
  }
  async function loadMetrics() {
    try { var r = await fetch('/api/nicehash/metrics?range=' + encodeURIComponent(UI.range)); lastMetrics = (await r.json()).rows || []; }
    catch (e) { lastMetrics = []; }
    // markers for the price chart come from history within roughly the range
    try { var h = await fetch('/api/nicehash/history?limit=500'); lastEventsForChart = (await h.json()).events || []; } catch (e) { lastEventsForChart = []; }
    renderCharts();
  }
  async function loadSummary() {
    try { var r = await fetch('/api/nicehash/summary?range=' + encodeURIComponent(UI.range)); lastSummary = await r.json(); renderTiles(); renderPnl(); }
    catch (e) { lastSummary = null; }
  }

  // ---- history page --------------------------------------------------------
  function deltaCell(e) {
    if (e.price_before == null || e.price_after == null) return '—';
    var d = e.price_after - e.price_before; return (d > 0 ? '+' : '') + fmtPrice(d, 6);
  }
  async function loadHistory() {
    $('histMsg').textContent = 'loading…';
    var acts = [];
    Array.prototype.forEach.call(document.querySelectorAll('#histActions button.active'), function (b) { acts.push(b.getAttribute('data-act')); });
    var qs = 'limit=500';
    if (acts.length) qs += '&action=' + acts.join(',');
    var order = $('histOrder').value.trim(); if (order) qs += '&order=' + encodeURIComponent(order);
    var md = parseFloat($('histMinDelta').value); if (md > 0) qs += '&minDelta=' + md;
    try {
      var r = await fetch('/api/nicehash/history?' + qs); var rows = (await r.json()).events || [];
      $('histRows').innerHTML = rows.length ? rows.map(function (e) {
        var oc = e.outcome === 'EXECUTED' ? 'ok' : e.outcome === 'FAILED' ? 'failed' : 'dry';
        return '<tr><td>' + new Date(e.ts).toLocaleString() + '</td><td><code>' + esc((e.order_id || '').slice(0, 8)) + '</code></td><td>' +
          esc(e.action) + '</td><td><span class="pill ' + oc + '">' + esc(e.outcome) + '</span></td><td>' + fmtPrice(e.price_before, 6) +
          '</td><td>' + fmtPrice(e.price_after, 6) + '</td><td>' + deltaCell(e) + '</td><td class="muted">' + esc(e.reason || '') + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="muted">no events match the filter</td></tr>';
      $('histMsg').textContent = rows.length + ' event(s)';
    } catch (e) { $('histMsg').textContent = 'failed to load history'; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('#histActions button'), function (b) {
    b.addEventListener('click', function () { b.classList.toggle('active'); loadHistory(); });
  });
  $('histReload').addEventListener('click', loadHistory);
  $('histOrder').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadHistory(); });

  // ---- logs page -----------------------------------------------------------
  async function loadLogs() {
    $('logMsg').textContent = 'loading…';
    var lvls = [];
    Array.prototype.forEach.call(document.querySelectorAll('#logLevels button.active'), function (b) { lvls.push(b.getAttribute('data-lvl')); });
    if (!lvls.length) { $('logRows').innerHTML = '<tr><td colspan="4" class="muted">no levels selected</td></tr>'; $('logMsg').textContent = ''; return; }
    var qs = 'limit=500&level=' + lvls.join(',');
    try {
      var r = await fetch('/api/nicehash/logs?' + qs); var rows = (await r.json()).logs || [];
      $('logRows').innerHTML = rows.length ? rows.map(function (e) {
        var lc = 'lvl-' + esc(e.level);
        var detail = e.detail ? '<div class="logdetail">' + esc(e.detail) + '</div>' : '';
        return '<tr><td>' + new Date(e.ts).toLocaleString() + '</td><td><span class="pill ' + lc + '">' + esc(e.level) +
          '</span></td><td class="muted">' + esc(e.run_mode || '') + '</td><td>' + esc(e.message) + detail + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="muted">no log entries match the filter</td></tr>';
      $('logMsg').textContent = rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies');
    } catch (e) { $('logMsg').textContent = 'failed to load logs'; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('#logLevels button'), function (b) {
    b.addEventListener('click', function () { b.classList.toggle('active'); loadLogs(); });
  });
  $('logReload').addEventListener('click', loadLogs);

  // ---- config page ---------------------------------------------------------
  var CFG = [
    { group: 'Connection', items: [
      ['apiKey', 'API key', 'text', 'Your NiceHash organization API key. Create one at nicehash.com → Settings → API keys with hash-power order permissions.'],
      ['apiSecret', 'API secret', 'password', 'The API secret paired with the key. Write-only: shown as dots once saved — leave the dots to keep it, type a new value to replace it.'],
      ['orgId', 'Organization ID', 'text', 'Your NiceHash organization id (Settings → API keys → your organization).'],
      ['baseUrl', 'Base URL', 'text', 'https://api2.nicehash.com for mainnet (live funds), https://api-test.nicehash.com for the testnet sandbox.'] ] },
    { group: 'Strategy', items: [
      ['algorithm', 'Algorithm', 'text', 'Marketplace algorithm. SHA256ASICBOOST for Bitcoin ASIC hashrate.'],
      ['market', 'Market', 'text', 'Order-book market — BTC for the Bitcoin marketplace.'],
      ['priceCurrency', 'Order-book currency', 'text', 'Currency bucket the order book / market anchor is read from (BTC).'],
      ['balanceCurrency', 'Balance currency', 'text', 'Wallet currency to read your available balance from. BTC on mainnet, TBTC on testnet.'],
      ['tickSeconds', 'Tick seconds', 'number', 'Seconds between control-loop decisions (observe → price → act).'],
      ['targetSpeedUnits', 'Target speed (PH/s)', 'number', 'How much hashrate you want delivered. The bidder prices to win this much from the market.'],
      ['overpayBtcPerUnitDay', 'Overpay (BTC/EH/day)', 'number', 'Cushion added above the market anchor. Higher = more reliably filled but costs more; lower = cheaper but drops out sooner when rivals raise.'],
      ['maxPriceBtcPerUnitDay', 'Max price (BTC/EH/day)', 'number', 'Absolute hard ceiling on the order price (a backstop). The bidder never pays more than this even if the dynamic cap is higher or the hashprice source is down.'],
      ['orderBudgetBtc', 'Order budget (BTC, 0=full)', 'number', 'Escrow used to fund a new order. 0 = use the full available wallet balance.'],
      ['refillAmountBtc', 'Refill amount (BTC, 0=off)', 'number', 'Top-up added to a live order when its escrow runs low. 0 = never refill (let the order drain and re-create).'],
      ['refillWhenRunwayHours', 'Refill when runway < (h)', 'number', 'Trigger a refill once the order\'s remaining runway drops below this many hours.'] ] },
    { group: 'Track-to-fill', items: [
      ['anchorNextFilledTier', 'Anchor on next filled tier', 'checkbox', 'Track the next filled tier (the cyan line — the second-cheapest order winning hashrate) instead of the marginal (purple, the cheapest). On a thin/lumpy market a bid a hair above the marginal often wins nothing because the market is really filling one tier up; anchoring there + your overpay puts the bid where fills actually land (still clamped by the cap). Falls back to the marginal when there is no distinct second tier. On is recommended.'],
      ['minFillPct', 'Minimum fill (% of target)', 'number', 'Treat the order as filled once delivered hashrate reaches this % of your target. Below it, the bidder walks the price up to win more. e.g. 80.'],
      ['walkUpEnabled', 'Walk up to fill', 'checkbox', 'When under-filled (and past the grace period below), raise the bid toward the floor + your overpay to win hashrate, until filled or a price cap binds. While filled it holds the cheaper bid (never chases the floor up) and only walks down. Off = pure floor-tracking (no escalation).'],
      ['walkUpGraceSeconds', 'Walk-up grace (seconds)', 'number', 'How long delivered hashrate must stay below your minimum fill before the bidder starts walking the price up. Gives a freshly placed or just-repriced order time to attract miners before escalating, and paces walk-ups (the timer resets after each raise). 0 = walk up as soon as under-filled. e.g. 180.'] ] },
    { group: 'Cheap mode', items: [
      ['cheapModeEnabled', 'Enable cheap mode', 'checkbox', 'When our bid sits far below the network hashprice, opportunistically scale the target up to grab cheap hashrate.'],
      ['cheapModeTargetUnits', 'Cheap-mode target (PH/s)', 'number', 'Target speed to scale up to while cheap mode is engaged. Must exceed the normal target to have an effect.'],
      ['cheapThresholdPct', 'Cheap threshold (% of hashprice)', 'number', 'Engage cheap mode when our bid is below this percentage of the network hashprice (e.g. 95).'] ] },
    { group: 'Dynamic price cap', items: [
      ['dynamicCapEnabled', 'Enable dynamic cap', 'checkbox', 'When on, the bid is capped at the fee-adjusted, buffered hashprice (the formula below), so the bid plus both fees never eats into your profit buffer. The fixed Max price still applies as an absolute backstop (effective cap = the lower of the two). Needs a hashprice source; if hashprice is unavailable the bot falls back to the Max price. Off = pricing uses overpay + Max price only.'],
      ['niceHashFeePct', 'NiceHash fee (%)', 'number', 'NiceHash marketplace fee charged on each order (typically ~3%). Subtracted from hashprice in the dynamic cap and the fee-aware P&L.'],
      ['poolFeePct', 'Pool fee (%)', 'number', 'Your mining pool fee (typically ~1%). Subtracted from hashprice in the dynamic cap and the fee-aware P&L.'],
      ['dynamicCapBufferBtc', 'Profit buffer (BTC/EH/day)', 'number', 'Margin held back below the fee-adjusted hashprice. Dynamic cap = hashprice ÷ (1 + (NiceHash fee + pool fee)/100) − this buffer (fees are a markup on your bid, so bid + fees stays within hashprice). Higher = more profit headroom but you may not win when the market runs hot; 0 = pure break-even (no margin).'] ] },
    { group: 'Pool', items: [
      ['poolHost', 'Pool host', 'text', 'Your stratum pool hostname. The app registers it with NiceHash automatically (no fee).'],
      ['poolPort', 'Pool port', 'number', 'Stratum port of your pool.'],
      ['poolUser', 'Pool user', 'text', 'Pool username / worker — often your BTC payout address (with an optional .worker suffix).'],
      ['poolPassword', 'Pool password', 'text', 'Pool password. Many pools accept "x".'] ] },
    { group: 'Daemon & data', items: [
      ['bootMode', 'Boot mode', 'select:DRY_RUN,RESUME,LIVE', 'Run mode on restart: DRY_RUN always starts safe; RESUME keeps the last mode (PAUSED is demoted to DRY_RUN); LIVE boots straight into trading.'],
      ['hashpriceSource', 'Hashprice source', 'select:none,mempool', 'Network-hashprice source for the cost-vs-hashprice tile and the estimated P&L. "mempool" uses mempool.space (mainnet); "none" disables those estimates.'],
      ['priceSource', 'BTC price source', 'text', 'BTC/USD source for display purposes (reserved for a future USD toggle).'],
      ['retentionDays', 'History retention (days)', 'number', 'How many days of per-tick metrics and order history to keep before pruning.'],
      ['logRetentionDays', 'Log retention (days)', 'select:15,30,60,90', 'How many days of decision + error logs (the Logs tab) to keep before pruning.'] ] }
  ];
  // A config field is a BTC/EH/day *price* field (Overpay, Max price, Profit
  // buffer). These are capped to the order book's 0.0001 granularity: the input
  // steps by 0.0001 and the value is rounded to 4 decimals on load + save.
  function isCfgPrice(it) { return it[2] === 'number' && /BTC\/\w+\/day/.test(it[1]); }
  function round4(v) { var n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : v; }
  function buildConfigForm() {
    var html = '';
    CFG.forEach(function (g) {
      html += '<fieldset><legend>' + esc(g.group) + '</legend><div class="formgrid">';
      g.items.forEach(function (it) {
        var id = 'cfg_' + it[0], type = it[2];
        // Speed fields are entered in the market's display unit; reflect it.
        var label = it[1].replace('PH/s', baseSpeedUnit + '/s');
        var help = it[3] ? '<span class="help">' + esc(it[3]) + '</span>' : '';
        if (type === 'checkbox') {
          html += '<label><span class="chkrow"><input id="' + id + '" type="checkbox" />' + esc(label) + '</span>' + help + '</label>';
        } else if (type.indexOf('select:') === 0) {
          var opts = type.slice(7).split(',').map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('');
          html += '<label>' + esc(label) + '<select id="' + id + '">' + opts + '</select>' + help + '</label>';
        } else {
          // Price fields step by the order-book granularity (0.0001); other numbers
          // stay free-form.
          var extra = type === 'number' ? (isCfgPrice(it) ? ' step="0.0001" min="0"' : ' step="any"') : type === 'password' ? ' autocomplete="off"' : '';
          html += '<label>' + esc(label) + '<input id="' + id + '" type="' + type + '"' + extra + ' />' + help + '</label>';
        }
      });
      html += '</div></fieldset>';
    });
    $('configForm').innerHTML = html;
    // Auto-save: persist on field change (debounced). The change event fires on
    // blur / Enter / toggle, so we do not save half-typed numbers; the daemon
    // then picks the new values up live on the next tick (no restart).
    Array.prototype.forEach.call(document.querySelectorAll('#configForm input, #configForm select'), function (el) {
      el.addEventListener('change', autosave);
    });
  }
  var saveTimer = null;
  function autosave() {
    if (saveTimer) clearTimeout(saveTimer);
    $('cfgMsg').textContent = 'saving…';
    saveTimer = setTimeout(saveConfig, 500);
  }
  function fillConfig(cfg) {
    CFG.forEach(function (g) { g.items.forEach(function (it) {
      var el = $('cfg_' + it[0]); if (!el) return;
      var v = cfg[it[0]];
      if (it[2] === 'checkbox') el.checked = !!v;
      else if (v === null || v === undefined || v === '') el.value = '';
      // Price fields display at the order book's 4-decimal granularity.
      else el.value = isCfgPrice(it) ? round4(v) : v;
    }); });
  }
  function collectConfig() {
    var out = {};
    CFG.forEach(function (g) { g.items.forEach(function (it) {
      var el = $('cfg_' + it[0]); if (!el) return;
      if (it[2] === 'checkbox') { out[it[0]] = el.checked; return; }
      // Persist price fields rounded to the order book's 0.0001 granularity.
      out[it[0]] = (isCfgPrice(it) && el.value !== '') ? round4(el.value) : el.value;
    }); });
    return out;
  }
  async function loadConfig() {
    try { var r = await fetch('/api/nicehash/config'); fillConfig((await r.json()).config || {}); }
    catch (e) { $('cfgMsg').textContent = 'failed to load config'; }
  }
  async function saveConfig() {
    $('cfgMsg').textContent = 'saving…';
    try { var r = await fetch('/api/nicehash/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collectConfig()) });
      var j = await r.json(); fillConfig(j.config || {}); $('cfgMsg').textContent = j.note || 'saved'; refreshStatus(); }
    catch (e) { $('cfgMsg').textContent = 'save failed'; }
  }
  async function testConfig() {
    $('testMsg').innerHTML = 'testing pool, hashprice, BTC price & NiceHash API…';
    try {
      var r = await fetch('/api/nicehash/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collectConfig()) });
      var j = await r.json();
      var checks = j.checks || [];
      if (!checks.length) {
        $('testMsg').innerHTML = '<span class="pill failed">FAILED</span> ' + esc(j.error || 'no checks returned');
        return;
      }
      var rows = checks.map(function (c) {
        var pill = c.skipped ? '<span class="pill blocked">SKIPPED</span>' : c.ok ? '<span class="pill ok">OK</span>' : '<span class="pill failed">FAILED</span>';
        return '<tr><td>' + esc(c.name) + '</td><td>' + pill + '</td><td class="muted">' + esc(c.detail || '') + '</td></tr>';
      }).join('');
      $('testMsg').innerHTML = '<table style="margin-top:10px"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) { $('testMsg').innerHTML = '<span class="pill failed">FAILED</span> ' + esc(e.message || String(e)); }
  }
  $('cfgSave').addEventListener('click', saveConfig);
  $('cfgTest').addEventListener('click', testConfig);

  // ---- boot ----------------------------------------------------------------
  buildConfigForm();
  syncToggles();
  Array.prototype.forEach.call(document.querySelectorAll('#rangebar button'), function (b) { b.classList.toggle('active', b.getAttribute('data-range') === UI.range); });
  // ---- rearrangeable tiles -------------------------------------------------
  // Each .grid[data-tilegrid] is a drag container: any card can be dragged to a
  // new slot and the order persists per-grid in localStorage (keyed by each
  // card's data-tile). Tiles are updated by id / rebuilt in place, so reordering
  // the DOM is safe; the dynamic grids (#tiles, #pnl) re-run applyTileOrder after
  // each innerHTML rebuild to restore the saved order.
  function tileOrderKey(id) { return 'nh.tileorder.' + id; }
  function gridCards(grid) { return Array.prototype.filter.call(grid.children, function (c) { return c.classList && c.classList.contains('card'); }); }
  function readTileOrder(id) {
    try { var v = JSON.parse(localStorage.getItem(tileOrderKey(id)) || 'null'); return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  function saveTileOrder(grid) {
    var id = grid.getAttribute('data-tilegrid'); if (!id) return;
    var order = gridCards(grid).map(function (c) { return c.getAttribute('data-tile'); }).filter(Boolean);
    localStorage.setItem(tileOrderKey(id), JSON.stringify(order));
  }
  function markDraggable(grid) {
    gridCards(grid).forEach(function (c) {
      if (c.getAttribute('data-tile')) { c.setAttribute('draggable', 'true'); c.classList.add('draggable'); }
    });
  }
  function applyTileOrder(grid) {
    if (!grid || !grid.getAttribute('data-tilegrid')) return;
    var order = readTileOrder(grid.getAttribute('data-tilegrid'));
    if (order) {
      var byKey = {};
      gridCards(grid).forEach(function (c) { var k = c.getAttribute('data-tile'); if (k) byKey[k] = c; });
      // Re-append known cards in saved order; unknown/new cards keep their spot at the end.
      order.forEach(function (k) { if (byKey[k]) { grid.appendChild(byKey[k]); delete byKey[k]; } });
    }
    markDraggable(grid);
  }
  function tileAfterElement(grid, x, y) {
    var best = null, bestDist = Infinity, before = true;
    gridCards(grid).forEach(function (c) {
      if (c.classList.contains('dragging')) return;
      var b = c.getBoundingClientRect();
      var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      var dx = x - cx, dy = y - cy, dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; best = c; before = (y < cy - b.height / 2) || (Math.abs(y - cy) <= b.height / 2 && x < cx); }
    });
    if (!best) return null;
    return before ? best : best.nextElementSibling;
  }
  function enableTileDrag(grid) {
    var dragged = null;
    grid.addEventListener('dragstart', function (e) {
      var c = e.target && e.target.closest ? e.target.closest('.card') : null;
      if (!c || c.parentNode !== grid || !c.getAttribute('data-tile')) return;
      dragged = c; c.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', c.getAttribute('data-tile')); } catch (err) {} }
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragged) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var after = tileAfterElement(grid, e.clientX, e.clientY);
      if (after === dragged) return;
      if (after == null) grid.appendChild(dragged); else grid.insertBefore(dragged, after);
    });
    grid.addEventListener('drop', function (e) { if (dragged) e.preventDefault(); });
    grid.addEventListener('dragend', function () {
      if (!dragged) return;
      dragged.classList.remove('dragging'); saveTileOrder(grid); dragged = null;
    });
  }
  function initTiles() {
    Array.prototype.forEach.call(document.querySelectorAll('.grid[data-tilegrid]'), function (grid) {
      enableTileDrag(grid); applyTileOrder(grid);
    });
    var reset = $('resetTiles');
    if (reset) reset.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.grid[data-tilegrid]'), function (grid) {
        localStorage.removeItem(tileOrderKey(grid.getAttribute('data-tilegrid')));
      });
      location.reload();
    });
  }
  initTiles();

  refreshStatus(); loadMetrics(); loadSummary();
  // Poll cadence. The underlying data only changes once per control-loop tick
  // (the "Tick seconds" setting), so these mainly bound how soon a finished tick
  // shows up: status/tiles every 3s, charts every 10s.
  setInterval(refreshStatus, 3000);
  setInterval(updateTickCountdown, 1000);
  setInterval(function () { if ($('page-status').classList.contains('active')) { loadMetrics(); } }, 10000);
  window.addEventListener('resize', renderCharts);
})();
</script>
</body>
</html>`;

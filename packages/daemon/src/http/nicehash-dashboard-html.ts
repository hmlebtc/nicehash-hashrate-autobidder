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
  .badge.switching { background: #facc1533; color: var(--gold); animation: nhpulse 1s ease-in-out infinite; }
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
  .chartcard { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-top: 12px; }
  .chartcard .head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .chartcard h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--orange); margin: 0; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  canvas { width: 100%; height: 220px; display: block; margin-top: 8px; }
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
    <div class="grid">
      <div class="card"><h2>Price (current bid)</h2><div class="big" id="curPrice">—</div><div class="muted" id="curPriceUnit"></div></div>
      <div class="card"><h2>Delivered</h2><div class="big" id="curDelivered">—</div><div class="muted" id="curDeliveredUnit"></div></div>
      <div class="card"><h2>Available balance</h2><div class="big" id="balance">—</div><div class="muted">BTC</div></div>
      <div class="card"><h2>Market anchor</h2><div class="big" id="anchor">—</div><div class="muted" id="anchorUnit">price to beat</div></div>
      <div class="card"><h2>Market supply</h2><div class="big" id="supply">—</div><div class="muted" id="supplyUnit"></div></div>
      <div class="card"><h2>Next action</h2>
        <div id="nextAction" class="muted">—</div>
        <div class="btnrow" style="margin-bottom:0">
          <button id="runNow" class="primary">Run decision now</button>
          <span class="msg" id="nextTick"></span>
        </div>
      </div>
    </div>

    <div class="rangebar" id="rangebar">
      <button data-range="3h">3h</button><button data-range="6h">6h</button>
      <button data-range="12h">12h</button><button data-range="24h" class="active">24h</button>
      <button data-range="1w">1w</button><button data-range="1m">1m</button>
      <button data-range="1y">1y</button><button data-range="all">All</button>
    </div>

    <div class="grid" id="tiles"></div>

    <div class="chartcard">
      <div class="head"><h3>Hashrate</h3>
        <div class="legend">
          <span><i class="swatch" style="background:#fb923c"></i>delivered</span>
          <span><i class="swatch" style="background:#3b82f6"></i>limit</span>
          <span><i class="swatch" style="background:#64748b"></i>target</span>
          <span><i class="swatch" style="background:#64748b"></i>floor</span>
        </div>
      </div>
      <canvas id="hashChart"></canvas>
    </div>

    <div class="chartcard">
      <div class="head"><h3>Price</h3>
        <div class="legend">
          <span><i class="swatch" style="background:#fb923c"></i>our price</span>
          <span><i class="swatch" style="background:#22d3ee"></i>anchor</span>
          <span><i class="swatch" style="background:#a78bfa"></i>hashprice</span>
          <span><i class="swatch" style="background:#34d399"></i>break-even</span>
          <span><i class="swatch" style="background:#34d399;border-radius:50%;width:6px;height:6px"></i>create</span>
          <span><i class="swatch" style="background:#facc15;border-radius:50%;width:6px;height:6px"></i>edit</span>
          <span><i class="swatch" style="background:#f87171;border-radius:50%;width:6px;height:6px"></i>cancel</span>
        </div>
      </div>
      <canvas id="priceChart"></canvas>
    </div>

    <h2 class="section">Our orders</h2>
    <table>
      <thead><tr><th>Order</th><th>Price</th><th>Limit</th><th>Delivered</th><th>Escrow left</th><th>Runway</th><th>Status</th></tr></thead>
      <tbody id="orders"><tr><td colspan="7" class="muted">—</td></tr></tbody>
    </table>

    <h2 class="section">Profit &amp; loss <span class="muted" style="text-transform:none">(income/net are estimates from the hashprice oracle)</span></h2>
    <div class="grid" id="pnl"></div>

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
    <p class="muted">The secret is write-only — leave it as the dots to keep the saved value, or type a new one to replace it.
      <b>Test connection</b> uses the values currently in the form (read-only). <b>Save</b> persists them; connection/strategy
      changes take effect after an app restart, the run mode applies immediately.</p>
    <div id="configForm"></div>
    <div class="btnrow">
      <button id="cfgTest">Test connection</button>
      <button id="cfgSave" class="primary">Save</button>
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
  function speedUnit() { return UI.speed + '/s'; }
  function priceUnit() { return (UI.price === 'sat' ? 'sat' : 'BTC') + '/EH/day'; }
  function fmtSpeed(ph, d) { var v = cvSpeed(ph); return v == null ? '—' : v.toFixed(d == null ? 2 : d); }
  function fmtPrice(btc, d) { var v = cvPrice(btc); if (v == null) return '—'; return UI.price === 'sat' ? Math.round(v).toLocaleString() : v.toFixed(d == null ? 8 : d); }
  function fmtBtc(v, d) { return v == null ? '—' : Number(v).toFixed(d == null ? 8 : d); }
  function useBreakEvenOn() { var c = lastStatus && lastStatus.config; return !!(c && c.use_break_even); }
  function totalFeePct() { if (!useBreakEvenOn()) return 0; var c = lastStatus && lastStatus.config; return c ? ((c.nicehash_fee_pct || 0) + (c.pool_fee_pct || 0)) : 0; }
  function breakEvenBtc(hp) { return (hp == null || !useBreakEvenOn()) ? null : hp / (1 + totalFeePct() / 100); }

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
  var modeBusy = false;
  function modeSwitching(on) {
    modeBusy = on;
    Array.prototype.forEach.call(document.querySelectorAll('.controls button'), function (b) { b.disabled = on; });
    if (on) { var badge = $('modeBadge'); badge.textContent = 'switching…'; badge.className = 'badge switching'; }
  }
  async function setMode(mode) {
    if (modeBusy) return;
    if (mode === 'LIVE' && !confirm('Switch to LIVE? The bidder will place and manage REAL orders.')) return;
    modeSwitching(true); // instant feedback: the round trip can take a moment
    try {
      await fetch('/api/nicehash/run-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode }) });
    } catch (e) { /* surfaced by the refresh below */ }
    modeSwitching(false);
    await refreshStatus(); // re-paints the badge + buttons from the applied mode
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
    var padL = 60, padR = 12, padT = 8, padB = 22, w = cssW - padL - padR, h = cssH - padT - padB;
    var xs = [], ys = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (p.y != null && isFinite(p.y)) { xs.push(p.x); ys.push(p.y); } }); });
    ctx.font = '10px system-ui';
    if (!xs.length) { ctx.fillStyle = '#586069'; ctx.fillText('no data yet', padL, padT + h / 2); return; }
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    if (opts.yMinZero && ymin > 0) ymin = 0;
    if (ymax === ymin) ymax = ymin + (ymin === 0 ? 1 : Math.abs(ymin) * 0.1);
    var p = (ymax - ymin) * 0.08; ymin -= p; ymax += p;
    if (opts.yMinZero && ymin < 0) ymin = 0;
    function X(x) { return padL + (xmax === xmin ? 0 : (x - xmin) / (xmax - xmin)) * w; }
    function Y(y) { return padT + h - (y - ymin) / (ymax - ymin) * h; }
    ctx.strokeStyle = '#21262d'; ctx.fillStyle = '#8b949e'; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var yy = padT + h * (i / 4), val = ymax - (ymax - ymin) * (i / 4);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
      ctx.fillText(opts.fmtY ? opts.fmtY(val) : val.toFixed(2), 4, yy + 3);
    }
    ctx.fillStyle = '#8b949e';
    [xmin, (xmin + xmax) / 2, xmax].forEach(function (t, idx) {
      var lx = X(t); ctx.textAlign = idx === 0 ? 'left' : idx === 2 ? 'right' : 'center';
      ctx.fillText(new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), lx, padT + h + 14);
    });
    ctx.textAlign = 'left';
    series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath(); var started = false;
      s.points.forEach(function (pt) {
        if (pt.y == null || !isFinite(pt.y)) { started = false; return; }
        var px = X(pt.x), py = Y(pt.y);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });
    ctx.setLineDash([]);
    (opts.markers || []).forEach(function (m) {
      if (m.x < xmin || m.x > xmax) return;
      ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(X(m.x), padT + h - 3, 3, 0, 6.283); ctx.fill();
    });
  }

  // ---- state caches --------------------------------------------------------
  var lastStatus = null, lastMetrics = [], lastSummary = null, lastEventsForChart = [];

  function setRange(r) {
    UI.range = r; localStorage.setItem('nh.range', r);
    Array.prototype.forEach.call(document.querySelectorAll('#rangebar button'), function (b) { b.classList.toggle('active', b.getAttribute('data-range') === r); });
    loadMetrics(); loadSummary();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#rangebar button'), function (b) {
    b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); });
  });

  function renderCharts() {
    var m = lastMetrics;
    var hash = [
      { color: '#fb923c', points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.accepted_speed_units) }; }) },
      { color: '#3b82f6', points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.limit_units) }; }) },
      { color: '#64748b', dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.target_units) }; }) },
      { color: '#64748b', dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvSpeed(r.floor_units) }; }) }
    ];
    drawChart($('hashChart'), hash, { yMinZero: true, fmtY: function (v) { return v.toFixed(v < 10 ? 2 : 0); } });

    var markerColor = { CREATE: '#34d399', EDIT_PRICE: '#facc15', EDIT_LIMIT: '#38bdf8', REFILL: '#c084fc', CANCEL: '#f87171' };
    var markers = lastEventsForChart.map(function (e) { return { x: e.ts, color: markerColor[e.action] || '#64748b' }; });
    var price = [
      { color: '#fb923c', points: m.map(function (r) { return { x: r.ts, y: cvPrice(r.our_price_btc) }; }) },
      { color: '#22d3ee', points: m.map(function (r) { return { x: r.ts, y: cvPrice(r.anchor_price_btc) }; }) },
      { color: '#a78bfa', dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvPrice(r.hashprice_btc_per_unit_day) }; }) },
      { color: '#34d399', dashed: true, points: m.map(function (r) { return { x: r.ts, y: cvPrice(breakEvenBtc(r.hashprice_btc_per_unit_day)) }; }) }
    ];
    drawChart($('priceChart'), price, { markers: markers, fmtY: function (v) { return UI.price === 'sat' ? Math.round(v).toLocaleString() : v.toFixed(5); } });
  }

  function tile(label, value, sub, cls) {
    return '<div class="card"><h2>' + esc(label) + '</h2><div class="big ' + (cls || '') + '">' + value + '</div><div class="muted">' + esc(sub || '') + '</div></div>';
  }

  function renderTiles() {
    var s = lastSummary && lastSummary.summary;
    if (!s) { $('tiles').innerHTML = ''; return; }
    var be = breakEvenBtc(s.avg_hashprice_btc_per_unit_day);
    var margin = (be != null && s.avg_our_price_btc != null) ? (be - s.avg_our_price_btc) : null;
    var html = '';
    html += tile('Uptime', s.uptime_pct == null ? '—' : s.uptime_pct.toFixed(1), '%');
    html += tile('Avg delivered', fmtSpeed(s.avg_accepted_units), speedUnit());
    html += tile('Avg price', fmtPrice(s.avg_our_price_btc, 6), priceUnit());
    html += tile('Avg hashprice', fmtPrice(s.avg_hashprice_btc_per_unit_day, 6), priceUnit());
    html += tile('Break-even', fmtPrice(be, 6), useBreakEvenOn() ? (priceUnit() + ' · after ' + totalFeePct() + '% fees') : 'fees & break-even off');
    html += tile('Margin to break-even', margin == null ? '—' : (margin >= 0 ? '+' : '') + fmtPrice(margin, 6), margin == null ? '' : (margin >= 0 ? 'under break-even' : 'OVER break-even'), margin == null ? '' : (margin >= 0 ? 'pos' : 'neg'));
    html += tile('Samples', String(s.samples || 0), 'ticks in range');
    $('tiles').innerHTML = html;
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
    html += tile('Spend + fees / day', fmtBtc(effSpend, 6), useBreakEvenOn() ? ('BTC/day · incl. ' + totalFeePct() + '% fees') : 'BTC/day · fees off');
    html += tile('Est. income / day', fmtBtc(income, 6), 'BTC/day · at hashprice');
    html += tile('Est. net / day', net == null ? '—' : (net >= 0 ? '+' : '') + fmtBtc(net, 6), 'BTC/day', net == null ? '' : (net >= 0 ? 'pos' : 'neg'));
    html += tile('Est. return', ret == null ? '—' : (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%', 'net / cost', ret == null ? '' : (ret >= 0 ? 'pos' : 'neg'));
    $('pnl').innerHTML = html;
  }

  function runwayHours(o) {
    var rate = (o.price_btc || 0) * ((o.accepted_speed_units > 0 ? o.accepted_speed_units : o.limit_units) || 0);
    if (!(o.available_amount_btc > 0)) return '0h';
    if (rate <= 0) return '∞';
    return ((o.available_amount_btc / rate) * 24).toFixed(1) + 'h';
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
    var primary = orders[0];
    $('curPrice').textContent = primary ? fmtPrice(primary.price_btc) : (s.market ? '—' : '—');
    $('curPriceUnit').textContent = priceUnit();
    $('curDelivered').textContent = fmtSpeed(orders.reduce(function (a, o) { return a + (o.accepted_speed_units || 0); }, 0));
    $('curDeliveredUnit').textContent = speedUnit();
    $('balance').textContent = fmtBtc(s.balance_btc);
    $('anchor').textContent = s.market ? fmtPrice(s.market.anchor_price_btc) : '—';
    $('anchorUnit').textContent = priceUnit() + ' · marginal fill (NiceHash purple)';
    $('supply').textContent = s.market ? fmtSpeed(s.market.total_speed_units) : '—';
    $('supplyUnit').textContent = speedUnit() + (s.market && s.market.thin ? ' · thin market' : '');

    var props = s.proposals || [];
    $('nextAction').innerHTML = props.length ? props.map(function (p) { return esc(p.kind) + ' — ' + esc(p.reason); }).join('<br>') : 'holding — no action';
    if (s.tick_at && s.tick_seconds) {
      var nextAt = s.tick_at + s.tick_seconds * 1000, secs = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
      $('nextTick').textContent = 'next tick in ~' + secs + 's';
    }

    $('orders').innerHTML = orders.length ? orders.map(function (o) {
      return '<tr><td><code>' + esc((o.order_id || '').slice(0, 8)) + '</code></td><td>' + fmtPrice(o.price_btc) +
        '</td><td>' + fmtSpeed(o.limit_units) + ' ' + speedUnit() + '</td><td>' + fmtSpeed(o.accepted_speed_units) + ' ' + speedUnit() +
        '</td><td>' + fmtBtc(o.available_amount_btc) + '</td><td>' + runwayHours(o) + '</td><td>' + esc(o.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">no order — ' + (s.market ? 'holding' : 'market unavailable') + '</td></tr>';

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
      renderStatus(); renderPnl(); }
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
      ['minimumFloorUnits', 'Minimum floor (PH/s)', 'number', 'A speed reference line drawn on the hashrate chart — NOT a price. The price "floor" you must outbid (the marginal/last-filled order, shown purple in NiceHash\'s order book) is the live market anchor and is tracked automatically.'],
      ['overpayBtcPerUnitDay', 'Overpay (BTC/EH/day)', 'number', 'Cushion added above the market anchor. Higher = more reliably filled but costs more; lower = cheaper but drops out sooner when rivals raise.'],
      ['maxPriceBtcPerUnitDay', 'Max price (BTC/EH/day)', 'number', 'Hard ceiling on the order price. The bidder never pays more than this, even if it means not winning the full target.'],
      ['maxPremiumOverHashpriceBtc', 'Max premium over hashprice (0=off)', 'number', 'Dynamic ceiling = network hashprice + this (BTC/EH/day). Stops overpaying when hashprice falls. 0 disables it; needs a hashprice source.'],
      ['orderBudgetBtc', 'Order budget (BTC, 0=full)', 'number', 'Escrow used to fund a new order. 0 = use the full available wallet balance.'],
      ['refillAmountBtc', 'Refill amount (BTC, 0=off)', 'number', 'Top-up added to a live order when its escrow runs low. 0 = never refill (let the order drain and re-create).'],
      ['refillWhenRunwayHours', 'Refill when runway < (h)', 'number', 'Trigger a refill once the order\'s remaining runway drops below this many hours.'] ] },
    { group: 'Track-to-fill', items: [
      ['minFillPct', 'Minimum fill (% of target)', 'number', 'Treat the order as filled once delivered hashrate reaches this % of your target. Below it, the bidder walks the price up to win more. e.g. 80.'],
      ['walkUpStepBtc', 'Walk-up step (BTC/EH/day, 0=off)', 'number', 'How much to raise the bid each step while under-filled. Raises are unrestricted on NiceHash, so this escalates quickly. 0 = never walk up (pure floor-tracking).'],
      ['walkUpSettleSeconds', 'Walk-up settle (seconds)', 'number', 'Wait this long after a bid change before the next walk-up step, giving miners time to re-point so the bot does not overshoot. e.g. 180.'] ] },
    { group: 'Cheap mode', items: [
      ['cheapModeEnabled', 'Enable cheap mode', 'checkbox', 'When our bid sits far below the network hashprice, opportunistically scale the target up to grab cheap hashrate.'],
      ['cheapModeTargetUnits', 'Cheap-mode target (PH/s)', 'number', 'Target speed to scale up to while cheap mode is engaged. Must exceed the normal target to have an effect.'],
      ['cheapThresholdPct', 'Cheap threshold (% of hashprice)', 'number', 'Engage cheap mode when our bid is below this percentage of the network hashprice (e.g. 95).'] ] },
    { group: 'Fees & break-even', items: [
      ['useBreakEven', 'Use fees & break-even in calculations', 'checkbox', 'Master switch. When on, the fees below feed the break-even tiles, the fee-adjusted P&L, and (optionally) the bid cap. When off, fees are ignored everywhere and pricing uses only overpay + the price ceilings.'],
      ['niceHashFeePct', 'NiceHash fee (%)', 'number', 'NiceHash marketplace fee charged on each order (typically ~3%). Used to compute your fee-adjusted break-even.'],
      ['poolFeePct', 'Pool fee (%)', 'number', 'Your mining pool fee (typically ~1%). Break-even = hashprice / (1 + (NiceHash fee + pool fee)/100) - the most you can bid and still cover the bid plus both fees out of the hashprice.'],
      ['capAtBreakEven', 'Cap bids at break-even', 'checkbox', 'Never bid above the fee-adjusted break-even hashprice, so a bid plus both fees never exceeds what the rented hashrate earns. Needs the master switch above + a hashprice source; in markets priced above break-even the bot will sit at break-even and may not win, by design.'],
      ['editPriceDeadbandPct', 'Edit-price deadband (%)', 'number', 'Only re-price when the anchor moves more than this % of the overpay cushion. Higher = fewer edits (less churn), lower = tracks the market more tightly.'] ] },
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
          var extra = type === 'number' ? ' step="any"' : type === 'password' ? ' autocomplete="off"' : '';
          html += '<label>' + esc(label) + '<input id="' + id + '" type="' + type + '"' + extra + ' />' + help + '</label>';
        }
      });
      html += '</div></fieldset>';
    });
    $('configForm').innerHTML = html;
  }
  function fillConfig(cfg) {
    CFG.forEach(function (g) { g.items.forEach(function (it) {
      var el = $('cfg_' + it[0]); if (!el) return;
      if (it[2] === 'checkbox') el.checked = !!cfg[it[0]];
      else el.value = (cfg[it[0]] === null || cfg[it[0]] === undefined) ? '' : cfg[it[0]];
    }); });
  }
  function collectConfig() {
    var out = {};
    CFG.forEach(function (g) { g.items.forEach(function (it) {
      var el = $('cfg_' + it[0]); if (!el) return;
      out[it[0]] = it[2] === 'checkbox' ? el.checked : el.value;
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
  refreshStatus(); loadMetrics(); loadSummary();
  setInterval(refreshStatus, 5000);
  setInterval(function () { if ($('page-status').classList.contains('active')) { loadMetrics(); loadSummary(); } }, 30000);
  window.addEventListener('resize', renderCharts);
})();
</script>
</body>
</html>`;

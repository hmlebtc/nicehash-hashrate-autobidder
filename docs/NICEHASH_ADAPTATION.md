# NiceHash adaptation

This project is a fork of [Hashrate Autopilot](https://github.com/rdouma/hashrate-autopilot)
(MIT, Remco Douma) that swaps the Braiins Hashpower marketplace for the
[NiceHash Hash-power marketplace](https://www.nicehash.com/marketplace). This
document is the map between the two: what the upstream did against Braiins, what
NiceHash does differently, and how each upstream component is being adapted.

It is the authoritative reference for the migration. The upstream design docs
(`docs/spec.md`, `docs/architecture.md`, `docs/research.md`) still describe the
Braiins behaviour and are kept for reference.

---

## 1. Why the two marketplaces are not drop-in equivalent

Both are "buy hashrate, point it at my pool" marketplaces, but the primitive you
control and the matching model differ.

| Aspect | Braiins Hashpower (upstream) | NiceHash Hash-power (this fork) |
| --- | --- | --- |
| Core primitive | A single **bid** you keep alive and edit in place | An **order** that escrows funds, has a price + speed limit, and drains |
| Matching | **Pay-your-bid**; controller tracks the cheapest *ask* with enough unmatched supply (`fillable_ask`) and sits just above it | **Buyer competition**; sellers deliver to the highest-priced live orders first. You pay your set price; your price's rank decides whether (and how much) hashrate you receive |
| Order type | bid | **STANDARD** only via API (FIXED was removed) |
| Price unit | `sat / EH / day` | `BTC / <display-unit> / day` (PH/s for the SHA256 family, incl. **`SHA256ASICBOOST`** — our target market, BTC-paid; not the `SHA256ASICBOOST_USDT` variant), scaled by `marketFactor` |
| Speed unit | `EH/day` (the controller works in PH/s) | display unit per second (e.g. PH/s), from the algorithm's `displayMarketFactor` |
| Markets | one | **EU / USA** (and regional variants) — separate order books; must pick |
| Funding | account balance; bid amount capped at 1 BTC | per-order **escrow**; **refill** to top up; remaining funds returned on cancel |
| Fees | fee % per bid | **3%** on spend **+ 0.00001 BTC non-refundable per order creation** |
| Destination | inline stratum URL on the bid | a **registered pool** (`poolId`) you create first |
| Auth | single `apikey:` header (owner / read-only tokens) | per-request **HMAC-SHA256** (`X-Auth: key:digest`, `X-Time`, `X-Nonce`, `X-Organization-Id`, `X-Request-Id`) |
| Edit | `PUT /spot/bid` | `POST /hashpower/order/{id}/updatePriceAndLimit` and `/refill` |
| Read | `GET /spot/bid`, `/spot/orderbook` | `GET /hashpower/myOrders`, `/hashpower/orderBook`, `/hashpower/order/{id}` |
| Minimums | tick size from `/spot/settings` | min order 0.001 BTC; STANDARD max 10-day duration; `priceDownStep` per algo |
| Test env | — | **`api-test.nicehash.com`** — full testnet, free, no real BTC |

### Consequences for the control loop

1. **One long-lived order, edited in place.** Each order creation costs a
   non-refundable 0.00001 BTC, so churn (cancel + recreate) is penalised. The
   controller keeps a single order alive and drives it with
   `updatePriceAndLimit`, exactly mirroring the upstream "keep one bid alive and
   edit it" philosophy.
2. **Escrow + refill is a new responsibility.** A Braiins bid draws from the
   account balance; a NiceHash order holds its own escrow that drains to zero
   and then dies. The loop must watch each order's `availableAmount` and
   **refill** before it runs dry (a new proposal kind), and track runway against
   the order rather than only the wallet.
3. **Pools are referenced, not inlined.** Before the first order the loop must
   ensure the operator's stratum pool is registered and resolve its `poolId`.
4. **The pricing anchor changes meaning.** Braiins' `fillable_ask` is the
   cheapest *ask-side supply* price. NiceHash is buyer-competition: there is no
   ask book — there's a list of competing *buy* orders plus total deliverable
   speed. The equivalent anchor is "the marginal price at which my target speed
   gets delivered", derived from competitors' prices and available supply. See
   §4.
5. **Price-decrease throttle.** NiceHash limits how often and how far you may
   lower a STANDARD order's price (`priceDownStep`, and a time throttle). This
   maps onto the upstream's existing `PRICE_DECREASE_COOLDOWN` gate and
   `max_lowering_step` knob — the plumbing already exists.

---

## 2. The NiceHash API surface (implemented in `packages/nicehash-client`)

Base URLs: production `https://api2.nicehash.com`, testnet
`https://api-test.nicehash.com`.

Authentication is per-request HMAC-SHA256. The signed message is a
NUL-delimited concatenation of
`apiKey, time, nonce, "", orgId, "", method, path, query [, body]`; the digest
goes in `X-Auth: <apiKey>:<hexdigest>`. This is implemented and unit-tested
(byte-for-byte against the official reference vectors) in
[`src/auth.ts`](../packages/nicehash-client/src/auth.ts).

Endpoints wrapped by the client:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v2/time` | server clock (skew correction via `syncTime()`) |
| `GET` | `/main/api/v2/mining/algorithms` | `marketFactor`, `displayMarketFactor`, `minSpeedLimit`, `priceDownStep`, `minimalOrderAmount` per algo |
| `GET` | `/main/api/v2/hashpower/orderBook?algorithm=` | competing orders + total speed per market |
| `GET` | `/main/api/v2/accounting/account2/{currency}` | BTC balance (available / pending / total) |
| `GET` | `/main/api/v2/hashpower/myOrders` | my active orders (paginated by `ts`) |
| `GET` | `/main/api/v2/hashpower/order/{id}` | one order's full detail |
| `POST` | `/main/api/v2/hashpower/order/` | create STANDARD order |
| `POST` | `/main/api/v2/hashpower/order/{id}/updatePriceAndLimit/` | change price and/or speed limit |
| `POST` | `/main/api/v2/hashpower/order/{id}/refill/` | add escrow |
| `DELETE` | `/main/api/v2/hashpower/order/{id}` | cancel (refunds remaining escrow) |
| `GET` | `/main/api/v2/pools/` | list registered pools |
| `POST` | `/main/api/v2/pool/` | register a stratum pool |
| `DELETE` | `/main/api/v2/pool/{id}` | remove a pool |

Retry discipline matches the upstream client: reads and cancels retry on
429/5xx/network; mutations (create/update/refill) retry **only** on 429 so an
indeterminate 5xx is never silently re-applied.

`marketFactor` and `displayMarketFactor` are treated as **opaque** — fetched
from `/mining/algorithms` at runtime and echoed verbatim on every order
mutation (the official demo does the same). Nothing about the price/speed units
is hardcoded.

---

## 3. Component-by-component adaptation plan

The packages are `nicehash-client` (done), `daemon`, `dashboard`, `shared`, and
`bitcoind-client` (unchanged).

### Done

- **`packages/nicehash-client`** — full typed client, HMAC signing, unit
  helpers, 30 unit tests. Replaces `packages/braiins-client`.

### In progress / planned

| Upstream file | NiceHash change |
| --- | --- |
| `packages/braiins-client/*` | **Replaced** by `packages/nicehash-client/*`. Braiins package retained until the daemon migration lands, then removed. |
| `daemon/src/services/braiins-service.ts` | → `nicehash-service.ts`: same TTL-cache + last-OK-tracking wrapper, caching `/mining/algorithms` (slow-moving) and `syncTime()` periodically. |
| `daemon/src/controller/types.ts` | `OwnedBidSnapshot` → `OwnedOrderSnapshot` (adds `available_amount_btc`, `payed_amount_btc`, `accepted_speed`); new `REFILL_ORDER` proposal kind; pricing fields move to `btc_per_unit_day`. |
| `daemon/src/controller/observe.ts` | Read `myOrders` + `orderBook` + `account2/BTC`; compute the NiceHash pricing anchor (§4) instead of `cheapestAskForDepth`. |
| `daemon/src/controller/orderbook.ts` | Replace ask-supply walk with buyer-competition marginal-price calc (§4). |
| `daemon/src/controller/decide.ts` | Same shape: keep one order at `anchor + overpay`, clamped to cap. Add the **refill branch** (escrow below N hours of runway → `REFILL_ORDER`). Speed/price edits go through `updatePriceAndLimit`. |
| `daemon/src/controller/execute.ts` | Map proposals to `createOrder` / `updatePriceAndLimit` / `refillOrder` / `cancelOrder`. |
| `daemon/src/controller/gate.ts` | Keep `PRICE_DECREASE_COOLDOWN`; clamp lowering to `priceDownStep`; keep fee-threshold gate. |
| New: `daemon/src/services/pool-manager.ts` | Ensure the configured stratum pool is registered; resolve/cache `poolId`. |
| `daemon/src/config/schema.ts` | New fields: NiceHash `apiKey`/`apiSecret`/`orgId`, `market`, `algorithm`, `refill_amount_btc`, `refill_when_runway_hours`, `min_order_amount_btc`. Prices expressed in BTC/unit/day. (Market + algorithm are configurable, no hardcoded default — per the project requirement; the **target algorithm code is `SHA256ASICBOOST`** (BTC-paid AsicBoost; the NiceHash UI shows it as "SHA256AsicBoost"), and the default example throughout the tooling uses it.) |
| `daemon/src/services/account-spend.ts`, `*-deposit-watcher.ts` | Re-source spend from order `payedAmount` deltas + NiceHash withdrawals instead of the Braiins ledger. |
| `shared/src/units.ts` | Add BTC/unit/day helpers (already mirrored in `nicehash-client/src/units.ts`); keep hashrate conversions. |
| `dashboard/*` | Re-label Braiins → NiceHash, `sat/EH/day` → `BTC/<unit>/day`, "bid" → "order", add an escrow/refill card. Charts, P&L, Bitaxe/Datum/Ocean panels are marketplace-agnostic and carry over. |
| `Dockerfile`, `umbrel-app-store.yml`, `rdouma-hashrate-autopilot/` | Re-brand app id/metadata; `BHA_*` env prefix → project prefix. |

The miner-and-pool-facing subsystems — pool/block tracking, on-chain payout
accounting (`bitcoind-client`, Electrum), Bitaxe (`axeos-*`), Datum/Ocean
pollers, Telegram notifier, retention, i18n, charts — are **not** marketplace
specific and are carried over with wording changes only.

---

## 4. The pricing anchor on a buyer-competition market

Braiins' controller tracks `fillable_ask` = the cheapest price at which the ask
book has enough *unmatched supply* to cover the target, then bids
`fillable_ask + overpay` (pay-your-bid). NiceHash has no ask book; it has:

- a list of competing **buy** orders, each with a `price` and `limit`, and
- `totalSpeed`, the live deliverable speed available to the market.

Sellers point at the highest-priced live orders first. So the price you must pay
to get your `target` speed delivered is approximately the **marginal price**:
walk competitors' orders from highest price down, accumulating their speed
demand; the price at which cumulative *competing* demand begins to exceed
`totalSpeed - target` is the level you must beat to claim your slice. The
controller will then set `price = min(cap, marginal_price + overpay)` — the
direct analogue of the Braiins rule.

This is the one piece whose exact tuning depends on live-market behaviour
(NiceHash does not document the seller allocation precisely). The plan:

1. Implement the marginal-price calculation in `controller/orderbook.ts` with
   the model above, behind the same `overpay` + safety-cap knobs.
2. Validate against the **testnet** (`api-test.nicehash.com`) and a small live
   order, comparing requested vs `acceptedCurrentSpeed`.
3. Expose the computed anchor on the dashboard price chart (as the upstream does
   with `fillable_ask`) so the operator can see and sanity-check it.

Until validated, the safety ceilings (`max_bid` and
`max_overpay_vs_hashprice`, expressed in BTC/unit/day here) bound the downside
exactly as they do upstream.

---

## 5. Credentials & safety

- Create an API key at nicehash.com with **hash-power order** permissions; note
  the **organization ID**. Keys carry per-permission scopes — grant only what
  the bidder needs (read balance/orders, manage hash-power orders, manage pools).
- Secrets are stored the same way the upstream stored Braiins tokens (SQLite
  secrets table or a SOPS-encrypted file); they are never committed.
- Develop and test against **`api-test.nicehash.com`** first — it's a free
  testnet, so the bidding loop can be exercised end-to-end without spending real
  BTC.
- The DRY-RUN / LIVE / PAUSED mutation gate is preserved unchanged: nothing
  hits a real order endpoint until the operator flips to LIVE.

This project is **not affiliated with NiceHash Ltd.** or the upstream author. It
automates real trades with real funds; the operator is responsible for their
keys, spend, and local compliance.

---

## 6. Confirmed live findings (SHA256ASICBOOST testnet)

Verified end-to-end against `api-test.nicehash.com` with a real testnet key
(signing, clock sync, and signed reads all succeeded — see `scripts/smoke-nicehash.ts`).

### Algorithm + currency

- **Algorithm code:** `SHA256ASICBOOST` (all caps; the UI label is
  "SHA256AsicBoost"). Do **not** use `SHA256` (different market) or
  `SHA256ASICBOOST_USDT` (USDT-paid variant).
- **Balance currency:** `TBTC` on testnet, `BTC` on production.

### Units (important)

The order book reports **two different scale factors**:

| Quantity | Factor field | Value | Display unit |
| --- | --- | --- | --- |
| Speed (`limit`, `totalSpeed`, `acceptedSpeed`) | `marketFactor` / `displayMarketFactor` | `1e15` | **PH/s** |
| Price (`price`) | `priceFactor` / `displayPriceFactor` | `1e18` | **BTC / EH / day** |

So for this algorithm **speed is in PH/s but price is in BTC per EH per day**.
The controller stays unit-agnostic by anchoring off the order book's own `price`
values and submitting prices in the same scale; operator caps/overpay are
expressed in those same BTC/EH/day units and surfaced on the dashboard.

### Algorithm constants (from `/mining/algorithms`)

| Field | Value |
| --- | --- |
| `minimalOrderAmount` | `0.001` BTC |
| `minSpeedLimit` | `0.1` PH/s |
| `maxSpeedLimit` | `100000` PH/s |
| `priceDownStep` | `-0.1` |
| `marketFactor` | `1000000000000000` (PH) |
| `displayMarketFactor` | `PH` |

`displayMarketFactor` is a **label string** ("PH"), not a number — it is echoed
verbatim on order mutations alongside `marketFactor`, exactly as the official
demo does.

### Order book shape (the parser was fixed to match this)

```
stats: {
  "BTC": {                       // keyed by paying currency, NOT EU/USA
    totalSpeed, marketFactor, displayMarketFactor,
    priceFactor, displayPriceFactor, updatedTs,
    orders: [
      { id, type: "STANDARD"|"BUSINESS", price, limit,   // limit "0" = uncapped
        acceptedSpeed, payingSpeed, alive, currencyMarket }
    ],
    pagination
  }
}
```

There is **no EU/USA split in the order book** — it is a single currency bucket.
(The `market` config still applies to `myOrders` and order creation.)

`myOrders` returns its rows under the **`list`** field.

### Anchor refinement driven by the live data

The testnet book has an idle uncapped `BUSINESS` order resting at a high price
(`0.10`, `limit 0`, `acceptedSpeed 0`) that delivers nothing. The anchor no
longer treats an uncapped order as swallowing all supply; an uncapped order is
counted by its actual `acceptedSpeed`, so an idle ceiling order does not drag
the anchor up. Capped orders still count their full `limit`.

### Market value is `BTC` (not EU/USA)

Confirmed from a live order: the order's `Market` is **`BTC`** and the order
book is keyed by `BTC`. On this environment the market is the paying currency,
not a geographic region. The `market` config now defaults to `BTC` for
createOrder / myOrders (still overridable via `NICEHASH_MARKET`; a geographic
production deployment can set `EU` / `USA`).

### Price scale — confirmed (1:1, BTC/EH/day)

Corroborated by a live order placed via the NiceHash UI: the buy form labels
price **"Price (TBTC/EH/day)"**, the order book showed the cheapest STANDARD at
`0.0102` in that unit, and an order entered at `0.0010` was stored as `0.0010`
TBTC at `1.0` PH/s / `0.001` TBTC amount. So **submit-price scale ==
order-book-price scale == BTC/EH/day, with no hidden transform** — exactly the
controller's assumption. Speed stays in PH/s, amount in BTC.

Also validated live: pool registration via the API (`ensurePool` created
`pool.xaxamining.com` and NiceHash returned a `poolId` used by the order).

### OPEN — NiceHash API order creation gated (`5096`)

The auto-cancelling API probe could not exercise the create path: NiceHash
returned `403 - 5096: Order creations are currently disabled`, even though
(a) the same account created an order fine via the **UI**, and (b) our API key
successfully created a **pool** and performed all signed reads. Order placement
is a separate granular permission on NiceHash, so the most likely cause is the
testnet API key **missing the "Place hash-power orders" scope** (pool management
is a different scope), or a testnet-side gate on API order-create.

Before enabling LIVE: confirm the key has the order-placement permission and
re-run `pnpm validate:nicehash` (it now also reads back existing orders to
re-confirm the read scale). Until an API create + read-back round-trip passes,
the controller stays in DRY-RUN.

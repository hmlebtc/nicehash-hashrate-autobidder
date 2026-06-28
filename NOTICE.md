# NOTICE

## NiceHash Hashrate Autobidder

This project (`nicehash-hashrate-autobidder`) is a derivative work of
**Hashrate Autopilot** by Remco Douma, adapted to bid on the
[NiceHash Hash-power Marketplace](https://www.nicehash.com/marketplace) instead
of the Braiins Hashpower marketplace.

The original project is distributed under the MIT License and remains the
copyright of its author. The full upstream license is preserved verbatim in
[`LICENSE`](LICENSE).

- **Upstream project:** Hashrate Autopilot
- **Upstream author:** Remco Douma
- **Upstream source:** https://github.com/rdouma/hashrate-autopilot
- **Upstream license:** MIT (see `LICENSE`)

### What this fork changes

The marketplace integration is replaced wholesale. Everything that is specific
to the Braiins Hashpower API — its single-bid `pay-your-bid` model, its
`sat/EH/day` price units, and its REST surface — is swapped for the NiceHash
Hash-power order model (escrowed STANDARD orders with refill, `BTC/<unit>/day`
pricing scaled by `marketFactor`, HMAC-SHA256 request signing, and the
`/main/api/v2/hashpower/*` endpoints).

Components that concern the operator's own miners and pool (pool/block
tracking, on-chain payout accounting, Bitaxe/Datum/Ocean monitoring, Telegram
notifications, charts, and the dashboard shell) are carried over from the
upstream design and re-labelled for NiceHash.

See [`docs/NICEHASH_ADAPTATION.md`](docs/NICEHASH_ADAPTATION.md) for the full
Braiins → NiceHash mapping and the staged adaptation plan.

This project is **not affiliated with NiceHash Ltd.** or with the upstream
author. It automates real trades with real funds; the operator assumes full
responsibility for their API keys, spend, and compliance with local law.

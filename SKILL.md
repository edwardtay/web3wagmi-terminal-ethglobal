---
name: web3wagmi-terminal
type: skill
title: Web3WAGMI Terminal
description: >
  Read live crypto market state: what is abnormal right now, exchange flow with the
  onchain liquidity that would absorb it, and perpetual funding. Use when answering
  questions about crypto market conditions, selling pressure, exchange deposits and
  withdrawals, positioning, or what changed.
resource: https://terminal.web3wagmi.com
tags: [crypto, markets, the-graph, exchange-flow, derivatives, onchain]
---

# Web3WAGMI Terminal

Live crypto market state, as JSON. Every endpoint is public, unauthenticated, and returns
HTTP 200 even when an upstream is down.

Base URL: `https://terminal.web3wagmi.com`

## The one rule

**Every number here comes with its reference, and the reference is the point.** A funding rate
next to its own percentile history. A price move in the asset's own sigma. An exchange deposit
against the onchain volume that would have to absorb it. Reporting the level without the
reference is how this data gets misread: "a billion of USDT moved onto exchanges" is a normal
Tuesday for Binance and means nothing on its own.

## Endpoints

### `GET /api/signals`

What is abnormal right now, ranked. Start here for any open question.

Each signal carries `kind`, `severity` (0-100), `symbol`, `headline`, and `evidence`. The
`evidence` string is the measurement the signal rests on. Quote it.

Six kinds: `funding`, `move`, `oi`, `vol-carry`, `peg`, `flow`.

An empty `signals` array is a real answer. A quiet market is quiet, and saying so is better
than manufacturing a concern.

### `GET /api/netflow`

Exchange flow, from The Graph's indexed balance history, composed with the onchain venue from
a Uniswap v3 subgraph.

**The sign conventions are not intuitive. Three of the four run against "up is good":**

| Flow | Asset | Reading |
| --- | --- | --- |
| Arriving | stablecoin | Buying power reaching venues where it can be spent. Constructive. |
| Leaving | stablecoin | Capital gone to self custody or yield. Not there to bid. |
| Arriving | coin | Sellable supply. The deposit that precedes a sale. Defensive. |
| Leaving | coin | Less supply available to sell at short notice. Constructive. |

Per asset: `flowUsd` by window (`h24`, `d7`), `reservesUsd`, a 30 day `series`, and `dex` with
`liquidityUsd`, `volumeUsd` and `inflowVsVolume`.

`inflowVsVolume` is **only set for coins arriving**, never for stablecoins and never for
outflows, because a stablecoin arriving is not supply that needs absorbing. **Higher means
harder to absorb**: above 1, a day of deposits exceeds everything the deepest onchain pools
trade in a day.

`source` says which reader answered: `graph` for the indexed series, `rpc` for the archive
fallback, which carries an extra `h1` window and no series. `coverage` states the sample. It
is labelled Ethereum wallets across six venues, not total exchange reserves, and saying
otherwise overstates it by a lot.

### `GET /api/derivs`

Perpetual funding, annualised by each contract's actual settlement cadence rather than an
assumed 8 hours. Positive means longs pay shorts.

### `POST /api/ask`

`{"question": "..."}` returns `{ok, answer, used, note}`. `used` lists the tools that ran, so
the answer is auditable rather than trusted. Prefer the raw endpoints if you are doing your own
reasoning; this one is for a natural-language answer.

### `GET /api/ready`

Whether the process is serving. Deliberately dependency-free, so it says nothing about whether
any upstream is up. Each data endpoint reports its own health in its `ok` and `note` fields:
check those before reporting a feed as broken.

## Things that will trip you up

- Exchange reserves move over hours. `/api/netflow` refreshes every four hours because its
  underlying bars are daily, so polling it faster returns the same payload.
- `flowUsd` values are `null`, not `0`, when too little of the sample answered. Null means no
  reading. Zero means flat.
- The flow desk covers Ethereum only. An asset that trades mostly elsewhere is undercovered,
  and the absorption ratio reads Uniswap v3 on Ethereum alone.
- Kraken and OKX are absent because their commonly cited Ethereum labels no longer hold funds.
  Including them would imply coverage that does not exist.

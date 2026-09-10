# web3wagmi-terminal

A crypto market terminal. Live at **[terminal.web3wagmi.com](https://terminal.web3wagmi.com)**.

One screen that answers "what is the market doing right now", at the depth a professional
expects and with the explanation a normal person needs.

Built for ETHOnline 2026 on top of an existing terminal. What existed before the event and
what was built during it is set out in [CONTINUITY.md](CONTINUITY.md).

> **About this repository's commit history.** This is a public mirror, published from a
> private working repository so that deployment config and internal working notes stay out
> of it. Its history is therefore an import: fifteen of its commits share one timestamp,
> because that is when the code was published rather than when it was written. The working
> repository has 146 commits across the event as of 10 September, and it can be shown to
> judges on request.
> Nothing in this repository's `git log` should be read as evidence of when the work
> happened, and CONTINUITY.md says the same thing at more length.

## The Graph, and what it is load-bearing for

The terminal already read prices, funding, open interest and options from exchange APIs.
Its weakest desk was on-chain, and that is the desk The Graph now runs.

**One query, nine protocols.** The clearest thing a standard buys. A Messari standardized
subgraph gives lending markets, DEXes, liquid staking and CDPs the same entities, so the
literal query in `lib/standards.ts` is sent unchanged to nine subgraphs, which the schema files
under three categories, and every one answers. Adding a tenth is one line, an id. Sent to Uniswap v3's own subgraph the
same query is rejected with ``Type `Query` has no field `protocols` ``, and the panel shows that
rejection, because the cost of a bespoke schema is better stated by the gateway than by us.

**Two Graph products and four datasets, composed.** Neither product answers the question alone.

| Product | What it answers |
| --- | --- |
| **Token API** (`lib/graph.ts`) | Balances arriving on exchange wallets. The intent to sell. |
| **Uniswap v3 subgraph** via the decentralised gateway (`lib/subgraph.ts`) | The liquidity and daily volume that would have to absorb a sale. |
| **Token API**, holders and supply | Whether an asset is held by a market or by a committee. WBTC reads 53% in the top ten and 1.5% in wallets that can act alone, which are two different findings. |
| **Token API**, Hyperliquid liquidations and open interest | The leveraged side of the same question. Flow is supply arriving to be sold; a forced close is supply that will be sold whatever the holder wants. Open interest arrives in contracts, which is the unit the regime logic needs, so the onchain venue can be compared with the centralised one without converting. |

Alone, each is a number without a reference. "A billion of USDT moved" is a normal Tuesday for
Binance. Composed, they say whether what arrived is large against the venue that would have to
take it:

```
asset   24h flow    onchain liquidity   onchain daily volume   deposits vs volume
WBTC    +$0.5m      $579.5m             $9.5m                  0.06x
```

Two orders of magnitude separate one asset from another on that last column, and that column
cannot be built from either product on its own.

**It drives the first thing on the page.** The dislocation queue ranks what just became
abnormal, and it is the reason to leave a terminal open. Exchange flow is now one of its six
signal kinds, firing when a day's balance change exceeds two standard deviations of that same
balance's own prior 30 daily changes. It is not a panel bolted on the end.

**It answers questions.** `lib/ask.ts` exposes the desks as tools to a model, so
"can the market absorb the USDT that just moved onto exchanges" is answerable in one sentence
with the measurement attached. The model knows nothing about crypto: every number it states
came back from a tool, and the tools return each measurement with its reference. Agent-facing
notes are in [SKILL.md](SKILL.md).

## Two ideas the whole thing rests on

**Abnormality over levels.** A number is only interesting next to its own reference. A
percentile against its own history, a move in sigma, an implied against a realised, a deposit
against the volume that would absorb it. The signal engine never fires against a round number.

**Degrade, never fail.** Every API route returns HTTP 200 with `ok:false` and empty
collections when its upstream is down, and every panel renders its loading, failed and empty
states. A blank card is a defect. The flow desk falls back to archive JSON-RPC when no Graph
key is configured, so the terminal works for anyone who clones this repo. `/status` reports
which upstreams are answering.

## The rest of the terminal

Around thirty panels over free public market data:

| Desk | Covers |
| --- | --- |
| **What changed** | The ranked dislocation queue, each row carrying the measurement it rests on. |
| **Glance** | Ticker tape, headline snapshot, market cap and dominance, Fear and Greed, candle chart with a per-symbol drill-in. |
| **Live tape** | Full-universe price board over one coalesced WebSocket, order book with depth shading, trade tape, liquidation feed. |
| **Derivatives** | Funding ranked and annualised with the CEX vs DEX spread, open interest with a regime label, retail against top-trader positioning, an options desk. |
| **On-chain** | Exchange flow and onchain absorption, DEX pool discovery, chain and protocol TVL, fees against revenue, stablecoin supply and peg, yield scanner, multi-chain gas, Bitcoin network health, token unlocks. |

## Stack

Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, standalone output. No
database and no auth. Every panel is a client component polling one `/api` route.

```
app/api/<feed>/route.ts   server-side upstream calls, filtering, derived maths
components/<Panel>.tsx    the client panel that renders one feed
lib/                      shared primitives (formatters, stats, symbols, hooks)
lib/graph.ts              The Graph Token API client, the key, the cost model
lib/subgraph.ts           subgraphs through the decentralised gateway
lib/flow.ts               the exchange flow reader built on both
lib/ask.ts                the tools and the loop behind /api/ask
```

All upstream calls are server-side. The CSP in `next.config.ts` allows the browser to reach
`'self'` and the Binance WebSocket only, which is what keeps every key off the client.

## Cost, because it is a design constraint

The Token API meters money, not calls: $25 of credit a month, priced per endpoint category. A
time series read costs $200 per million against $15 for a balance read, a 13x spread, so the
category a route picks matters more than shaving a call out of a refresh.

The flow desk reads 168 time series per refresh. The bars are daily, so refreshing faster than
the data changes buys nothing, and at four hours it costs **$6.05 a month**. The same read
hourly would be $24.19 and the same read every fifteen minutes would be $96.77, past the plan's
hard cutoff. `BUDGET.monthlyUsd()` computes this, and every route that reads The Graph states
its own cost in a comment rather than trusting one.

`/api/netflow` and `/api/signals` share one revalidate window on purpose: both read through
`getJson`, so identical URLs on identical windows are served from one set of requests by Next's
fetch cache. Two routes, one bill.

## Data sources

The Graph (Token API and subgraphs), Binance spot and futures, Hyperliquid, Deribit, DefiLlama,
CoinGecko, alternative.me, mempool.space, GeckoTerminal, and public EVM JSON-RPC nodes.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # standalone production build
npx tsc --noEmit     # types only
```

Everything runs without keys, on the fallback paths. To run the Graph desks:

```bash
# .env.local
GRAPH_TOKEN_API_KEY=...   # from thegraph.market, NOT Subgraph Studio
GRAPH_SUBGRAPH_KEY=...    # from Subgraph Studio, for the gateway
GROQ_API_KEY=...          # any OpenAI-compatible provider, see lib/ask.ts
```

The two Graph credentials are different products and each answers 401 to the other's.

Every upstream quirk that cost real time to rediscover is written down next to the code that
works around it. Before changing anything in `lib/`, read the comments in the file you are
changing: they are the reason the shared primitives look the way they do.

## Licence

MIT. See [LICENSE](LICENSE).

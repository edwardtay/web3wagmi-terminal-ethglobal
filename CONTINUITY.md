# What existed before ETHOnline 2026, and what was built during it

Submitted to the continuity pool, where only work done during the event is judged. This
document draws that line. Every claim here is checkable against `git log`.

## Before the event

The terminal was started on **2026-07-29** and deployed at `terminal.web3wagmi.com`. Five
commits, ending **2026-08-25**, ten days before the hackathon opened:

```
2026-07-29  b1d62bc  Initial commit: Web3WAGMI Terminal
2026-08-05  fa9207d  Feedback drawer on every page
2026-08-22  af2b06f  Bing Webmaster verification file
2026-08-25  500d5bc  Make the cross-site bar News, Blog, Atlas, Events, Tools
2026-08-25  a2b5aef  Add the missing og:image
```

What that gave: around thirty panels over Binance, Hyperliquid, Deribit, DefiLlama, CoinGecko,
mempool.space and GeckoTerminal. A dislocation queue with five signal kinds. The shared
primitives in `lib/` (`stats.ts`, `format.ts`, `symbols.ts`, `http.ts`) and the design system
in `globals.css` and `ui.tsx`. A written product rationale and code contract, both predating
the event, kept in the private working repository this one mirrors.

**There was no Graph code of any kind, and no AI of any kind.** No `lib/graph.ts`,
`lib/subgraph.ts`, `lib/flow.ts` or `lib/ask.ts`. `package.json` had no model SDK. The
on-chain desk read exchange balances over free archive JSON-RPC, and that was the weakest
thing in the build.

## During the event

All Graph and AI work is dated **2026-09-06 and 2026-09-07**, inside the window. 1,757 lines
across 13 files.

### The Graph, as load-bearing infrastructure

- **`lib/graph.ts`**, the Token API client: balance history, transfers, holders, typed from the
  live `GET /openapi` rather than the docs, with the plan's cost model and row cap encoded.
- **`lib/subgraph.ts`**, subgraphs through the decentralised gateway, pinned to a deployment id
  so a repointed name cannot silently change what a number means.
- **`lib/flow.ts`**, the exchange flow reader: 30 days of daily balance series per wallet and
  token, paged, forward filled, measured against one anchor shared by the whole read.
- **`/api/netflow` rewritten** to prefer the indexed read and fall back to the old JSON-RPC
  path, so the terminal still works with no key. The payload says which source answered.
- **The two products composed**: exchange deposits against the onchain liquidity and daily
  volume that would have to absorb them. This is the number neither product produces alone.
- **A sixth signal kind** in `/api/signals`, firing when a day's flow exceeds two standard
  deviations of the same balance's own prior 30 daily changes.
- **`lib/concentration.ts`**, holders against circulating supply, with contracts separated from
  ordinary wallets so infrastructure is not counted as a concentrated holder.
- **`/thegraph`**, a page in the terminal's own chrome that reads the live desks and sets the
  archive path against the indexed one.

### AI

- **`lib/ask.ts` and `/api/ask`**: the desks exposed as tools to a model, two tool rounds, then
  the answer written with the tools withdrawn. Provider is OpenAI-compatible and set by
  environment.
- The model is given no crypto knowledge and no latitude on interpretation. Each asset carries
  an `interpretation` sentence decided in code and money is pre-formatted, because testing showed
  the model inverting sign conventions and rendering integers as `168 139 396 USD`.

### Correctness work the integration forced

- A **measurement bug** found by cross-checking the panel's totals against the curve drawn from
  the same data. Each wallet was measuring its window against its own newest bar, so a wallet
  with no recent activity contributed the change across whatever gap its last two bars spanned,
  labelled 24h. USDT's 24h flow read -$478.7m before the fix and +$165.7m after. A sign error
  on the headline number.
- A **chart bug**: `fitContent()` ran once and never again, so a chart first fitted in a narrow
  container kept that bar spacing on a wide screen.
- **Four different container widths** across the app, which left the header logo inset from the
  nav beneath it. One shell class now.

### Documentation and open-sourcing

- MIT licence, this file, `SKILL.md`, and a README rewritten around The Graph. The repo carried
  no licence and no README at all before the event.
- The deploy runbook moved out of tracked files and its infrastructure hostname scrubbed from
  history before the repo was made public.

## The same desk, with and without

Both implementations ship. The archive JSON-RPC path still runs when no Graph key is
set, so this is two live versions of one desk rather than a recollection of an older
one, and `/api/netflow` names which answered in its `source` field.

| The exchange flow desk | Archive JSON-RPC | The Graph |
| --- | --- | --- |
| Reads per refresh | 240 archive calls | 176 indexed reads |
| What a read returns | one balance at one block | a thirty day daily series |
| Windows | 1h, 24h, 7d | 24h, 7d |
| How a window is dated | block height, assuming 12s blocks | the timestamp on the bar |
| History on the panel | none, three numbers | thirty days, charted |
| Holder concentration | not possible | top ten share, contracts split from wallets |
| Onchain absorption | not possible | deposits against DEX daily volume |
| Signal kinds in the queue | 5 | 6 |
| Answerable by the question box | nothing on-chain | flow, absorption, ownership |
| Upstream | free archive nodes that rate limit | an index |
| Cost | free | $6.07 a month of a $25 credit |

The call count is the least of it, and fewer reads was never the win. What changed is
that a window is measured against a real timestamp rather than an assumed block time,
that three point readings became a series, and that two questions the desk could not
ask at all, who holds this and where would a sale land, are now rows on the panel.

The 1h window was dropped deliberately. On the archive path it cost 300 blocks of extra
reads for the noisiest column, and an hour of exchange reserve movement is mostly
deposit batching.

## What is honestly not done

- **One chain, and this was investigated rather than assumed.** The Token API indexes nine EVM
  networks plus Solana. Exchange EOAs reuse the same address across EVM chains, so the fourteen
  verified Ethereum labels can be checked directly elsewhere, and they were.

  On **Base** those addresses hold airdrop dust: single units of TrumpCoin and MAGA sent to
  well-known wallets. Nothing to measure.

  On **Arbitrum** only **4 of 14** hold a material balance, and they are Bitfinex, Bybit, Gate.io
  and one Binance wallet holding ARB alone. Binance's actual reserves are absent, which is the
  venue that dominates the Ethereum desk.

  So an Arbitrum desk would carry the label "exchange flow" while measuring three mid-sized venues
  and missing the largest. That is worse than one chain: it looks like coverage and is not. It
  would also need per-chain token contracts, since Arbitrum's USDT is `USD₮0` rather than the
  mainnet contract.

  The honest version of multichain needs a labelled address set per chain, which is Nansen and
  Arkham's business rather than something to derive in a hackathon week.
- **`transfers()` is written and unused.** Gross inflow and outflow split per venue is the
  obvious next read, and it is expensive: `from_address` and `to_address` take one address each,
  so it costs two calls per wallet per network.
- **The absorption ratio uses Uniswap v3 on Ethereum only**, so it understates the venue for any
  asset that trades meaningfully elsewhere.

import type { Metadata } from "next";
import { PageChrome } from "@/components/PageChrome";

export const metadata: Metadata = {
  title: "Methodology | Web3WAGMI Terminal",
  description:
    "Where every number on the terminal comes from, how each derived metric is computed, and what the limits are.",
  alternates: { canonical: "https://terminal.web3wagmi.com/methodology" },
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 font-display text-base font-bold tracking-tight text-[var(--text)]">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-[var(--text2)]">{children}</div>
    </section>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <p>
      <span className="font-mono text-[12px] font-bold text-[var(--text)]">{term}</span>{" "}
      <span className="break-words">{children}</span>
    </p>
  );
}

export default function MethodologyPage() {
  return (
    <PageChrome
      title="Methodology"
      crumb="methodology"
      intro={
        <>
          Nothing here is hand-entered, and nothing is modelled beyond what is described on this
          page. Where a metric is our own construction, the recipe is written out so you can
          disagree with it. Every source is public; one of them, The Graph, needs a key.
        </>
      }
    >

      <div className="mt-8">
        <Block title="Sources">
          <Row term="Binance">
            Spot and USDT-margined futures public REST and WebSocket. Prices, candles, order book,
            trades, funding, open interest, account positioning and the all-market liquidation
            stream.
          </Row>
          <Row term="Hyperliquid">
            The public <span className="font-mono">info</span> endpoint, for on-chain perpetual
            funding. Used against Binance funding to show where the two venues disagree.
          </Row>
          <Row term="Deribit">
            Public v2 API. Option book summaries, the DVOL implied volatility index, and index
            prices. Deribit is where most crypto options volume clears, so it is a reasonable proxy
            for the market.
          </Row>
          <Row term="DefiLlama">
            Chain and protocol TVL, DEX volume, protocol fees and revenue, yield pools, token
            emissions, and the stablecoin dataset.
          </Row>
          <Row term="GeckoTerminal">
            Trending and newly created DEX pools across every network it indexes, with pool level
            price, volume, liquidity and trade counts.
          </Row>
          <Row term="Archive JSON-RPC nodes">
            Historical <span className="font-mono">eth_call</span> and{" "}
            <span className="font-mono">eth_getBalance</span> reads for the exchange netflow panel.
          </Row>
          <Row term="CoinGecko">Total market capitalisation, volume, and Bitcoin and Ethereum dominance.</Row>
          <Row term="alternative.me">The Fear and Greed index, taken as published.</Row>
          <Row term="mempool.space">Bitcoin fee tiers, mempool backlog, hashrate and block height.</Row>
          <Row term="Public JSON-RPC nodes">
            Base fee and priority fee percentiles via <span className="font-mono">eth_feeHistory</span> on
            Ethereum, Base, Arbitrum, Optimism and BNB Chain.
          </Row>
        </Block>

        <Block title="Derived metrics">
          <Row term="Annualised funding">
            The current funding rate scaled by the settlement cadence: a rate that settles every
            eight hours annualises as rate x 3 x 365. Hyperliquid settles hourly, so its rate
            annualises as rate x 24 x 365. Compare the annualised figures, never the raw ones.
          </Row>
          <Row term="Exchange netflow">
            The balance of publicly labelled exchange wallets on Ethereum now, against the same
            wallets at the block that started the window. Positive means coins arrived. Cold wallets
            are included on purpose, so a hot to cold shuffle nets out instead of reading as an
            outflow. Coverage is USDT, USDC, native ETH and WBTC in wallets that hold a real balance;
            Kraken and OKX are absent because their commonly cited Ethereum labels are drained today.
            Deposits to an unlabelled wallet, and every other chain, are invisible, so read the
            direction rather than the absolute size.
          </Row>
          <Row term="Pool turnover and FDV to liquidity">
            Turnover is 24 hour pool volume divided by pool liquidity. FDV to liquidity is fully
            diluted value divided by pool liquidity. Both are arithmetic on the pool row and neither
            says anything about the contract.
          </Row>
          <Row term="Open interest regime">
            Read from the sign pair of the 24h price change and the 24h open interest change. Price
            up with OI up is new longs, price down with OI up is new shorts, price up with OI down
            is short covering, price down with OI down is long liquidation.
          </Row>
          <Row term="Realised volatility">
            Standard deviation of daily log returns, annualised by the square root of 365. Crypto
            trades every day, so the 252 trading-day convention from equities does not apply.
          </Row>
          <Row term="Sharpe and Sortino">
            Annualised mean return divided by annualised volatility, risk-free rate set to zero.
            Sortino uses downside deviation only. Both are computed over daily returns.
          </Row>
          <Row term="Correlation">
            Pearson correlation of daily log returns over the selected window, computed pairwise on
            the overlapping history.
          </Row>
          <Row term="Skew">
            An approximation. The public book summary carries no greeks, so the panel uses the
            call implied volatility minus put implied volatility at the strikes roughly 0.674
            standard deviations either side of the forward, so negative means puts trade above
            calls. It tracks the shape of real 25-delta risk reversal without being identical to it.
          </Row>
          <Row term="Max pain">
            The strike that minimises the total in-the-money value across all open interest at an
            expiry. It describes where the largest notional expires worthless, and it is not a
            forecast.
          </Row>
          <Row term="Alt-season index">
            Our own 0 to 100 reading over the top 100 USDT spot pairs: 45 percent the share beating
            Bitcoin over 30 days, 25 percent the share beating Bitcoin over 7 days, 20 percent the
            share above its 200 day moving average, 10 percent the share up over 7 days. Above 75
            reads as alt season, below 25 as a Bitcoin-only tape.
          </Row>
          <Row term="Crypto Stress Index">
            Our own composite. Six inputs, each percentile-ranked against its own trailing history
            rather than an arbitrary scale: realised volatility, Deribit DVOL, absolute median
            funding, supply-weighted stablecoin peg deviation, average pairwise correlation, and
            Bitcoin drawdown from its one year high. Weights and every component score are shown in
            the panel, and any component whose upstream is down is dropped with the rest re-weighted
            and marked.
          </Row>
        </Block>

        <Block title="Limits worth knowing">
          <p>
            TVL is denominated in dollars, so a chain&apos;s TVL can move purely because its native
            token moved. Read a TVL change alongside the token&apos;s price change.
          </p>
          <p>
            Liquidation totals cover only the current browser session and only Binance USDT-margined
            futures. They are a live feed, not a historical record, and they understate the whole
            market.
          </p>
          <p>
            Yield figures are as published by each protocol through DefiLlama. A yield that is
            mostly token emissions is flagged, because it depends on the price of the reward token
            rather than on protocol earnings.
          </p>
          <p>
            Price alerts run in your browser while the tab is open. Nothing is stored on a server
            and nothing fires once the tab is closed.
          </p>
          <p>
            Everything here is market information. None of it is advice, and no panel accounts for
            your position, your costs or your tax.
          </p>
        </Block>
      </div>

      <p className="mt-6 text-xs text-[var(--text3)]">
        <a href="/" className="hover:text-[var(--text)]">
          Back to the terminal
        </a>
        {" · "}
        <a href="/status" className="hover:text-[var(--text)]">
          Data status
        </a>
      </p>
    </PageChrome>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Section, Panel } from "@/components/ui";
import { PageChrome } from "@/components/PageChrome";
import { GraphCase } from "@/components/GraphCase";

// The entry point for someone who wants to see what The Graph runs here.
//
// It wears the terminal's own chrome, and that is the argument rather than a
// styling choice. A page in a different visual language reads as a microsite
// about the product, and the claim being made is that these desks are part of
// the product. Same header, same tape, same panels, and every number read live
// from the routes the panels use, so the page cannot drift from what it
// describes.

export const metadata: Metadata = {
  title: "The Graph on this terminal | Web3WAGMI Terminal",
  description:
    "Two Graph products composed into one number: exchange deposits against the onchain liquidity that would have to absorb them. Live, with the cost model and the limits stated.",
  alternates: { canonical: "https://terminal.web3wagmi.com/thegraph" },
};

/** A compact note. Prose in the terminal lives in a panel like everything else. */
function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel title={title}>
      <div className="space-y-2 text-[12px] leading-relaxed text-[var(--text2)]">{children}</div>
    </Panel>
  );
}

export default function TheGraphPage() {
  return (
    <PageChrome
      title="The Graph"
      crumb="thegraph"
      wide
      intro={
        <>
          The terminal reads prices, funding, open interest and options from exchange APIs. Its
          weakest desk was on-chain, and that is the desk The Graph now runs. Every number below is
          read live from the same routes the panels use, and every claim links to the panel where it
          operates.
        </>
      }
    >
        <Section title="The desks it runs" id="graph">
          <GraphCase />
        </Section>

        <div className="mt-4">
          <Section title="How it works" id="how">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Note title="Two products, because one is not enough">
                <p>
                  The <strong className="text-[var(--text)]">Token API</strong> gives indexed balance
                  history, holders and circulating supply. It says what arrived on an exchange
                  wallet, which is the intent to sell.
                </p>
                <p>
                  A <strong className="text-[var(--text)]">Uniswap v3 subgraph</strong> through the
                  decentralised gateway gives the liquidity and daily volume that would have to
                  absorb a sale.
                </p>
                <p>
                  Dividing one by the other turns a level into a reading. Deposits worth a fraction
                  of a trading day are noise. Deposits worth several days are something the venue
                  has to work to take.
                </p>
              </Note>

              <Note title="Load-bearing, not decorative">
                <p>
                  The first panel on the terminal is the{" "}
                  <Link href="/#signals" className="underline hover:text-[var(--text)]">
                    dislocation queue
                  </Link>
                  , which ranks what just became abnormal. Exchange flow is one of its six signal
                  kinds.
                </p>
                <p>
                  It fires when a day&apos;s balance change exceeds two standard deviations of that
                  same balance&apos;s own prior thirty daily changes. Thirty days is why the reader
                  pages three deep into the API: nine daily changes is not a distribution.
                </p>
              </Note>

              <Note title="The model writes its own queries">
                <p>
                  Three tools read this terminal's own desks. A fourth hands the
                  model the subgraph schema and lets it write GraphQL, so a question the
                  desks do not cover reaches The Graph directly.
                </p>
                <p>
                  Asked which Uniswap pool is deepest for WBTC, it wrote a query, got a field name
                  wrong, read the error, fixed it and answered: the WBTC/WETH pool at
                  0xcbcdf962, $206m locked.
                </p>
                <p>
                  Errors come back as text rather than null for exactly that reason. A model told
                  which field it got wrong can fix it; one handed a null cannot.
                </p>
              </Note>

              <Note title="The model does not interpret">
                <p>
                  Asked whether the market could absorb the USDT arriving on exchanges, it answered
                  yes, comfortably, from a ratio of 7.6x that means the opposite.
                </p>
                <p>
                  A coin arriving is bearish, a stablecoin arriving is bullish, a coin leaving is
                  constructive. Three of those four run against the intuition that up is good.
                </p>
                <p>
                  The fix was not a better prompt. Each asset carries its interpretation decided in
                  code. The model composes the sentence and never the conclusion.
                </p>
              </Note>
            </div>
          </Section>
        </div>

        <div className="mt-4">
          <Section
            title="The same desk, with and without"
            id="before"
            hint="The archive JSON-RPC path is still in the codebase and still runs when no Graph key is set, so this is two live implementations of one desk rather than a recollection of an older version."
          >
            <Panel>
              <div className="overflow-x-auto">
                <table className="tbl w-full">
                  <thead>
                    <tr>
                      <th className="ident">The exchange flow desk</th>
                      <th className="ident">Archive JSON-RPC</th>
                      <th className="ident">The Graph</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["Reads per refresh", "240 archive calls", "176 indexed reads"],
                      ["What a read returns", "one balance at one block", "a thirty day daily series"],
                      ["Windows", "1h, 24h, 7d", "24h, 7d"],
                      [
                        "How a window is dated",
                        "block height, assuming 12s blocks",
                        "the timestamp on the bar",
                      ],
                      ["History on the panel", "none, three numbers", "thirty days, charted"],
                      ["Tokens", "4, hardcoded", "4, plus supply and holders"],
                      ["Holder concentration", "not possible", "top ten share, contracts split from wallets"],
                      ["Onchain absorption", "not possible", "deposits against DEX daily volume"],
                      ["Signal kinds in the queue", "5", "6"],
                      ["Answerable by the question box", "nothing on-chain", "flow, absorption, ownership"],
                      ["Upstream", "free archive nodes that rate limit", "an index"],
                      ["Cost", "free", "$6.07 a month of a $25 credit"],
                    ].map(([row, before, after]) => (
                      <tr key={row}>
                        <td className="font-semibold text-[var(--text)]">{row}</td>
                        <td className="text-[var(--text3)]">{before}</td>
                        <td className="text-[var(--text2)]">{after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--text2)]">
                The call count is the least of it. Fewer reads was never the win, and the indexed
                path is not dramatically cheaper in requests. What changed is that a window is now
                measured against a real timestamp instead of an assumed block time, that three
                readings became a series, and that two questions the desk could not ask at all,
                who holds this and where would a sale land, are now rows on the panel.
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text2)]">
                Both paths ship. Clone the repo with no key and the archive path answers, and the
                payload names which one did.
              </p>
            </Panel>
          </Section>
        </div>

        <div className="mt-4">
          <Section title="What this is not" id="limits">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Note title="One chain of nine, checked">
                <p>
                  Exchange wallets reuse the same address across EVM chains, so the fourteen
                  verified Ethereum labels were checked directly elsewhere.
                </p>
                <p>
                  On Base they hold airdrop dust. On Arbitrum only four of fourteen hold anything
                  material, and Binance, the venue that dominates the Ethereum desk, is not among
                  them.
                </p>
                <p>
                  An Arbitrum desk would therefore carry the label &quot;exchange flow&quot; while
                  measuring three mid-sized venues and missing the largest. That is worse than one
                  chain, because it looks like coverage.
                </p>
              </Note>
              <Note title="A sample, not coverage">
                <p>
                  Fourteen publicly labelled exchange wallets across six venues. Kraken and OKX are
                  excluded because their commonly cited Ethereum addresses no longer hold funds, and
                  including them would imply coverage that does not exist.
                </p>
              </Note>
              <Note title="One venue for absorption">
                <p>
                  Uniswap v3 on Ethereum, so any asset that trades meaningfully elsewhere has its
                  venue understated. The ratio is a floor on how absorbable a deposit is, not a
                  ceiling.
                </p>
              </Note>
            </div>
          </Section>
        </div>

        <div className="mt-4">
          <Section title="The code" id="code">
            <Panel>
              <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 font-mono text-[11px] sm:grid-cols-2">
                {[
                  ["lib/graph.ts", "Token API client, the key, the cost model"],
                  ["lib/subgraph.ts", "subgraphs through the decentralised gateway"],
                  ["lib/flow.ts", "the paged thirty day balance reader"],
                  ["lib/concentration.ts", "holders against circulating supply"],
                  ["lib/ask.ts", "the tools and the loop behind the question box"],
                  ["SKILL.md", "agent-facing notes and the sign conventions"],
                  ["CONTINUITY.md", "what existed before this event, and what did not"],
                  ["app/api/netflow", "the desk, with an archive RPC fallback"],
                ].map(([file, what]) => (
                  <div
                    key={file}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--border2)] py-1"
                  >
                    <span className="font-semibold text-[var(--text)]">{file}</span>
                    <span className="min-w-0 break-words text-right text-[var(--text3)]">{what}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--text2)]">
                MIT, and it runs with no Graph key at all: the flow desk falls back to archive
                JSON-RPC and the payload says which source answered.{" "}
                <a
                  href="https://github.com/edwardtay/web3wagmi-terminal"
                  className="underline hover:text-[var(--text)]"
                  rel="noreferrer"
                >
                  github.com/edwardtay/web3wagmi-terminal
                </a>
              </p>
            </Panel>
          </Section>
        </div>
    </PageChrome>
  );
}

import { CommandPalette } from "@/components/CommandPalette";
import { TerminalHeader } from "@/components/TerminalHeader";
import { SideNav } from "@/components/SideNav";
import { SymbolProvider } from "@/components/SymbolProvider";
import { Section } from "@/components/ui";
import { Defer } from "@/components/Defer";
import { FocusSection } from "@/components/FocusSection";
import { normaliseSymbol } from "@/lib/symbolParam";
import { SignalTape } from "@/components/SignalTape";
import { MorningBrief } from "@/components/MorningBrief";

import { Snapshot, Tape } from "@/components/Snapshot";
import { FocusChart } from "@/components/FocusChart";
import { StressIndex } from "@/components/StressIndex";
import { LiveBoard } from "@/components/LiveBoard";
import { FundingBoard } from "@/components/FundingBoard";
import { OpenInterest } from "@/components/OpenInterest";
import { Liquidations } from "@/components/Liquidations";
import { OptionsDesk } from "@/components/OptionsDesk";
import { Microstructure } from "@/components/Microstructure";
import { ExchangeNetflow } from "@/components/ExchangeNetflow";
import { DexPools } from "@/components/DexPools";
import { ChainBoard } from "@/components/ChainBoard";
import { ProtocolMovers } from "@/components/ProtocolMovers";
import { Earners } from "@/components/Earners";
import { Stablecoins } from "@/components/Stablecoins";
import { YieldScanner } from "@/components/YieldScanner";
import { GasTracker } from "@/components/GasTracker";
import { BtcNetwork } from "@/components/BtcNetwork";
import { Unlocks } from "@/components/Unlocks";
import { ReturnsMatrix } from "@/components/ReturnsMatrix";
import { RiskMatrix } from "@/components/RiskMatrix";
import { Correlation } from "@/components/Correlation";
import { Breadth } from "@/components/Breadth";
import { Rotation } from "@/components/Rotation";
import { Screener } from "@/components/Screener";

// The reading order is deliberate: what the market is doing, how stressed it
// is, what the derivatives are pricing, where the capital sits on chain, then
// the analytics you drill into once something looks off.

// Panels that already wrap themselves in a Section (Snapshot, Liquidations,
// OptionsDesk, ChainBoard, Stablecoins, Microstructure) are placed bare. The
// rest return a Panel and get wrapped here, which is also where the anchor ids
// the command palette jumps to are set.

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ?s=SOL selects an instrument. Resolved here so a shared link is correct on
  // the first paint; an unknown symbol falls back to BTC rather than erroring.
  const raw = (await searchParams).s;
  const focus = normaliseSymbol(Array.isArray(raw) ? raw[0] : raw) ?? "BTC";

  return (
    <SymbolProvider initial={focus}>
      <div className="min-h-screen">
      <CommandPalette />
      <TerminalHeader />
      <Tape />

      <div className="shell flex gap-6 py-6">
        <SideNav />

        <main className="min-w-0 flex-1">
        <h1 className="sr-only">
          Web3WAGMI Terminal: live crypto prices, derivatives, on-chain data and risk analytics
        </h1>

        {/* ---- What needs attention, before any levels ---- */}
        {/* The note first, then the evidence it was written from. */}
        <MorningBrief />

        <SignalTape />

        {/* ---- Glance ---- */}
        <Snapshot />

        {/* Market stress, beside the snapshot rather than below the focus.
            It is a composite over the whole universe, so it belongs with the
            other market-wide readings: sitting after one instrument's chart
            made a market-wide score look like a comment on that instrument. */}
        <Section
          title="Market stress"
          id="stress"
        >
          <StressIndex />
        </Section>

        {/* ---- Live tape ----
            Before the focused instrument, not after it. The page reads broad to
            specific: what the whole market is doing, then the one thing you
            selected out of it. Reversed, the board arrived as an afterthought
            to a chart the reader had already finished with. */}
        <Section
          title="Live board"
          id="live"
        >
          <LiveBoard />
        </Section>

        {/* ---- The focused instrument ----
            Everything that follows the focus control, contiguous and under a
            heading that names the asset. These three panels used to sit at
            three different depths of the page with market-wide panels between
            them, so changing the focus looked like it did almost nothing: the
            parts that responded were never visible at once. */}
        <div id="focus-group" className="focus-zone scroll-mt-[186px] xl:scroll-mt-[145px]">
          <FocusSection>
            <FocusChart />
          </FocusSection>

          <Microstructure />

          <OptionsDesk />
        </div>

        {/* ---- Derivatives ---- */}
        <div id="derivatives" className="scroll-mt-[186px] xl:scroll-mt-[145px]">
          <Section
            title="Funding"
            id="funding"
          >
            <FundingBoard />
          </Section>

          <Section
            title="Open interest"
            id="oi"
          >
            <OpenInterest />
          </Section>

          <Liquidations />
        </div>

        {/* ---- On-chain ---- */}
        <div id="onchain" className="scroll-mt-[186px] xl:scroll-mt-[145px]">
          <ExchangeNetflow />

          {/* Who earns, straight after the flow desk.
              These are the two questions about substance rather than price: what
              is moving on chain, and whether anyone is actually paying to use
              any of it. It sat ten panels lower among the venue plumbing, which
              is where a reader goes to look something up rather than to be told
              something. */}
          <Earners />

          <DexPools />

          <ChainBoard />

          <Section
            title="Protocols"
            id="protocols"
          >
            <Defer minHeight={320}><ProtocolMovers /></Defer>
          </Section>

          <Stablecoins />

          <Section
            title="Yields"
            id="yields"
          >
            <Defer minHeight={420}><YieldScanner /></Defer>
          </Section>

          <Section
            title="Gas and network"
            id="gas"
          >
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Defer minHeight={240}><GasTracker /></Defer>
              <Defer minHeight={240}><BtcNetwork /></Defer>
            </div>
          </Section>

          <Section
            title="Token unlocks"
            id="unlocks"
          >
            <Defer minHeight={360}><Unlocks /></Defer>
          </Section>
        </div>

        {/* ---- Analytics ---- */}
        <div id="analytics" className="scroll-mt-[186px] xl:scroll-mt-[145px]">
          <Section
            title="Returns"
            id="returns"
          >
            <Defer minHeight={300}><ReturnsMatrix /></Defer>
          </Section>

          <Section
            title="Risk"
            id="risk"
          >
            <Defer minHeight={300}><RiskMatrix /></Defer>
          </Section>

          <Section
            title="Correlation"
            id="correlation"
          >
            <Defer minHeight={300}><Correlation /></Defer>
          </Section>

          <Section
            title="Breadth"
            id="breadth"
          >
            <Defer minHeight={260}><Breadth /></Defer>
          </Section>

          <Section
            title="Rotation"
            id="rotation"
          >
            <Defer minHeight={260}><Rotation /></Defer>
          </Section>

          <Section
            title="Screener"
            id="screener"
          >
            <Defer minHeight={360}><Screener /></Defer>
          </Section>
        </div>
        </main>
      </div>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="shell flex flex-wrap items-center justify-between gap-4 text-xs text-[var(--text3)]">
          <span className="font-display font-semibold text-[var(--text2)]">
            web3wagmi <span className="accent-grad">Terminal</span>
          </span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href="/methodology" className="hover:text-[var(--text)]">
              Methodology
            </a>
            <a href="/status" className="hover:text-[var(--text)]">
              Data status
            </a>
            <a href="https://data.web3wagmi.com" className="hover:text-[var(--text)]">
              Data finder
            </a>
            <a href="https://news.web3wagmi.com" className="hover:text-[var(--text)]">
              News
            </a>
          </div>
          <span className="w-full text-[11px] leading-relaxed text-[var(--text3)] sm:w-auto">
            Market information only. Not advice.
          </span>
        </div>
      </footer>
      </div>
    </SymbolProvider>
  );
}

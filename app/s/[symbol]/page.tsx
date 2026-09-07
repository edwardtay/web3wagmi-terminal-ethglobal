import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CandleChart } from "@/components/CandleChart";
import { Panel, Section, Unavailable } from "@/components/ui";
import { klines } from "@/lib/binance";
import { num, pct, pctPlain, usd, usdCompact } from "@/lib/format";
import {
  annualisedVol,
  changePct,
  logReturns,
  maxDrawdown,
  percentileRank,
  rsi,
  sma,
} from "@/lib/stats";
import { ASSETS, BY_SYM, prettyPair } from "@/lib/symbols";

// Daily bars are the reference series for every stat on this page, so one
// window (400 sessions) covers the 200 DMA and the 90d drawdown.
export const revalidate = 300;
const DAILY_BARS = 400;

export function generateStaticParams() {
  return ASSETS.map((a) => ({ symbol: a.sym }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  const asset = BY_SYM[symbol.toUpperCase()];
  if (!asset) return { title: "Unknown symbol" };
  const title = `${asset.sym} ${asset.name} chart, price and risk stats`;
  const description = `${asset.name} (${asset.sym}) live ${prettyPair(asset.pair)} candles with volume, 24h/7d/30d change, 30d annualised volatility, 90d max drawdown, daily RSI(14) and distance from the 50 and 200 day moving averages.`;
  return {
    title,
    description,
    alternates: { canonical: `https://terminal.web3wagmi.com/s/${asset.sym}` },
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const asset = BY_SYM[symbol.toUpperCase()];
  if (!asset) notFound();

  const bars = await klines(asset.pair, "1d", DAILY_BARS, revalidate);
  const closes = (bars ?? []).map((k) => k.close).filter(Number.isFinite);
  const last = closes.length ? closes[closes.length - 1] : NaN;

  const dma50 = sma(closes, 50);
  const dma200 = sma(closes, 200);
  const vol30 = annualisedVol(logReturns(closes.slice(-31)));
  // A year of daily vol gives the reading a home: 90 percent means calm is rare.
  const volSeries: number[] = [];
  for (let i = 30; i < closes.length; i++) volSeries.push(annualisedVol(logReturns(closes.slice(i - 30, i + 1))));
  const volRank = volSeries.length > 30 ? percentileRank(volSeries.slice(-365), vol30) : NaN;

  const stats: { label: string; value: string; tone?: number; hint?: string }[] = [
    { label: "24h", value: pct(changePct(closes, 1)), tone: changePct(closes, 1) },
    { label: "7d", value: pct(changePct(closes, 7)), tone: changePct(closes, 7) },
    { label: "30d", value: pct(changePct(closes, 30)), tone: changePct(closes, 30) },
    {
      label: "30d vol (ann.)",
      value: pctPlain(vol30),
      hint: "Standard deviation of the last 30 daily log returns, scaled to a year by sqrt(365) because crypto trades every day. Higher means wider swings.",
    },
    {
      label: "vol percentile 1y",
      value: pctPlain(volRank, 0),
      hint: "Where today's 30d volatility sits against the last year of the same measure. 90 means only 10 percent of the year was choppier.",
    },
    {
      label: "max drawdown 90d",
      value: pctPlain(maxDrawdown(closes.slice(-90))),
      tone: maxDrawdown(closes.slice(-90)),
      hint: "Worst peak to trough fall over the last 90 daily closes.",
    },
    {
      label: "RSI(14) daily",
      value: num(rsi(closes, 14), 1),
      hint: "Wilder relative strength index on daily closes. Above 70 is conventionally overbought, below 30 oversold.",
    },
    {
      label: "vs 50 DMA",
      value: pct(Number.isFinite(dma50) ? (last / dma50 - 1) * 100 : NaN),
      tone: Number.isFinite(dma50) ? last / dma50 - 1 : NaN,
      hint: `50 day simple moving average, currently ${usd(dma50)}.`,
    },
    {
      label: "vs 200 DMA",
      value: pct(Number.isFinite(dma200) ? (last / dma200 - 1) * 100 : NaN),
      tone: Number.isFinite(dma200) ? last / dma200 - 1 : NaN,
      hint: `200 day simple moving average, currently ${usd(dma200)}.`,
    },
  ];

  // The extreme of a year is usually an intraday wick, so read the bar highs
  // and lows rather than the close series.
  const year = (bars ?? []).slice(-365);
  const highs = year.map((k) => k.high).filter(Number.isFinite);
  const lows = year.map((k) => k.low).filter(Number.isFinite);
  const hi52 = highs.length ? Math.max(...highs) : NaN;
  const lo52 = lows.length ? Math.min(...lows) : NaN;
  const quoteVol24h = bars && bars.length ? bars[bars.length - 1].quoteVolume : NaN;

  return (
    <main className="shell py-5">
      <nav className="mb-4 font-mono text-[11px] text-[var(--text3)]">
        <Link href="/" className="hover:text-[var(--text)]">
          ← Terminal
        </Link>
      </nav>

      <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--text)]">
          {asset.sym}
        </h1>
        <span className="min-w-0 break-words text-sm text-[var(--text2)]">{asset.name}</span>
        <span className="pill" style={{ color: "var(--text3)" }}>
          {asset.sector}
        </span>
        <span className="font-mono text-[11px] text-[var(--text3)]">
          {prettyPair(asset.pair)} on Binance spot
        </span>
      </header>

      <Section title={`${asset.sym} price`}>
        <CandleChart symbol={asset.sym} navigateOnChange />
      </Section>

      <Section
        title="Risk and trend"
      >
        {closes.length < 40 ? (
          <Panel>
            <Unavailable what="Daily history" />
          </Panel>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s) => (
              <div key={s.label} className="card p-3">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 break-words font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                    {s.label}
                  </span>
                </div>
                <div
                  className="mt-1 whitespace-nowrap font-mono text-base font-bold tabular-nums"
                  style={{
                    color:
                      s.tone == null || !Number.isFinite(s.tone)
                        ? "var(--text)"
                        : s.tone >= 0
                          ? "var(--pos)"
                          : "var(--neg)",
                  }}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Reference levels">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Level label="last" value={usd(last)} />
          <Level label="52w high" value={usd(hi52)} />
          <Level label="52w low" value={usd(lo52)} />
          <Level label="quote volume, last daily bar" value={usdCompact(quoteVol24h)} />
        </div>
      </Section>
    </main>
  );
}

function Level({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="min-w-0 break-words font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
        {label}
      </div>
      <div className="mt-1 whitespace-nowrap font-mono text-base font-bold tabular-nums text-[var(--text)]">
        {value}
      </div>
    </div>
  );
}

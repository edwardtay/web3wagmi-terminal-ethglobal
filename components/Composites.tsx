"use client";

import { useApi } from "@/lib/useApi";
import { Loading, Unavailable, InfoHint } from "./ui";
import { num, usdCompact, signColor } from "@/lib/format";

// What the whole market is doing, rather than what six coins cost.
//
// The snapshot used to be six price tiles, which is the least differentiated
// thing a terminal can show: every site has them, a reader already knows the
// BTC price, and six of the twenty seven tracked assets is an arbitrary
// sample that answers nothing about the other twenty one.
//
// These are readings over the whole universe. Each one is a number next to the
// reference that makes it mean something, which is the rule the rest of this
// terminal keeps: a breadth count is meaningless without its total, and a
// stress score is meaningless without where it sits in its own year.
//
// Total market cap and the stablecoin share are not here. The panel directly
// underneath already carries both, and a number stated twice on one screen
// reads as two findings rather than one.

interface Breadth {
  ok: boolean;
  universe?: number;
  above50?: { n: number; total: number };
  above200?: { n: number; total: number };
  ad24?: { up: number; down: number };
  highs30?: number;
  lows30?: number;
  outperf7?: { n: number; total: number };
}
interface Stress {
  ok: boolean;
  score?: number;
  percentile?: number;
  prev1d?: number;
  band?: { label: string; color: string };
}
interface Quant {
  ok: boolean;
  /** Correlation grids by window. Each value is a matrix, not a scalar. */
  corr?: Record<string, number[][] | null>;
}
interface Derivs {
  ok: boolean;
  oi?: { venues?: { venue: string; usd: number }[] }[];
  hlPlatform?: {
    volumeUsd: number;
    buyUsd: number;
    sellUsd: number;
    liquidationsUsd: number;
    activeCoins: number;
  } | null;
}


function Stat({
  label,
  value,
  sub,
  hint,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint: string;
  color?: string;
}) {
  return (
    <div className="card min-w-0 p-3">
      <div className="flex items-start justify-between gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">{label}</span>
        <InfoHint text={hint} align="right" />
      </div>
      <div className="mt-1.5 break-words font-mono text-[17px] font-bold" style={{ color: color ?? "var(--text)" }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 break-words text-[10px] leading-snug text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

/**
 * Mean of the off diagonal, which is what "average correlation" means.
 *
 * The route returns a grid rather than a number, and reading it as a scalar
 * renders an array where a coefficient should be. The diagonal is every asset
 * against itself, so including it drags the average toward one and would make
 * a decorrelated market look tightly coupled.
 */
function averagePairwise(grid?: number[][] | null): number | null {
  if (!Array.isArray(grid) || grid.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < grid.length; i++) {
    for (let j = i + 1; j < grid.length; j++) {
      const v = grid[i]?.[j];
      if (Number.isFinite(v)) {
        sum += v as number;
        n += 1;
      }
    }
  }
  return n ? sum / n : null;
}

/** A count against its own total, which is the only way a breadth number reads. */
function share(part?: { n: number; total: number }): string {
  if (!part || !part.total) return "n/a";
  return `${Math.round((part.n / part.total) * 100)}%`;
}

export function Composites() {
  const { data: b, loading, failed } = useApi<Breadth>("/api/breadth", 900);
  const { data: s } = useApi<Stress>("/api/stress", 900);
  const { data: q } = useApi<Quant>("/api/quant", 900);
  const { data: d } = useApi<Derivs>("/api/derivs", 180);

  if (loading) return <Loading rows={4} />;
  if (failed || !b?.ok) return <Unavailable what="The market composites" />;

  const ad = b.ad24;
  const adNet = ad ? ad.up - ad.down : null;
  const corr90 = averagePairwise(q?.corr?.["90"]);

  // Every venue on every asset, which is the number the per-row bars add up to.
  const hl = d?.hlPlatform ?? null;
  const totalOi = (d?.oi ?? []).reduce(
    (a, r) => a + (r.venues ?? []).reduce((x, v) => x + v.usd, 0),
    0
  );

  // One per row on a phone. Two columns put a jargon label, a percentage and a
  // count into about 150px, which is where "Above 50d" stopped being a label
  // and became a puzzle.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Market stress"
        value={s?.score == null ? "n/a" : num(s.score, 0)}
        color={s?.band?.color}
        sub={
          s?.percentile == null
            ? s?.band?.label
            : `${s.band?.label}, ${num(s.percentile, 0)}th percentile of a year`
        }
        hint="A composite of realised and implied volatility, funding, stablecoin peg deviation, correlation and drawdown. The percentile is against its own last 365 days, which is the only thing that makes a score out of 100 mean anything."
      />
      {/* One card, two horizons.
          These were two cards showing the same measure at two speeds, which
          made the reader compare across a card boundary to get the thing that
          matters: the gap between them is how recent the strength is. Side by
          side, that subtraction is done by looking. */}
      <Stat
        label="Trend breadth"
        value={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{share(b.above50)}</span>
            <span className="text-[11px] font-normal text-[var(--text3)]">50d</span>
            <span className="text-[var(--text2)]">{share(b.above200)}</span>
            <span className="text-[11px] font-normal text-[var(--text3)]">200d</span>
          </span>
        }
        sub={
          b.above50 && b.above200
            ? `${b.above50.n} of ${b.above50.total} above the fast line, ${b.above200.n} of ${b.above200.total} above the slow one`
            : undefined
        }
        hint="Share of the top 100 USDT spot pairs trading above their own 50 and 200 day moving averages. A market where price is up and breadth is not is being carried by a few names, and the gap between the two figures is how recent the strength is: a high 50 day reading against a low 200 day one is a rally that has not been going long."
      />
      <Stat
        label="Rising vs falling, 24h"
        value={ad ? `${ad.up} / ${ad.down}` : "n/a"}
        color={adNet == null ? undefined : signColor(adNet)}
        sub={
          b.highs30 != null && b.lows30 != null
            ? `${b.highs30} at 30d highs, ${b.lows30} at lows`
            : "over 24 hours"
        }
        hint="How many of the tracked pairs rose against how many fell over 24 hours, with 30 day highs and lows underneath. A rally on narrow advances is a different market from the same move on broad ones."
      />
      <Stat
        label="Beating Bitcoin, 7d"
        value={share(b.outperf7)}
        sub={b.outperf7 ? `${b.outperf7.n} of ${b.outperf7.total} beat BTC, 7d` : undefined}
        hint="Share of the universe outperforming Bitcoin over seven days. Above half is a market paying for risk beyond the majors; below it, capital is consolidating into them."
      />
      <Stat
        label="How alike they move"
        value={corr90 == null ? "n/a" : num(corr90, 2)}
        sub="average pairwise correlation, 90 days"
        hint="Average pairwise correlation across the tracked universe. High means most of a portfolio's variance comes from the market factor and picking alts is a second order call."
      />
      <Stat
        label="Onchain perp flow"
        value={
          hl && hl.volumeUsd > 0
            ? `${num((hl.buyUsd / hl.volumeUsd) * 100, 0)}% buy`
            : "n/a"
        }
        color={hl && hl.volumeUsd > 0 ? signColor(hl.buyUsd - hl.sellUsd) : undefined}
        sub={hl ? `${usdCompact(hl.volumeUsd, 1)} across ${hl.activeCoins} markets, 24h` : undefined}
        hint="Buy volume as a share of all volume on Hyperliquid over the last daily bar, across every market it lists. Every other reading here is per asset; this is the venue itself, so it says whether the onchain crowd was lifting offers or hitting bids in aggregate. Near fifty percent is the resting state."
      />
      <Stat
        label="Perp open interest"
        value={totalOi > 0 ? usdCompact(totalOi, 2) : "n/a"}
        sub="Binance, Bybit, OKX, Hyperliquid"
        hint="Notional across all four venues the terminal reads, which is what is at stake if positioning unwinds. Size, not direction: the regime column on the open interest board carries that."
      />
    </div>
  );
}

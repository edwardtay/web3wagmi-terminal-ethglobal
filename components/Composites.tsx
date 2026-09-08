"use client";

import { useApi } from "@/lib/useApi";
import { Loading, Unavailable, InfoHint } from "./ui";
import { num, pct, usdCompact, signColor } from "@/lib/format";

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
}
interface Snap {
  ok: boolean;
  global?: { stableDom?: number | null; mcapChg24?: number | null };
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
  const { data: snap } = useApi<Snap>("/api/snapshot", 30);

  if (loading) return <Loading rows={4} />;
  if (failed || !b?.ok) return <Unavailable what="The market composites" />;

  const ad = b.ad24;
  const adNet = ad ? ad.up - ad.down : null;
  const corr90 = averagePairwise(q?.corr?.["90"]);

  // Every venue on every asset, which is the number the per-row bars add up to.
  const totalOi = (d?.oi ?? []).reduce(
    (a, r) => a + (r.venues ?? []).reduce((x, v) => x + v.usd, 0),
    0
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Stat
        label="Stress"
        value={s?.score == null ? "n/a" : num(s.score, 0)}
        color={s?.band?.color}
        sub={
          s?.percentile == null
            ? s?.band?.label
            : `${s.band?.label}, ${num(s.percentile, 0)}th percentile of a year`
        }
        hint="A composite of realised and implied volatility, funding, stablecoin peg deviation, correlation and drawdown. The percentile is against its own last 365 days, which is the only thing that makes a score out of 100 mean anything."
      />
      <Stat
        label="Above 50d"
        value={share(b.above50)}
        sub={b.above50 ? `${b.above50.n} of ${b.above50.total} pairs` : undefined}
        hint="Share of the top 100 USDT spot pairs trading above their own 50 day moving average. A market where price is up and breadth is not is being carried by a few names."
      />
      <Stat
        label="Above 200d"
        value={share(b.above200)}
        sub={b.above200 ? `${b.above200.n} of ${b.above200.total} pairs` : undefined}
        hint="The same count against the 200 day average, which is the slower line. The gap between this and the 50 day figure is how recent the strength is."
      />
      <Stat
        label="Advance / decline"
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
        label="Alts vs BTC"
        value={share(b.outperf7)}
        sub={b.outperf7 ? `${b.outperf7.n} of ${b.outperf7.total} beat BTC, 7d` : undefined}
        hint="Share of the universe outperforming Bitcoin over seven days. Above half is a market paying for risk beyond the majors; below it, capital is consolidating into them."
      />
      <Stat
        label="Correlation"
        value={corr90 == null ? "n/a" : num(corr90, 2)}
        sub="average pairwise, 90d"
        hint="Average pairwise correlation across the tracked universe. High means most of a portfolio's variance comes from the market factor and picking alts is a second order call."
      />
      <Stat
        label="Perp open interest"
        value={totalOi > 0 ? usdCompact(totalOi, 2) : "n/a"}
        sub="Binance, Bybit, OKX, Hyperliquid"
        hint="Notional across all four venues the terminal reads, which is what is at stake if positioning unwinds. Size, not direction: the regime column on the open interest board carries that."
      />
      <Stat
        label="Stablecoin share"
        value={snap?.global?.stableDom == null ? "n/a" : `${num(snap.global.stableDom, 1)}%`}
        sub="of total market cap"
        hint="Stablecoins as a share of total crypto market cap. It rises when capital steps out of risk without leaving the asset class, so it is the closest thing here to a cash balance for the whole market."
      />
      <Stat
        label="Market cap 24h"
        value={snap?.global?.mcapChg24 == null ? "n/a" : pct(snap.global.mcapChg24, 2)}
        color={snap?.global?.mcapChg24 == null ? undefined : signColor(snap.global.mcapChg24)}
        sub="whole asset class"
        hint="Total crypto market capitalisation over 24 hours. The one number here that a headline would quote, kept for reference rather than for insight."
      />
    </div>
  );
}

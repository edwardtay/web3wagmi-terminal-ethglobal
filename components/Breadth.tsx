"use client";

import { AsOf, Loading, Meter, Panel, Unavailable } from "@/components/ui";
import { pct, pctPlain, usdCompact, NA } from "@/lib/format";
import { useApi } from "@/lib/useApi";

interface BreadthPayload {
  ok: boolean;
  asOf: string;
  universe: number;
  quoteVolUsd: number;
  above50: { n: number; total: number };
  above200: { n: number; total: number };
  ad24: { up: number; down: number };
  ad7: { up: number; down: number };
  highs30: number;
  lows30: number;
  outperf7: { n: number; total: number };
  outperf30: { n: number; total: number };
  btc: { r24: number | null; r7: number | null; r30: number | null };
  altIndex: number | null;
}

// How much of the liquid board is participating, and whether alts are actually
// beating BTC. Everything is measured over the top 100 USDT spot pairs by 24h
// quote volume, so the reading is a market statement rather than a watchlist one.

const ALT_RECIPE =
  "Our own 0-100 score, not a third party's. 45% share of the universe beating BTC over 30d, " +
  "25% share beating BTC over 7d, 20% share above its 200d moving average, 10% share of the " +
  "universe up over 7d. Above 75 reads as alt season, below 25 as a BTC-only tape.";

const MA_READING =
  "Share of the top 100 USDT spot pairs trading above that simple moving average of daily closes. " +
  "Above 70 is broad strength, below 30 is washed out. Pairs listed too recently to have the full " +
  "window are left out of the denominator.";

function shareOf(p: { n: number; total: number }): number {
  return p.total ? (p.n / p.total) * 100 : NaN;
}

/** Two-sided bar: advancers left in green, decliners right in red. */
function AdvDecl({ label, up, down }: { label: string; up: number; down: number }) {
  const total = up + down;
  const upShare = total ? (up / total) * 100 : 50;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">
          {label}
        </span>
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums">
          <span style={{ color: "var(--pos)" }}>{up} up</span>
          <span className="text-[var(--text3)]"> / </span>
          <span style={{ color: "var(--neg)" }}>{down} down</span>
        </span>
      </div>
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
        <div className="h-full" style={{ width: `${upShare}%`, background: "var(--pos)" }} />
        <div className="h-full flex-1" style={{ background: "var(--neg)" }} />
      </div>
      <div className="mt-1.5 text-[11px] text-[var(--text3)]">
        {Number.isFinite(upShare) ? `${pctPlain(upShare)} advancing` : NA}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <span className="font-display text-[10px] font-semibold uppercase tracking-wider text-[var(--text3)]">
          {label}
        </span>
      </div>
      <div className="mt-1 font-mono text-lg font-bold leading-none" style={{ color: color ?? "var(--text)" }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] leading-snug text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

export function Breadth() {
  const { data, loading, failed } = useApi<BreadthPayload>("/api/breadth", 900);

  if (loading) {
    return (
      <Panel title="Market breadth">
        <Loading rows={6} />
      </Panel>
    );
  }
  if (failed || !data?.ok) {
    return (
      <Panel title="Market breadth">
        <Unavailable what="Market breadth" />
      </Panel>
    );
  }

  const s50 = shareOf(data.above50);
  const s200 = shareOf(data.above200);
  const o7 = shareOf(data.outperf7);
  const o30 = shareOf(data.outperf30);
  const alt = data.altIndex;
  const known = alt != null && Number.isFinite(alt);
  const altColor = !known
    ? "var(--text3)"
    : alt! >= 75
      ? "var(--violet)"
      : alt! >= 50
        ? "var(--pos)"
        : alt! >= 25
          ? "var(--gold)"
          : "var(--accent)";
  const altLabel = !known
    ? "no reading"
    : alt! >= 75
      ? "alt season"
      : alt! >= 50
        ? "alts leaning"
        : alt! >= 25
          ? "BTC leaning"
          : "BTC season";

  return (
    <Panel
      title="Market breadth"
      right={
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
            {usdCompact(data.quoteVolUsd)} prior-day vol
          </span>
          <AsOf iso={data.asOf} staleMs={30 * 60 * 1000} />
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Meter
          label="Above 50d MA"
          score={s50}
          color={s50 >= 70 ? "var(--pos)" : s50 <= 30 ? "var(--neg)" : "var(--gold)"}
          caption={`${data.above50.n} of ${data.above50.total} pairs`}
        />
        <Meter
          label="Above 200d MA"
          score={s200}
          color={s200 >= 70 ? "var(--pos)" : s200 <= 30 ? "var(--neg)" : "var(--gold)"}
          caption={`${data.above200.n} of ${data.above200.total} pairs`}
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text3)]">
        <span>Above 70 is broad strength, below 30 is washed out.</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-[var(--border2)] pt-4 sm:grid-cols-2">
        <AdvDecl label="Advance / decline 24h" up={data.ad24.up} down={data.ad24.down} />
        <AdvDecl label="Advance / decline 7d" up={data.ad7.up} down={data.ad7.down} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border2)] pt-4 lg:grid-cols-4">
        <Stat
          label="New 30d highs"
          value={String(data.highs30)}
          color="var(--pos)"
          sub="closes above the prior 30d high"
        />
        <Stat
          label="New 30d lows"
          value={String(data.lows30)}
          color="var(--neg)"
          sub="closes below the prior 30d low"
        />
        <Stat
          label="Beating BTC 7d"
          value={pctPlain(o7)}
          color={o7 >= 50 ? "var(--pos)" : "var(--text)"}
          sub={`${data.outperf7.n} of ${data.outperf7.total} alts, BTC ${pct(data.btc.r7)}`}
        />
        <Stat
          label="Beating BTC 30d"
          value={pctPlain(o30)}
          color={o30 >= 50 ? "var(--pos)" : "var(--text)"}
          sub={`${data.outperf30.n} of ${data.outperf30.total} alts, BTC ${pct(data.btc.r30)}`}
        />
      </div>

      <div className="mt-4 border-t border-[var(--border2)] pt-4">
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-display text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">
              Alt-season index
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold leading-none" style={{ color: altColor }}>
              {known ? alt!.toFixed(0) : NA}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: altColor }}>
              {altLabel}
            </span>
          </div>
        </div>
        <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
          <div className="absolute inset-y-0 left-1/4 w-px bg-[var(--border)]" />
          <div className="absolute inset-y-0 left-3/4 w-px bg-[var(--border)]" />
          <div
            className="absolute inset-y-0 w-[3px] rounded-full"
            style={{ left: `calc(${Math.min(100, Math.max(0, known ? alt! : 0))}% - 1.5px)`, background: altColor }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--text3)]">
          <span>0 BTC season</span>
          <span>50</span>
          <span>100 alt season</span>
        </div>
      </div>
    </Panel>
  );
}

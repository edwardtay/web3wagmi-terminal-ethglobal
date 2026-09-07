"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { AsOf, Loading, Panel, Sparkline, TableWrap, Th, Unavailable, TokenIcon, useSort } from "@/components/ui";
import { bps, duration, pct, signColor, NA } from "@/lib/format";
import { useSymbol } from "@/lib/useSymbol";

// Perpetual funding across two venues. Binance sets the price of leverage for
// most of the market, Hyperliquid is the largest on-chain perp book, and the
// gap between the two is where a cash-and-carry desk actually looks.

interface FundingRow {
  sym: string;
  name: string;
  perp: string;
  rate: number;
  intervalHours: number;
  annual: number;
  hlAnnual: number | null;
  spread: number | null;
  nextFundingTime: number;
  premium: number | null;
  history: number[];
}

interface Payload {
  ok: boolean;
  asOf: string;
  hyperliquid: boolean;
  funding: FundingRow[];
}

/** Crowding thresholds traders act on: paying a lot to be long, or paid to be long. */
const HOT = 50;
const COLD = -20;


function extremeStyle(annual: number): React.CSSProperties | undefined {
  if (annual >= HOT) return { background: "var(--pos-soft)" };
  if (annual <= COLD) return { background: "var(--neg-soft)" };
  return undefined;
}

/** Ticking countdown to the next settlement, computed in the browser. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now == null) return <span className="text-[var(--text3)]">{NA}</span>;
  const left = at - now;
  // Inside the last 15 minutes the print is close enough to matter for entry.
  const soon = left > 0 && left < 15 * 60 * 1000;
  return (
    <span style={{ color: soon ? "var(--gold)" : "var(--text2)" }}>{duration(Math.max(0, left))}</span>
  );
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text3)]">
        {label}
      </div>
      <div
        className="mt-1 whitespace-nowrap font-mono text-sm font-bold"
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 break-words text-[11px] text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

export function FundingBoard() {
  // The focused instrument reads as a marked row here rather than filtering the
  // table, since the ranking against everything else is the point of the panel.
  const { symbol: focus } = useSymbol();

  const { data, loading, failed } = useApi<Payload>("/api/derivs", 60);
  const rows = data?.funding ?? [];
  // Opens on distance from zero, because a rate near zero is the absence of the
  // thing this board is about.
  const sort = useSort(rows, { key: "annual", dir: "desc" });

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const annuals = rows.map((r) => r.annual);
    return {
      med: median(annuals),
      pos: annuals.filter((a) => a > 0).length,
      neg: annuals.filter((a) => a < 0).length,
      long: rows[0],
      short: rows[rows.length - 1],
    };
  }, [rows]);

  return (
    <Panel
      title="Funding board"
      right={<AsOf iso={data?.asOf} staleMs={15 * 60 * 1000} />}
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !rows.length ? (
        <Unavailable what="Funding" />
      ) : (
        <>
          {summary && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Median ann."
                value={pct(summary.med, 1)}
                color={signColor(summary.med)}
                sub={`${rows.length} perps tracked`}
              />
              <Stat
                label="Pos / neg"
                value={`${summary.pos} / ${summary.neg}`}
                sub="contracts paying longs vs shorts"
              />
              <Stat
                label="Most crowded long"
                value={`${summary.long.sym} ${pct(summary.long.annual, 0)}`}
                color="var(--pos)"
                sub={summary.long.name}
              />
              <Stat
                label="Most crowded short"
                value={`${summary.short.sym} ${pct(summary.short.annual, 0)}`}
                color="var(--neg)"
                sub={summary.short.name}
              />
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text3)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--pos-soft)" }} />
              above +{HOT}% ann.
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--neg-soft)" }} />
              below {COLD}% ann.
            </span>
            {data && !data.hyperliquid && <span>Hyperliquid leg unavailable.</span>}
          </div>

          <TableWrap maxHeight={460}>
            <thead>
              <tr>
                <Th label="Perp" sortKey="sym" sort={sort} />
                <Th
                  label="Rate / int."
                  num
                  sortKey="rate"
                  sort={sort}
                  hint="Raw rate per settlement. Cadence differs by contract, so these are not comparable across rows."
                />
                <Th
                  label="Binance ann."
                  num
                  sortKey="annual"
                  sort={sort}
                  hint="Annualised on each contract's own cadence. A fixed 8h multiplier overstates the 4h contracts by two."
                />
                <Th
                  label="HL ann."
                  num
                  sortKey="hlAnnual"
                  sort={sort}
                  hint="Blank means not listed on Hyperliquid, not a zero rate."
                />
                <Th
                  label="Spread"
                  num
                  sortKey="spread"
                  sort={sort}
                  hint="A carry difference, not an arbitrage: it needs margin on both venues and can converge first."
                />
                <Th
                  label="Premium"
                  num
                  sortKey="premium"
                  sort={sort}
                  hint="Funding follows premium with a lag, so this leads the rate."
                />
                <Th label="Next" num sortKey="nextFundingTime" sort={sort} hint="A rate only costs at settlement, so time to it changes the position." />
                <Th label="Last 30 prints" num hint="High all week is a regime; high today is an event. Shape matters more than level." />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.perp} style={{ ...extremeStyle(r.annual), ...(r.sym === focus ? { boxShadow: "inset 3px 0 0 0 var(--accent2)" } : {}) }}>
                  <td className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono text-[12px] font-bold text-[var(--text)]">
                      <TokenIcon sym={r.sym} />
                      {r.sym}
                    </div>
                    <div className="break-words text-[10px] text-[var(--text3)]">{r.name}</div>
                  </td>
                  <td className="num" style={{ color: signColor(r.rate) }}>
                    {bps(r.rate, 2)}
                    <div className="text-[10px] text-[var(--text3)]">{r.intervalHours}h</div>
                  </td>
                  <td className="num font-bold" style={{ color: signColor(r.annual) }}>
                    {pct(r.annual, 1)}
                  </td>
                  <td className="num" style={{ color: r.hlAnnual == null ? "var(--text3)" : signColor(r.hlAnnual) }}>
                    {r.hlAnnual == null ? NA : pct(r.hlAnnual, 1)}
                  </td>
                  <td className="num" style={{ color: r.spread == null ? "var(--text3)" : signColor(r.spread) }}>
                    {r.spread == null ? NA : pct(r.spread, 1)}
                  </td>
                  <td className="num" style={{ color: r.premium == null ? "var(--text3)" : signColor(r.premium) }}>
                    {r.premium == null ? NA : bps(r.premium, 1)}
                  </td>
                  <td className="num">
                    <Countdown at={r.nextFundingTime} />
                  </td>
                  <td className="num">
                    <Sparkline
                      data={r.history}
                      width={90}
                      height={22}
                      stroke={signColor(r.history.at(-1) ?? 0)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}
    </Panel>
  );
}

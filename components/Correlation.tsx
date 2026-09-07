"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { AsOf, Loading, Panel, Segmented, Unavailable } from "@/components/ui";
import { num, NA } from "@/lib/format";
import type { QuantPayload } from "@/app/api/quant/route";

// Pairwise correlation of daily log returns. The number that matters is not any
// single pair, it is the average: when everything correlates the whole book is
// one position with extra steps.

type Win = "30" | "90" | "365";

const WINDOWS: readonly { value: Win; label: string }[] = [
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "365", label: "1y" },
];

/**
 * Diverging fill. Violet and cyan rather than the price palette, so a strong
 * correlation is never mistaken for a strong return. Both hold in either theme.
 */
function cell(v: number): string {
  if (!Number.isFinite(v)) return "transparent";
  const mix = (Math.min(1, Math.abs(v)) * 55).toFixed(0);
  return `color-mix(in srgb, ${v >= 0 ? "var(--violet)" : "var(--cyan)"} ${mix}%, transparent)`;
}

export function Correlation() {
  const { data, loading, failed } = useApi<QuantPayload>("/api/quant", 900);
  const [win, setWin] = useState<Win>("90");

  const syms = data?.matrixSyms ?? [];
  const grid = data?.corr?.[win] ?? [];

  const avg = useMemo(() => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < grid.length; i++) {
      for (let j = i + 1; j < grid.length; j++) {
        const v = grid[i]?.[j];
        if (Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
    }
    return n ? sum / n : NaN;
  }, [grid]);

  const reading =
    !Number.isFinite(avg)
      ? ""
      : avg >= 0.8
        ? "The market is trading as one asset. Picking alts is a leverage decision on beta, diversification across this list buys almost nothing."
        : avg >= 0.6
          ? "Correlation is high. Most of a portfolio's variance here comes from the market factor, alt selection is a second-order call."
          : avg >= 0.4
            ? "Correlation is moderate. Names are starting to move on their own, selection has some room to matter."
            : "Correlation is low for crypto. The market is dispersing and single-name work is being paid.";

  return (
    <Panel
      title="Correlation matrix"
      right={
        <div className="flex items-center gap-2">
          <Segmented<Win> options={WINDOWS} value={win} onChange={setWin} ariaLabel="Correlation window" />
          <AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />
        </div>
      }
    >
      {loading ? (
        <Loading rows={7} />
      ) : failed || !syms.length || !grid.length ? (
        <Unavailable what="The correlation matrix" />
      ) : (
        <>
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: syms.length * 46 + 48 }}>
              <caption className="sr-only">
                Correlation of daily log returns over {win} days
              </caption>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-[var(--surface)] p-1 text-left font-mono text-[10px] font-bold text-[var(--text3)]">
                    <span aria-hidden>ρ</span>
                    <span className="sr-only">Asset</span>
                  </th>
                  {syms.map((s) => (
                    <th
                      key={s}
                      scope="col"
                      className="p-1 text-center font-mono text-[10px] font-bold text-[var(--text3)]"
                    >
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {syms.map((rowSym, i) => (
                  <tr key={rowSym}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-[var(--surface)] p-1 text-left font-mono text-[10px] font-bold text-[var(--text)]"
                    >
                      {rowSym}
                    </th>
                    {syms.map((colSym, j) => {
                      const v = grid[i]?.[j];
                      const self = i === j;
                      return (
                        <td
                          key={colSym}
                          className="p-1 text-center font-mono text-[10px] tabular-nums"
                          style={{
                            background: self ? "var(--surface2)" : cell(v),
                            color: self ? "var(--text3)" : "var(--text)",
                            border: "1px solid var(--border2)",
                            fontWeight: Math.abs(v) >= 0.8 && !self ? 700 : 500,
                          }}
                          title={`${rowSym} vs ${colSym}: ${Number.isFinite(v) ? v.toFixed(2) : "no data"} over ${win} days`}
                        >
                          {Number.isFinite(v) ? v.toFixed(2) : NA}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[10px] text-[var(--text3)]">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-3 w-6 rounded-sm"
                style={{ background: "color-mix(in srgb, var(--cyan) 55%, transparent)" }}
              />
              −1.00
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-6 rounded-sm border border-[var(--border)]" />
              0.00
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-3 w-6 rounded-sm"
                style={{ background: "color-mix(in srgb, var(--violet) 55%, transparent)" }}
              />
              +1.00
            </span>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-[var(--text2)]">
            <span className="font-mono font-bold text-[var(--text)]">
              Average pairwise ρ {num(avg, 2)}
            </span>{" "}
            over {win} days across {syms.length} assets. {reading}
          </p>
        </>
      )}
    </Panel>
  );
}

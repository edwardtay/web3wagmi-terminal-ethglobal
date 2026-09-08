"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { Loading, Panel, TableWrap, Unavailable, AsOf } from "@/components/ui";
import { pct } from "@/lib/format";
import type { QuantPayload } from "@/app/api/quant/route";

// Every universe asset by every horizon in one grid. Heat shading is relative
// to the column, not the whole grid: a 3% day and a 300% year are both extreme
// in their own timeframe and should read that way.

const COLS = [
  { key: "r24", label: "24h" },
  { key: "r7", label: "7d" },
  { key: "r30", label: "30d" },
  { key: "r90", label: "90d" },
  { key: "rYtd", label: "YTD" },
  { key: "r1y", label: "1y" },
] as const;

type ColKey = (typeof COLS)[number]["key"];

/** Shade strength as a share of the column's largest absolute move. */
function shade(v: number, maxAbs: number): string {
  if (!Number.isFinite(v) || !(maxAbs > 0)) return "transparent";
  const strength = Math.min(1, Math.abs(v) / maxAbs);
  const mix = (6 + strength * 46).toFixed(0);
  return `color-mix(in srgb, ${v >= 0 ? "var(--pos)" : "var(--neg)"} ${mix}%, transparent)`;
}

export function ReturnsMatrix() {
  const { data, loading, failed } = useApi<QuantPayload>("/api/quant", 900);
  const [sortKey, setSortKey] = useState<ColKey>("r24");
  const [desc, setDesc] = useState(true);

  const rows = data?.rows ?? [];

  const stats = useMemo(() => {
    const out: Record<string, { maxAbs: number; best: string; worst: string }> = {};
    for (const c of COLS) {
      let maxAbs = 0;
      let best = "";
      let worst = "";
      let hi = -Infinity;
      let lo = Infinity;
      for (const r of rows) {
        const v = r[c.key];
        if (!Number.isFinite(v)) continue;
        maxAbs = Math.max(maxAbs, Math.abs(v));
        if (v > hi) [hi, best] = [v, r.sym];
        if (v < lo) [lo, worst] = [v, r.sym];
      }
      out[c.key] = { maxAbs, best, worst };
    }
    return out;
  }, [rows]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return desc ? bn - an : an - bn;
    });
    return copy;
  }, [rows, sortKey, desc]);

  function click(k: ColKey) {
    if (k === sortKey) setDesc((d) => !d);
    else {
      setSortKey(k);
      setDesc(true);
    }
  }

  return (
    <Panel
      title="Returns matrix"
      hint="Daily closes from Binance spot, over the tracked universe."
      right={<AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />}
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !rows.length ? (
        <Unavailable what="The returns matrix" />
      ) : (
        <>
          <TableWrap maxHeight={520}>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className="num"
                    aria-sort={sortKey === c.key ? (desc ? "descending" : "ascending") : "none"}
                  >
                    <button
                      onClick={() => click(c.key)}
                      className="font-mono uppercase tracking-[0.08em]"
                      style={{ color: sortKey === c.key ? "var(--accent)" : "inherit" }}
                    >
                      {c.label}
                      {sortKey === c.key ? (desc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.sym}>
                  <td className="min-w-0">
                    <span className="font-mono font-bold text-[var(--text)]">{r.sym}</span>{" "}
                    <span className="text-[11px] text-[var(--text3)]">{r.sector}</span>
                  </td>
                  {COLS.map((c) => {
                    const v = r[c.key];
                    const s = stats[c.key];
                    const isBest = s.best === r.sym;
                    const isWorst = s.worst === r.sym;
                    return (
                      <td
                        key={c.key}
                        className="num"
                        style={{
                          background: shade(v, s.maxAbs),
                          // Text stays neutral so it keeps contrast over its own
                          // heat fill; the sign is carried by the +/- prefix.
                          color: Number.isFinite(v) ? "var(--text)" : "var(--text3)",
                          fontWeight: isBest || isWorst ? 700 : 500,
                          boxShadow: isBest
                            ? "inset 0 0 0 1px var(--pos)"
                            : isWorst
                              ? "inset 0 0 0 1px var(--neg)"
                              : undefined,
                        }}
                        title={
                          isBest
                            ? `Best ${c.label}`
                            : isWorst
                              ? `Worst ${c.label}`
                              : undefined
                        }
                      >
                        {pct(v, 1)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-[var(--text3)]">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ boxShadow: "inset 0 0 0 1px var(--pos)" }}
              />
              best in column
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ boxShadow: "inset 0 0 0 1px var(--neg)" }}
              />
              worst in column
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

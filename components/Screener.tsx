"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { AsOf, Loading, Panel, TableWrap, Unavailable, TokenIcon } from "@/components/ui";
import { num, pct, pctPlain, usd, usdCompact, NA } from "@/lib/format";
import { useSymbol } from "@/lib/useSymbol";
import type { ScreenPayload, ScreenRow } from "@/app/api/screener/route";

// One table over the whole universe. The presets are the point: a screener that
// needs a form filled in does not get used, four buttons that answer the usual
// questions does.

const SECTORS = ["Majors", "L1", "L2", "DeFi", "AI", "Meme", "Infra", "Exchange"] as const;

const PRESETS = [
  { id: "oversold", label: "Oversold", hint: "RSI14 below 30" },
  { id: "momentum", label: "Momentum", hint: "Above the 50 and 200 day averages with a positive 30d" },
  { id: "highvol", label: "High vol", hint: "30d annualised volatility above 100%" },
  { id: "volume", label: "Volume leaders", hint: "Top 10 by 24h quote volume" },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];

const COLS = [
  { key: "price", label: "Price", num: true },
  { key: "r24", label: "24h", num: true },
  { key: "r7", label: "7d", num: true },
  { key: "r30", label: "30d", num: true },
  { key: "vol24", label: "Vol 24h", num: true },
  { key: "d50", label: "vs 50D", num: true },
  { key: "d200", label: "vs 200D", num: true },
  { key: "rsi14", label: "RSI14", num: true },
  { key: "vol30", label: "σ 30d", num: true },
  { key: "sharpe", label: "Sharpe", num: true },
] as const;

type ColKey = (typeof COLS)[number]["key"];

/**
 * Header hints, which carry the caveat and not the definition.
 *
 * Anyone reading this table knows what RSI is. What they cannot read off the
 * number is which venue it came from, what the window is annualised by, and
 * what a blank cell means.
 */
const HEAD_HINT: Record<ColKey, string> = {
  price: "Binance USDT spot, not a cross-venue index.",
  r24: "Rolling 24h to now, not a daily candle, so it will not match a daily close figure.",
  r7: "Point to point. A flat week and a round trip through a drawdown read the same.",
  r30: "Point to point, same basis as the 7d column.",
  vol24: "Binance only, so venues elsewhere are missing. Turnover, not net flow.",
  d50: "Blank means fewer than 50 daily closes exist, not that it sits at the average.",
  d200: "Blank means the listing is younger than 200 days, not that it sits at the average.",
  rsi14: "Oversold is not a buy: in a downtrend RSI sits under 30 for weeks.",
  vol30: "Annualised by sqrt(365), so not comparable to an equity vol annualised by 252.",
  sharpe: "Risk-free rate zero, so it reads higher than a true Sharpe. Backward looking.",
};

function cellValue(r: ScreenRow, k: ColKey): string {
  const v = r[k];
  if (!Number.isFinite(v)) return NA;
  switch (k) {
    case "price":
      return usd(v);
    case "vol24":
      return usdCompact(v, 1);
    case "rsi14":
      return num(v, 0);
    case "vol30":
      return pctPlain(v, 0);
    case "sharpe":
      return num(v, 2);
    default:
      return pct(v, 1);
  }
}

function cellColor(r: ScreenRow, k: ColKey): string {
  const v = r[k];
  if (!Number.isFinite(v)) return "var(--text3)";
  if (k === "rsi14") return v >= 70 ? "var(--neg)" : v <= 30 ? "var(--pos)" : "var(--text2)";
  if (k === "price" || k === "vol24" || k === "vol30") return "var(--text2)";
  return v >= 0 ? "var(--pos)" : "var(--neg)";
}

export function Screener() {
  // The focused instrument reads as a marked row here rather than filtering the
  // table, since the ranking against everything else is the point of the panel.
  const { symbol: focus } = useSymbol();

  const { data, loading, failed } = useApi<ScreenPayload>("/api/screener", 900);
  const [sectors, setSectors] = useState<string[]>([]);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ColKey>("vol24");
  const [desc, setDesc] = useState(true);

  const rows = data?.rows ?? [];

  const filtered = useMemo(() => {
    const volumeCut = [...rows]
      .filter((r) => Number.isFinite(r.vol24))
      .sort((a, b) => b.vol24 - a.vol24)
      .slice(0, 10)
      .map((r) => r.sym);
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (sectors.length && !sectors.includes(r.sector)) return false;
      if (q && !r.sym.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      if (preset === "oversold") return r.rsi14 < 30;
      if (preset === "momentum") return r.d50 > 0 && r.d200 > 0 && r.r30 > 0;
      // 100% annualised is roughly where a major stops and a high-beta alt starts.
      if (preset === "highvol") return r.vol30 > 100;
      if (preset === "volume") return volumeCut.includes(r.sym);
      return true;
    });
  }, [rows, sectors, preset, query]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = Number.isFinite(a[sortKey]) ? a[sortKey] : -Infinity;
      const bv = Number.isFinite(b[sortKey]) ? b[sortKey] : -Infinity;
      return desc ? bv - av : av - bv;
    });
    return copy;
  }, [filtered, sortKey, desc]);

  function click(k: ColKey) {
    if (k === sortKey) setDesc((d) => !d);
    else {
      setSortKey(k);
      setDesc(true);
    }
  }

  function toggleSector(s: string) {
    setSectors((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  const chip = (active: boolean) =>
    `pill cursor-pointer transition-colors ${
      active
        ? "border-[var(--accent)] text-[var(--accent)]"
        : "text-[var(--text3)] hover:text-[var(--text2)]"
    }`;

  return (
    <Panel right={<AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />}>
      {loading ? (
        <Loading rows={10} />
      ) : failed || !rows.length ? (
        <Unavailable what="The screener" />
      ) : (
        <>
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreset((cur) => (cur === p.id ? null : p.id))}
                  aria-pressed={preset === p.id}
                  title={p.hint}
                  className={chip(preset === p.id)}
                  style={
                    preset === p.id
                      ? { background: "var(--accent-soft)" }
                      : undefined
                  }
                >
                  {p.label}
                </button>
              ))}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter by name"
                aria-label="Filter by symbol or name"
                className="min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--bg2)] px-3 py-1 font-mono text-[11px] text-[var(--text)] placeholder:text-[var(--text3)] focus:border-[var(--accent)] focus:outline-none"
                style={{ maxWidth: 200 }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {SECTORS.map((s) => (
                <button
                  key={s}
                  onClick={() => toggleSector(s)}
                  aria-pressed={sectors.includes(s)}
                  className={chip(sectors.includes(s))}
                  style={sectors.includes(s) ? { background: "var(--accent-soft)" } : undefined}
                >
                  {s}
                </button>
              ))}
              {(sectors.length > 0 || preset || query) && (
                <button
                  onClick={() => {
                    setSectors([]);
                    setPreset(null);
                    setQuery("");
                  }}
                  className="pill text-[var(--text3)] hover:text-[var(--text)]"
                  aria-label="Clear all screener filters"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          <div className="mb-2 font-mono text-[11px] text-[var(--text3)]">
            <span className="font-bold text-[var(--text)]">{sorted.length}</span> of {rows.length} assets match
            {preset ? ` · ${PRESETS.find((p) => p.id === preset)?.hint.toLowerCase()}` : ""}
          </div>

          {sorted.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-[var(--text3)]">
              No asset in the universe matches this filter right now.
            </div>
          ) : (
            <TableWrap maxHeight={520}>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  {COLS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className="num"
                      title={HEAD_HINT[c.key]}
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
                  <tr key={r.sym} style={r.sym === focus ? { boxShadow: "inset 3px 0 0 0 var(--accent2)" } : undefined}>
                    <td className="min-w-0">
                      <div className="flex items-center gap-1.5 font-mono font-bold text-[var(--text)]">
                        <TokenIcon sym={r.sym} />
                        {r.sym}
                      </div>
                      <div className="text-[10px] text-[var(--text3)]">
                        {r.name} · {r.sector}
                      </div>
                    </td>
                    {COLS.map((c) => (
                      <td key={c.key} className="num" style={{ color: cellColor(r, c.key) }}>
                        {cellValue(r, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </>
      )}
    </Panel>
  );
}

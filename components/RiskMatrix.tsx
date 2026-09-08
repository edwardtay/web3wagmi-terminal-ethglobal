"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useNarrow } from "@/lib/useNarrow";
import { AsOf, Loading, Panel, TableWrap, Unavailable, TokenIcon } from "@/components/ui";
import { num, pct, pctPlain, NA } from "@/lib/format";
import type { QuantPayload, QuantRow } from "@/app/api/quant/route";

// Risk-adjusted view of the universe: how much an asset moves, how far it has
// fallen, and what it paid for that. The scatter is the part a professional
// reads first, so it gets the room and the labels are placed to stay legible.

const COLS = [
  { key: "vol30", label: "Vol 30d", fmt: (v: number) => pctPlain(v, 0), hint: "Annualised realised volatility from 30 daily log returns." },
  { key: "vol90", label: "Vol 90d", fmt: (v: number) => pctPlain(v, 0), hint: "Annualised realised volatility from 90 daily log returns." },
  { key: "mdd90", label: "MDD 90d", fmt: (v: number) => pctPlain(v, 0), hint: "Worst peak-to-trough decline inside the last 90 days." },
  { key: "mdd365", label: "MDD 1y", fmt: (v: number) => pctPlain(v, 0), hint: "Worst peak-to-trough decline inside the last year." },
  { key: "sharpe", label: "Sharpe", fmt: (v: number) => num(v, 2), hint: "Annualised return divided by annualised volatility over 365 days, risk-free rate zero." },
  { key: "sortino", label: "Sortino", fmt: (v: number) => num(v, 2), hint: "Sharpe using only downside deviation, so upside volatility is not punished." },
  { key: "betaBtc", label: "β BTC", fmt: (v: number) => num(v, 2), hint: "Slope of the asset against BTC on 90 days of daily log returns. Above 1 means it amplifies BTC." },
  { key: "corrBtc", label: "ρ BTC", fmt: (v: number) => num(v, 2), hint: "Correlation to BTC on 90 days of daily log returns." },
] as const;

type ColKey = (typeof COLS)[number]["key"];

/* ---------------------------------------------------------------- scatter -- */

/**
 * Two shapes for the same chart.
 *
 * The landscape one is the better chart and it does not fit a phone. Forcing it
 * to 560px minimum put the plot behind a horizontal scrollbar, so the reader
 * saw two thirds of a scatter and had to drag to find the rest, which defeats
 * the only thing a scatter is for: seeing where everything sits at once.
 *
 * Scaling it down instead is worse. The viewBox is 720 wide, so on a 400px
 * screen every label renders at a bit over half its size, and the axis numbers
 * become unreadable rather than merely small.
 *
 * A portrait viewBox is the answer. It fits the width at roughly one to one,
 * so the text renders at the size it was drawn, and the height it gains back is
 * what keeps the points apart.
 */
type Dims = { W: number; H: number; PAD: { l: number; r: number; t: number; b: number } };

const WIDE: Dims = { W: 720, H: 430, PAD: { l: 52, r: 18, t: 16, b: 44 } };
const NARROW: Dims = { W: 360, H: 460, PAD: { l: 44, r: 14, t: 14, b: 40 } };

interface Placed {
  x: number;
  y: number;
  lx: number;
  ly: number;
  w: number;
  leader: boolean;
  row: QuantRow;
  clamped: boolean;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * A single runaway performer would flatten everyone else onto one line, so the
 * return axis is bounded by the 5th/95th percentile with headroom and the few
 * outliers are pinned to the frame edge (their true value stays in the title).
 */
function domain(values: number[]): [number, number] {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return [0, 1];
  const lo = Math.min(quantile(xs, 0.05), 0);
  const hi = Math.max(quantile(xs, 0.95), 0);
  const padding = (hi - lo) * 0.12 || 1;
  return [lo - padding, hi + padding];
}

function layout(rows: QuantRow[], D: Dims): { placed: Placed[]; xd: [number, number]; yd: [number, number] } {
  const xd = domain(rows.map((r) => r.vol90));
  const yd = domain(rows.map((r) => r.ret90Ann));
  const px = (v: number) => D.PAD.l + ((v - xd[0]) / (xd[1] - xd[0])) * (D.W - D.PAD.l - D.PAD.r);
  const py = (v: number) => D.H - D.PAD.b - ((v - yd[0]) / (yd[1] - yd[0])) * (D.H - D.PAD.t - D.PAD.b);
  const clampX = (v: number) => Math.min(D.W - D.PAD.r - 2, Math.max(D.PAD.l + 2, v));
  const clampY = (v: number) => Math.min(D.H - D.PAD.b - 2, Math.max(D.PAD.t + 2, v));

  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const hit = (x: number, y: number, w: number) =>
    boxes.some((b) => x < b.x + b.w + 2 && x + w + 2 > b.x && y < b.y + b.h + 1 && y + 9 + 1 > b.y);

  const placed: Placed[] = [];
  // Place the widest movers first so the outliers keep their natural position.
  const order = [...rows].sort((a, b) => (b.vol90 || 0) - (a.vol90 || 0));
  for (const r of order) {
    if (!Number.isFinite(r.vol90) || !Number.isFinite(r.ret90Ann)) continue;
    const rawX = px(r.vol90);
    const rawY = py(r.ret90Ann);
    const x = clampX(rawX);
    const y = clampY(rawY);
    const w = r.sym.length * 5.3 + 2;
    const candidates: [number, number][] = [
      [x + 7, y + 3],
      [x - w - 7, y + 3],
      [x - w / 2, y - 8],
      [x - w / 2, y + 14],
      [x + 7, y - 9],
      [x - w - 7, y - 9],
      [x + 7, y + 15],
      [x - w - 7, y + 15],
      [x - w / 2, y - 20],
      [x - w / 2, y + 26],
    ];
    let lx = candidates[0][0];
    let ly = candidates[0][1];
    let found = false;
    for (const [cx, cy] of candidates) {
      const fx = Math.min(D.W - D.PAD.r - w, Math.max(D.PAD.l, cx));
      const fy = Math.min(D.H - D.PAD.b - 2, Math.max(D.PAD.t + 8, cy));
      if (!hit(fx, fy - 8, w)) {
        lx = fx;
        ly = fy;
        found = true;
        break;
      }
    }
    if (!found) {
      // Walk downward until a gap opens rather than stacking labels on top.
      let fy = y + 3;
      const fx = Math.min(D.W - D.PAD.r - w, Math.max(D.PAD.l, x + 7));
      for (let step = 0; step < 26 && hit(fx, fy - 8, w); step++) fy += 10;
      lx = fx;
      ly = Math.min(D.H - D.PAD.b - 2, fy);
    }
    boxes.push({ x: lx, y: ly - 8, w, h: 9 });
    placed.push({
      x,
      y,
      lx,
      ly,
      w,
      leader: Math.hypot(lx - x, ly - y) > 18,
      row: r,
      clamped: rawX !== x || rawY !== y,
    });
  }
  return { placed, xd, yd };
}

function ticks(d: [number, number], count = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(d[0] + ((d[1] - d[0]) * i) / count);
  return out;
}

function Scatter({ rows }: { rows: QuantRow[] }) {
  // Portrait below the point where the landscape chart stops fitting.
  const narrow = useNarrow(640);
  const D = narrow ? NARROW : WIDE;
  const { placed, xd, yd } = useMemo(() => layout(rows, D), [rows, D]);
  const btc = rows.find((r) => r.sym === "BTC");
  const px = (v: number) => D.PAD.l + ((v - xd[0]) / (xd[1] - xd[0])) * (D.W - D.PAD.l - D.PAD.r);
  const py = (v: number) => D.H - D.PAD.b - ((v - yd[0]) / (yd[1] - yd[0])) * (D.H - D.PAD.t - D.PAD.b);

  return (
    <div className="thin-scroll -mx-1 overflow-x-auto px-1">
      <svg
        viewBox={`0 0 ${D.W} ${D.H}`}
        width="100%"
        // No minimum width in portrait: it already fits, and a floor
        // would put the scrollbar back for nothing.
        style={{ minWidth: narrow ? undefined : 560, height: "auto" }}
        role="img"
        aria-label="Risk and return scatter: annualised 90 day return against annualised 90 day volatility"
      >
        {ticks(yd).map((v, i) => (
          <g key={`y${i}`}>
            <line
              x1={D.PAD.l}
              x2={D.W - D.PAD.r}
              y1={py(v)}
              y2={py(v)}
              stroke="var(--border2)"
              strokeWidth="1"
            />
            <text x={D.PAD.l - 6} y={py(v) + 3} textAnchor="end" fontSize="9" fill="var(--text3)" className="font-mono">
              {v.toFixed(0)}%
            </text>
          </g>
        ))}
        {ticks(xd).map((v, i) => (
          <g key={`x${i}`}>
            <line
              y1={D.PAD.t}
              y2={D.H - D.PAD.b}
              x1={px(v)}
              x2={px(v)}
              stroke="var(--border2)"
              strokeWidth="1"
            />
            <text x={px(v)} y={D.H - D.PAD.b + 14} textAnchor="middle" fontSize="9" fill="var(--text3)" className="font-mono">
              {v.toFixed(0)}%
            </text>
          </g>
        ))}

        {/* Quadrant lines at BTC: above and left of the cross beats holding BTC. */}
        {btc && Number.isFinite(btc.vol90) && (
          <line
            x1={px(btc.vol90)}
            x2={px(btc.vol90)}
            y1={D.PAD.t}
            y2={D.H - D.PAD.b}
            stroke="var(--accent)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.75"
          />
        )}
        {btc && Number.isFinite(btc.ret90Ann) && (
          <line
            y1={py(btc.ret90Ann)}
            y2={py(btc.ret90Ann)}
            x1={D.PAD.l}
            x2={D.W - D.PAD.r}
            stroke="var(--accent)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.75"
          />
        )}
        {btc && Number.isFinite(btc.vol90) && (
          <text
            x={Math.min(D.W - D.PAD.r - 4, px(btc.vol90) + 4)}
            y={D.PAD.t + 9}
            fontSize="9"
            fill="var(--accent)"
            className="font-mono"
          >
            BTC line
          </text>
        )}

        <rect
          x={D.PAD.l}
          y={D.PAD.t}
          width={D.W - D.PAD.l - D.PAD.r}
          height={D.H - D.PAD.t - D.PAD.b}
          fill="none"
          stroke="var(--border)"
        />

        {placed.map((p) => (
          <g key={p.row.sym}>
            {p.leader && (
              <line x1={p.x} y1={p.y} x2={p.lx + p.w / 2} y2={p.ly - 3} stroke="var(--text3)" strokeWidth="0.6" opacity="0.6" />
            )}
            <circle
              cx={p.x}
              cy={p.y}
              r={p.clamped ? 3 : 4}
              fill={p.row.ret90Ann >= 0 ? "var(--pos)" : "var(--neg)"}
              fillOpacity={p.clamped ? 0.45 : 0.85}
              stroke="var(--surface)"
              strokeWidth="0.8"
            >
              <title>{`${p.row.sym}: 90d annualised return ${pct(p.row.ret90Ann, 0)}, 90d annualised vol ${pctPlain(p.row.vol90, 0)}${p.clamped ? " (off scale, pinned to edge)" : ""}`}</title>
            </circle>
            <text x={p.lx} y={p.ly} fontSize="9" fill="var(--text2)" className="font-mono">
              {p.row.sym}
            </text>
          </g>
        ))}

        <text x={(D.W + D.PAD.l) / 2} y={D.H - 6} textAnchor="middle" fontSize="9" fill="var(--text3)" className="font-mono">
          annualised 90d volatility
        </text>
        <text
          x={-(D.H - D.PAD.b + D.PAD.t) / 2}
          y={12}
          transform="rotate(-90)"
          textAnchor="middle"
          fontSize="9"
          fill="var(--text3)"
          className="font-mono"
        >
          annualised 90d return
        </text>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ panel -- */

export function RiskMatrix() {
  const { data, loading, failed } = useApi<QuantPayload>("/api/quant", 900);
  const [sortKey, setSortKey] = useState<ColKey>("vol90");
  const [desc, setDesc] = useState(true);
  const rows = data?.rows ?? [];

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = Number.isFinite(a[sortKey]) ? a[sortKey] : -Infinity;
      const bv = Number.isFinite(b[sortKey]) ? b[sortKey] : -Infinity;
      return desc ? bv - av : av - bv;
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

  const body =
    loading ? (
      <Loading rows={8} />
    ) : failed || !rows.length ? (
      <Unavailable what="Risk statistics" />
    ) : (
      <>
        <Scatter rows={rows} />
        <div className="mt-4">
          <TableWrap maxHeight={460}>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className="num"
                    aria-sort={sortKey === c.key ? (desc ? "descending" : "ascending") : "none"}
                    title={c.hint}
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
                    <span className="inline-flex items-center gap-1.5 font-mono font-bold text-[var(--text)]"><TokenIcon sym={r.sym} />{r.sym}</span>{" "}
                    <span className="text-[11px] text-[var(--text3)]">{r.name}</span>
                  </td>
                  {COLS.map((c) => {
                    const v = r[c.key];
                    const color =
                      c.key === "sharpe" || c.key === "sortino"
                        ? Number.isFinite(v)
                          ? v >= 0
                            ? "var(--pos)"
                            : "var(--neg)"
                          : "var(--text3)"
                        : c.key === "mdd90" || c.key === "mdd365"
                          ? "var(--neg)"
                          : "var(--text2)";
                    return (
                      <td key={c.key} className="num" style={{ color }}>
                        {Number.isFinite(v) ? c.fmt(v) : NA}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </>
    );

  return (
    <Panel
      title="Risk matrix"
      hint="Daily closes from Binance spot. Volatility and drawdown are percent, annualised by sqrt(365) because crypto trades every day, and Sharpe takes the risk-free rate as zero."
      right={
        <div className="flex items-center gap-2">
          <AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />
        </div>
      }
    >
      {body}
    </Panel>
  );
}

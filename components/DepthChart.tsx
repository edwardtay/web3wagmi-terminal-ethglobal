"use client";

import { useMemo, useState } from "react";
import { AsOf, Loading, Panel, Segmented, Unavailable } from "@/components/ui";
import { useApi } from "@/lib/useApi";
import { price, pctPlain, usdCompact } from "@/lib/format";
import { BY_SYM, prettyPair } from "@/lib/symbols";
import { fmtSize, useOrderBook } from "@/lib/useOrderBook";

interface CurvePoint {
  p: number;
  d: number;
  q: number;
  n: number;
}

interface DepthPayload {
  ok: boolean;
  asOf: string;
  symbol: string;
  pair: string;
  mid: number | null;
  spreadBps: number | null;
  bidCurve: CurvePoint[];
  askCurve: CurvePoint[];
  totals: { levels: number; bidReachBps: number; askReachBps: number } | null;
}

const W = 320;
const H = 150;
const PAD_T = 10;
const PAD_B = 18;
const CX = W / 2;

type RangeKey = "10" | "50" | "200" | "all";

const RANGES: { value: RangeKey; label: string }[] = [
  { value: "10", label: "10 bps" },
  { value: "50", label: "50 bps" },
  { value: "200", label: "200 bps" },
  { value: "all", label: "Full" },
];

interface Hover {
  x: number;
  y: number;
  side: "bid" | "ask";
  point: CurvePoint;
}

export function DepthChart({ symbol = "BTC" }: { symbol?: string }) {
  const sym = symbol.toUpperCase();
  const asset = BY_SYM[sym];
  const pair = asset?.pair ?? "BTCUSDT";
  // 50 bps clamps to whatever the snapshot actually reaches, so BTC shows its
  // full 15 bps of book while a thin pair does not get lost in a 60% tail.
  const [range, setRange] = useState<RangeKey>("50");
  const [hover, setHover] = useState<Hover | null>(null);

  // The snapshot carries 500 levels a side, far deeper than the 20-level
  // stream, so the curve keeps its shape. The live book supplies the mid only.
  const { data, loading, failed } = useApi<DepthPayload>(`/api/depth?symbol=${sym}`, 15);
  const { book } = useOrderBook(pair);
  const liveMid = book ? (book.bids[0].price + book.asks[0].price) / 2 : null;

  // useApi keeps the previous payload across a key change, so on a symbol
  // switch the old market's numbers would sit under the new title until the
  // fetch lands. The payload names its own symbol, so hold the loading state.
  const stale = data != null && data.symbol !== sym;

  const view = useMemo(() => {
    if (!data?.ok || data.symbol !== sym || !data.mid || !data.bidCurve?.length || !data.askCurve?.length) return null;
    const mid = data.mid;
    const reach = Math.min(
      Math.abs(data.bidCurve[data.bidCurve.length - 1].d),
      data.askCurve[data.askCurve.length - 1].d
    );
    const maxBps = range === "all" ? reach : Math.min(Number(range), reach);
    if (!(maxBps > 0)) return null;

    const clip = (pts: CurvePoint[]) => pts.filter((pt) => Math.abs(pt.d) <= maxBps);
    const bids = clip(data.bidCurve);
    const asks = clip(data.askCurve);
    if (!bids.length || !asks.length) return null;

    const yMax = Math.max(bids[bids.length - 1].n, asks[asks.length - 1].n);
    const xFor = (d: number) => CX + (d / maxBps) * (CX - 2);
    const yFor = (n: number) => H - PAD_B - (yMax > 0 ? n / yMax : 0) * (H - PAD_T - PAD_B);

    const pathFor = (pts: CurvePoint[]) => {
      const line = pts.map((pt) => `${xFor(pt.d).toFixed(1)},${yFor(pt.n).toFixed(1)}`);
      // Start at the mid with zero depth so both curves meet at the spread.
      return [`${CX.toFixed(1)},${yFor(0).toFixed(1)}`, ...line];
    };

    const bidPts = pathFor(bids);
    const askPts = pathFor(asks);
    const base = (H - PAD_B).toFixed(1);
    const area = (pts: string[]) =>
      `M ${pts[0].split(",")[0]},${base} L ${pts.join(" L ")} L ${pts[pts.length - 1].split(",")[0]},${base} Z`;

    const bidNotional = bids[bids.length - 1].n;
    const askNotional = asks[asks.length - 1].n;
    const total = bidNotional + askNotional;

    return {
      mid,
      maxBps,
      bids,
      asks,
      yMax,
      xFor,
      yFor,
      bidLine: `M ${bidPts.join(" L ")}`,
      askLine: `M ${askPts.join(" L ")}`,
      bidArea: area(bidPts),
      askArea: area(askPts),
      bidNotional,
      askNotional,
      bidShare: total > 0 ? (bidNotional / total) * 100 : 50,
      bidQty: bids[bids.length - 1].q,
      askQty: asks[asks.length - 1].q,
    };
  }, [data, range, sym]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const d = ((sx - CX) / (CX - 2)) * view.maxBps;
    const side = d < 0 ? "bid" : "ask";
    const pts = side === "bid" ? view.bids : view.asks;
    let best = pts[0];
    for (const pt of pts) if (Math.abs(pt.d - d) < Math.abs(best.d - d)) best = pt;
    setHover({ x: view.xFor(best.d), y: view.yFor(best.n), side, point: best });
  }

  return (
    <Panel
      title={`Depth · ${prettyPair(pair)}`}
      right={
        <div className="flex items-center gap-2">
          <Segmented<RangeKey> options={RANGES} value={range} onChange={setRange} ariaLabel="Depth range from mid" />
          <AsOf iso={stale ? undefined : data?.asOf} staleMs={60_000} />
        </div>
      }
    >
      {(loading || stale) && <Loading rows={5} />}
      {!loading && !stale && (failed || !view) && <Unavailable what="The depth curve" />}

      {view && (
        <>
          <div className="relative">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full touch-none"
              role="img"
              aria-label={`Cumulative depth within ${view.maxBps.toFixed(0)} basis points of the mid: ${usdCompact(
                view.bidNotional
              )} bid, ${usdCompact(view.askNotional)} ask`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              <path d={view.bidArea} fill="var(--pos-soft)" />
              <path d={view.askArea} fill="var(--neg-soft)" />
              <path d={view.bidLine} fill="none" stroke="var(--pos)" strokeWidth="1.6" strokeLinejoin="round" />
              <path d={view.askLine} fill="none" stroke="var(--neg)" strokeWidth="1.6" strokeLinejoin="round" />
              <line
                x1={CX}
                y1={PAD_T - 6}
                x2={CX}
                y2={H - PAD_B}
                stroke="var(--text3)"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
              <line x1="0" y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
              {hover && (
                <>
                  <line
                    x1={hover.x}
                    y1={PAD_T - 6}
                    x2={hover.x}
                    y2={H - PAD_B}
                    stroke="var(--text3)"
                    strokeWidth="0.8"
                  />
                  <circle
                    cx={hover.x}
                    cy={hover.y}
                    r="2.6"
                    fill={hover.side === "bid" ? "var(--pos)" : "var(--neg)"}
                  />
                </>
              )}
              <text x="3" y={H - 6} fill="var(--text3)" fontSize="7" fontFamily="monospace">
                {price(view.mid * (1 - view.maxBps / 10_000))}
              </text>
              <text x={CX} y={H - 6} fill="var(--text3)" fontSize="7" fontFamily="monospace" textAnchor="middle">
                mid {price(view.mid)}
              </text>
              <text x={W - 3} y={H - 6} fill="var(--text3)" fontSize="7" fontFamily="monospace" textAnchor="end">
                {price(view.mid * (1 + view.maxBps / 10_000))}
              </text>
              <text x="3" y={PAD_T - 2} fill="var(--text3)" fontSize="7" fontFamily="monospace">
                {usdCompact(view.yMax)} cum
              </text>
            </svg>

            {hover && (
              <div
                className="pointer-events-none absolute z-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-[10px] leading-snug text-[var(--text2)] shadow-[var(--shadow-lg)]"
                style={{
                  left: `${Math.min(88, Math.max(4, (hover.x / W) * 100))}%`,
                  top: `${(hover.y / H) * 100}%`,
                  transform: "translate(-50%, -115%)",
                }}
              >
                <div className="font-bold text-[var(--text)]">{price(hover.point.p)}</div>
                <div style={{ color: hover.side === "bid" ? "var(--pos)" : "var(--neg)" }}>
                  {hover.side === "bid" ? "bid" : "ask"} {Math.abs(hover.point.d).toFixed(1)} bps from mid
                </div>
                <div>
                  {fmtSize(hover.point.q)} cum · {usdCompact(hover.point.n)}
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2">
              <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text3)]">Bid depth</div>
              <div className="mt-0.5 font-bold" style={{ color: "var(--pos)" }}>
                {usdCompact(view.bidNotional)}
              </div>
              <div className="text-[10px] text-[var(--text3)]">{fmtSize(view.bidQty)} base</div>
            </div>
            <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2">
              <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text3)]">Ask depth</div>
              <div className="mt-0.5 font-bold" style={{ color: "var(--neg)" }}>
                {usdCompact(view.askNotional)}
              </div>
              <div className="text-[10px] text-[var(--text3)]">{fmtSize(view.askQty)} base</div>
            </div>
          </div>

          <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
            <div style={{ width: `${view.bidShare}%`, background: "var(--pos)" }} />
            <div style={{ width: `${100 - view.bidShare}%`, background: "var(--neg)" }} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] text-[var(--text3)]">
            <span>
              {pctPlain(view.bidShare)} of depth on the bid within {view.maxBps.toFixed(0)} bps
            </span>
            <span className="flex items-center gap-1">
              {liveMid != null && <span>live mid {price(liveMid)}</span>}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

export default DepthChart;

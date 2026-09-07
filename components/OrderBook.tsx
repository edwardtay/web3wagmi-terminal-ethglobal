"use client";

import { useMemo } from "react";
import { Loading, LivePill, Meter, Panel, Unavailable } from "@/components/ui";
import { price, pctPlain, usdCompact } from "@/lib/format";
import { BY_SYM, prettyPair } from "@/lib/symbols";
import { fmtSize, useOrderBook, type Level } from "@/lib/useOrderBook";

const ROWS = 15;

function cumulate(levels: Level[]): { level: Level; cum: number }[] {
  let cum = 0;
  return levels.map((level) => {
    cum += level.qty;
    return { level, cum };
  });
}

/** Depth shading, anchored to the right edge so both sides read from the mid. */
function shade(cum: number, max: number, color: string): string {
  const w = max > 0 ? Math.min(100, (cum / max) * 100) : 0;
  return `linear-gradient(to left, ${color} 0 ${w.toFixed(1)}%, transparent ${w.toFixed(1)}%)`;
}

export function OrderBook({ symbol = "BTC" }: { symbol?: string }) {
  const asset = BY_SYM[symbol.toUpperCase()];
  const pair = asset?.pair ?? "BTCUSDT";
  const base = asset?.sym ?? symbol.toUpperCase();
  const { book, status } = useOrderBook(pair);

  const view = useMemo(() => {
    if (!book || !book.bids.length || !book.asks.length) return null;
    const bids = cumulate(book.bids.slice(0, ROWS));
    const asks = cumulate(book.asks.slice(0, ROWS));
    const maxCum = Math.max(bids[bids.length - 1]?.cum ?? 0, asks[asks.length - 1]?.cum ?? 0);
    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    // Notional, not base size: it is the money resting on each side, which is
    // what the two sides can be compared on.
    const bidNotional = book.bids.reduce((s, l) => s + l.price * l.qty, 0);
    const askNotional = book.asks.reduce((s, l) => s + l.price * l.qty, 0);
    const total = bidNotional + askNotional;
    return {
      bids,
      asks,
      maxCum,
      mid,
      spread,
      spreadBps: (spread / mid) * 10_000,
      bidNotional,
      askNotional,
      bidShare: total > 0 ? (bidNotional / total) * 100 : 50,
      levels: Math.min(book.bids.length, book.asks.length),
    };
  }, [book]);

  return (
    <Panel
      title={`Order book · ${prettyPair(pair)}`}
      right={<LivePill live={status.connected} label={status.connected ? "live" : book ? "stale" : "off"} />}
    >
      {!view && status.failed && <Unavailable what="The order book" />}
      {!view && !status.failed && <Loading rows={8} />}

      {view && (
        <>
          <div className="thin-scroll overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full border-collapse font-mono text-[11px]">
              <caption className="sr-only">{`${prettyPair(pair)} order book, ${ROWS} levels each side`}</caption>
              <thead>
                <tr className="bg-[var(--surface2)] text-[9px] uppercase tracking-[0.08em] text-[var(--text3)]">
                  <th scope="col" className="px-2 py-1 text-left font-bold">
                    Price
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-bold">
                    Size ({base})
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-bold">
                    Cum
                  </th>
                </tr>
              </thead>

              <tbody>
                {/* Best ask sits closest to the mid, so the stack reads downwards. */}
                {[...view.asks].reverse().map(({ level, cum }) => (
                  <tr key={`a${level.price}`} style={{ background: shade(cum, view.maxCum, "var(--neg-soft)") }}>
                    <td className="px-2 py-px leading-[1.35] text-left tabular-nums" style={{ color: "var(--neg)" }}>
                      {price(level.price)}
                    </td>
                    <td className="px-2 py-px leading-[1.35] text-right tabular-nums text-[var(--text2)]">{fmtSize(level.qty)}</td>
                    <td className="px-2 py-px leading-[1.35] text-right tabular-nums text-[var(--text3)]">{fmtSize(cum)}</td>
                  </tr>
                ))}
              </tbody>

              <tbody>
                <tr className="border-y border-[var(--border)] bg-[var(--surface2)]">
                  <td colSpan={3} className="px-2 py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="text-sm font-bold tabular-nums text-[var(--text)]">{price(view.mid)}</span>
                      <span className="flex items-center gap-1 text-[10px] text-[var(--text3)]">
                        spread {price(view.spread)} · {view.spreadBps.toFixed(1)} bps
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>

              <tbody>
                {view.bids.map(({ level, cum }) => (
                  <tr key={`b${level.price}`} style={{ background: shade(cum, view.maxCum, "var(--pos-soft)") }}>
                    <td className="px-2 py-px leading-[1.35] text-left tabular-nums" style={{ color: "var(--pos)" }}>
                      {price(level.price)}
                    </td>
                    <td className="px-2 py-px leading-[1.35] text-right tabular-nums text-[var(--text2)]">{fmtSize(level.qty)}</td>
                    <td className="px-2 py-px leading-[1.35] text-right tabular-nums text-[var(--text3)]">{fmtSize(cum)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3">
            <Meter
              label={`Bid share of top-${view.levels} notional`}
              score={view.bidShare}
              caption={`${usdCompact(view.bidNotional)} bid vs ${usdCompact(view.askNotional)} ask · ${pctPlain(
                view.bidShare
              )} / ${pctPlain(100 - view.bidShare)} across ${view.levels} levels a side`}
            />
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--text3)]">
              <span>Above 50% means more money resting on the bid than the offer.</span>
            </div>
          </div>

          {book?.src === "rest" && (
            <div className="mt-2 text-[10px] text-[var(--text3)]">Snapshot seed, waiting on the live stream.</div>
          )}
        </>
      )}
    </Panel>
  );
}

export default OrderBook;

"use client";

import { useEffect, useMemo, useRef } from "react";
import { Loading, LivePill, Panel, TableWrap, Unavailable } from "@/components/ui";
import { clockTime, pctPlain, price, usdCompact } from "@/lib/format";
import { BY_SYM, prettyPair } from "@/lib/symbols";
import { fmtSize, useTradeTape } from "@/lib/useOrderBook";

/** Nothing under this counts as a whale, however quiet the pair is. */
const MIN_LARGE_USD = 10_000;

export function TradeTape({ symbol = "BTC" }: { symbol?: string }) {
  const asset = BY_SYM[symbol.toUpperCase()];
  const pair = asset?.pair ?? "BTCUSDT";
  const base = asset?.sym ?? symbol.toUpperCase();
  const { prints, status } = useTradeTape(pair);

  // Only prints newer than the last committed render flash, so the whole tape
  // does not re-animate every time a row is added.
  const seenRef = useRef(0);
  const seenAtRender = seenRef.current;
  useEffect(() => {
    if (prints.length) seenRef.current = Math.max(seenRef.current, prints[0].id);
  }, [prints]);

  const stats = useMemo(() => {
    if (!prints.length) return null;
    let buy = 0;
    let sell = 0;
    const notionals: number[] = [];
    for (const p of prints) {
      const n = p.price * p.qty;
      notionals.push(n);
      if (p.buy) buy += n;
      else sell += n;
    }
    const total = buy + sell;
    const sorted = [...notionals].sort((a, b) => a - b);
    // 95th percentile of the visible window: it adapts to the pair's usual clip
    // size, so a $200 print flags on a thin alt but not on BTC.
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      buy,
      sell,
      total,
      buyShare: total > 0 ? (buy / total) * 100 : 50,
      large: Math.max(MIN_LARGE_USD, p95),
      windowMs: prints[0].ts - prints[prints.length - 1].ts,
    };
  }, [prints]);

  const seconds = stats ? Math.max(1, Math.round(stats.windowMs / 1000)) : 0;

  return (
    <Panel
      title={`Trade tape · ${prettyPair(pair)}`}
      right={<LivePill live={status.connected} label={status.connected ? "live" : prints.length ? "stale" : "off"} />}
    >
      {!prints.length && status.failed && <Unavailable what="The trade tape" />}
      {!prints.length && !status.failed && <Loading rows={6} />}

      {prints.length > 0 && stats && (
        <>
          <div className="mb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
              <span className="font-mono font-semibold" style={{ color: "var(--pos)" }}>
                buy {usdCompact(stats.buy)}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-[var(--text3)]">
                last {prints.length} prints · {seconds}s
              </span>
              <span className="font-mono font-semibold" style={{ color: "var(--neg)" }}>
                {usdCompact(stats.sell)} sell
              </span>
            </div>
            <div
              className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface2)]"
              role="img"
              aria-label={`Taker buy ${pctPlain(stats.buyShare)} of ${usdCompact(stats.total)} traded`}
            >
              <div style={{ width: `${stats.buyShare}%`, background: "var(--pos)" }} />
              <div style={{ width: `${100 - stats.buyShare}%`, background: "var(--neg)" }} />
            </div>
            <div className="mt-1 flex flex-wrap justify-between gap-x-2 text-[10px] text-[var(--text3)]">
              <span>{pctPlain(stats.buyShare)} taker buy</span>
              <span>
                large print: {usdCompact(stats.large)}+
              </span>
            </div>
          </div>

          <TableWrap maxHeight={340} tight>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col" className="num">
                  Price
                </th>
                <th scope="col" className="num">
                  Size ({base})
                </th>
                <th scope="col" className="num">
                  Notional
                </th>
              </tr>
            </thead>
            <tbody>
              {prints.map((p) => {
                const notional = p.price * p.qty;
                const big = notional >= stats.large;
                const fresh = p.id > seenAtRender;
                return (
                  <tr
                    key={p.id}
                    className={fresh ? (p.buy ? "flash-up" : "flash-down") : undefined}
                    style={big ? { boxShadow: "inset 2px 0 0 var(--gold)" } : undefined}
                  >
                    <td className="whitespace-nowrap py-px leading-[1.35] font-mono text-[10px] text-[var(--text3)]">
                      {clockTime(p.ts)}
                    </td>
                    <td className="num py-px leading-[1.35]" style={{ color: p.buy ? "var(--pos)" : "var(--neg)" }}>
                      {price(p.price)}
                    </td>
                    <td className="num py-px leading-[1.35] text-[var(--text2)]">{fmtSize(p.qty)}</td>
                    <td
                      className="num py-px leading-[1.35]"
                      style={{ color: big ? "var(--gold)" : "var(--text2)", fontWeight: big ? 700 : 400 }}
                      title={big ? "Large print, top 5% of the visible window" : undefined}
                    >
                      {usdCompact(notional)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        </>
      )}
    </Panel>
  );
}

export default TradeTape;

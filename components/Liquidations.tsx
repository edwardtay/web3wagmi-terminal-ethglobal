"use client";

import { useEffect, useMemo, useState } from "react";
import { BarCell, InfoHint, LivePill, Panel, Section, Segmented, TableWrap, Th, Unavailable } from "@/components/ui";
import { clockTime, compact, pctPlain, price, usdCompact } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { unitOf, useLiquidations, type LiqEvent } from "@/lib/useLiquidations";

type Filter = "all" | "10k" | "100k";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "10k", label: "$10k+" },
  { value: "100k", label: "$100k+" },
];


/** Long liquidations read red (forced selling), shorts read green. */
function sideColor(side: LiqEvent["side"]): string {
  return side === "long" ? "var(--neg)" : "var(--pos)";
}

interface HlLiq {
  at: string;
  coin: string;
  direction: string;
  notional: number;
  price: number;
  user: string;
}

/** The venue's own event names, in the terminal's words, without renaming them. */
function readDirection(d: string): { label: string; sells: boolean } {
  const long = d.includes("LONG");
  return {
    label: d.startsWith("LIQUIDATED") ? (long ? "long liquidated" : "short liquidated") : long ? "long closed" : "short closed",
    // A long leaving is supply hitting the book either way it is labelled.
    sells: long,
  };
}

/**
 * Hyperliquid liquidations, from The Graph.
 *
 * The panel above is Binance's force-order websocket, which means one venue and
 * an empty table every time the tab opens. This is the on-chain side of the
 * same event, indexed, so it is there on load, it covers the largest DEX perp
 * venue, and it carries the liquidated address rather than an anonymous print.
 */
function OnchainLiquidations() {
  const { data } = useApi<{ hlLiquidations?: HlLiq[] }>("/api/derivs", 180);
  const rows = data?.hlLiquidations ?? [];
  if (rows.length === 0) return null;

  const total = rows.reduce((a, r) => a + r.notional, 0);
  const sells = rows.filter((r) => readDirection(r.direction).sells).reduce((a, r) => a + r.notional, 0);

  return (
    <Panel
      title="Hyperliquid, largest 24h"
      hint="Indexed on chain, so unlike the stream above it is present on load and covers the largest DEX perp venue."
      right={
        <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
          {usdCompact(total)} across {rows.length}
        </span>
      }
    >
      <div className="mb-2 font-mono text-[11px] text-[var(--text3)]">
        {total > 0 ? `${Math.round((sells / total) * 100)}% of it longs` : ""}
      </div>
      <TableWrap maxHeight={220} tight>
        <thead>
          <tr>
            <th className="ident">Coin</th>
            <Th label="Event" hint="The venue's own event name, kept rather than renamed." />
            <th className="num">Notional</th>
            <th className="num">Price</th>
            <Th label="Account" hint="The liquidated account. A CEX print has no address." />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = readDirection(r.direction);
            return (
              <tr key={`${r.at}-${r.coin}-${r.notional}`}>
                <td className="font-semibold text-[var(--text)]">{r.coin}</td>
                <td style={{ color: d.sells ? "var(--neg)" : "var(--pos)" }}>{d.label}</td>
                <td className="num font-semibold text-[var(--text)]">{usdCompact(r.notional)}</td>
                <td className="num text-[var(--text2)]">{usdCompact(r.price)}</td>
                <td className="font-mono text-[10px] text-[var(--text3)]" title={r.user}>
                  {r.user.slice(0, 6)}...{r.user.slice(-4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </Panel>
  );
}

export function Liquidations() {
  const liq = useLiquidations();
  const [filter, setFilter] = useState<Filter>("all");

  // sessionStart comes from Date.now() in the hook, so it differs between the
  // server render and the client. Hold the label back until after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const rows = filter === "all" ? liq.tape.all : filter === "10k" ? liq.tape.t10k : liq.tape.t100k;
  const maxUsd = useMemo(() => rows.reduce((m, e) => Math.max(m, e.usd), 0), [rows]);

  const total = liq.longUsd + liq.shortUsd;
  const longShare = total > 0 ? (liq.longUsd / total) * 100 : 50;
  const topSymbols = liq.bySymbol.slice(0, 10);
  const topMax = topSymbols[0]?.totalUsd ?? 0;

  const live = liq.status === "live";
  const waiting = liq.count === 0;

  return (
    <Section
      title="Liquidations"
      id="liquidations"
      right={
        <>
          {mounted && (
            <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
              session from {clockTime(liq.sessionStart)}
            </span>
          )}
          {/* "live" alone. The pill already carries a pulsing dot and the word
              stream added a word without adding a fact: every other panel's
              pill says how fresh it is, not by what transport it arrived. */}
          <LivePill live={live} label={live ? "live" : liq.status === "connecting" ? "connecting" : "reconnecting"} />
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.45fr_1fr]">
        {/* ------------------------------------------------------- the tape -- */}
        <Panel
          title="Force order tape"
          right={<Segmented<Filter> options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Minimum notional" />}
        >
          {liq.status === "down" && waiting ? (
            <Unavailable what="The Binance liquidation stream" />
          ) : rows.length === 0 ? (
            <div className="py-8 text-center font-mono text-[11px] leading-relaxed text-[var(--text3)]">
              {waiting ? "Waiting for the first print." : `No print above ${filter === "10k" ? "$10k" : "$100k"} yet.`}
              <div className="mt-1">Quiet markets can go minutes without a liquidation.</div>
            </div>
          ) : (
            <TableWrap maxHeight={430} tight>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col" className="ident">Symbol</th>
                  <th scope="col">
                    Side
                    <span className="ml-1 inline-block align-middle">
                      <InfoHint text="A SELL print means a long was liquidated." />
                    </span>
                  </th>
                  <th scope="col" className="num">
                    Notional
                  </th>
                  <th scope="col" className="num">
                    Price
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  // Rows are keyed by event id, so a new row mounts and runs the
                  // flash once. Existing rows keep the class without replaying.
                  const heavy = maxUsd > 0 && e.usd >= maxUsd * 0.45;
                  return (
                    <tr key={e.id} className={e.side === "long" ? "flash-down" : "flash-up"}>
                      <td className="num text-[var(--text3)]">{clockTime(e.ts)}</td>
                      <td className="font-mono font-semibold text-[var(--text)]">
                        {e.base}
                        {e.symbol !== `${e.base}USDT` && (
                          <span className="ml-1 font-normal text-[var(--text3)]">{e.symbol}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className="whitespace-nowrap font-mono text-[10px] font-bold uppercase tracking-wider"
                          style={{ color: sideColor(e.side) }}
                        >
                          {e.side === "long" ? "long liquidated" : "short liquidated"}
                        </span>
                      </td>
                      <td className="num" style={{ minWidth: 92 }}>
                        <div
                          className={heavy ? "text-[13px] font-bold" : "font-semibold"}
                          style={{ color: heavy ? sideColor(e.side) : "var(--text)" }}
                        >
                          {usdCompact(e.usd, e.usd >= 1e6 ? 2 : 1)}
                        </div>
                        <div className="mt-1">
                          <BarCell value={e.usd} max={maxUsd} color={sideColor(e.side)} />
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--text3)]">{compact(e.qty, 2)} {unitOf(e.symbol)}</div>
                      </td>
                      <td className="num text-[var(--text2)]">{price(e.price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          )}
          <div className="mt-2 font-mono text-[10px] text-[var(--text3)]">
            Showing the last {rows.length} print{rows.length === 1 ? "" : "s"} in this filter. Buffer only, nothing is
            kept across a reload.
          </div>
        </Panel>

        {/* ---------------------------------------------------- the summary -- */}
        <Panel
          title="This session"
        >
          {waiting ? (
            <div className="py-8 text-center font-mono text-[11px] leading-relaxed text-[var(--text3)]">
              Waiting for the first print.
              <div className="mt-1">Totals start at zero on every page load.</div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* opposed long vs short bar */}
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] font-bold" style={{ color: "var(--neg)" }}>
                    {usdCompact(liq.longUsd)}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text3)]">
                    longs vs shorts
                  </span>
                  <span className="font-mono text-[11px] font-bold" style={{ color: "var(--pos)" }}>
                    {usdCompact(liq.shortUsd)}
                  </span>
                </div>
                <div
                  className="mt-1.5 flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]"
                  role="img"
                  aria-label={`Longs liquidated ${pctPlain(longShare)} of session notional`}
                >
                  <div style={{ width: `${longShare}%`, background: "var(--neg)" }} />
                  <div style={{ width: `${100 - longShare}%`, background: "var(--pos)" }} />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--text3)]">
                  <span>{pctPlain(longShare)} longs</span>
                  <span>{liq.count.toLocaleString("en-US")} prints · {usdCompact(total)} total</span>
                  <span>{pctPlain(100 - longShare)} shorts</span>
                </div>
              </div>

              {/* largest single print */}
              {liq.largest && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text3)]">
                      Largest print
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span
                      className="font-mono text-lg font-bold"
                      style={{ color: sideColor(liq.largest.side) }}
                    >
                      {usdCompact(liq.largest.usd)}
                    </span>
                    <span className="font-mono text-xs font-semibold text-[var(--text)]">{liq.largest.base}</span>
                    <span
                      className="font-mono text-[10px] font-bold uppercase tracking-wider"
                      style={{ color: sideColor(liq.largest.side) }}
                    >
                      {liq.largest.side === "long" ? "long liquidated" : "short liquidated"}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
                    {clockTime(liq.largest.ts)} at {price(liq.largest.price)}
                  </div>
                </div>
              )}

              {/* top symbols by liquidated notional */}
              <div>
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text3)]">
                  Top symbols by liquidated notional
                </div>
                <TableWrap maxHeight={300}>
                  <thead>
                    <tr>
                      <th scope="col" className="ident">Symbol</th>
                      <th scope="col">Long / short split</th>
                      <th scope="col" className="num">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSymbols.map((r) => {
                      const share = r.totalUsd > 0 ? (r.longUsd / r.totalUsd) * 100 : 50;
                      const width = topMax > 0 ? Math.max(4, (r.totalUsd / topMax) * 100) : 0;
                      return (
                        <tr key={r.symbol}>
                          <td className="font-mono font-semibold text-[var(--text)]">{r.base}</td>
                          <td style={{ minWidth: 90 }}>
                            <div
                              className="flex h-2 overflow-hidden rounded-full bg-[var(--surface2)]"
                              style={{ width: `${width}%` }}
                              role="img"
                              aria-label={`${r.base}: ${pctPlain(share)} longs`}
                            >
                              <div style={{ width: `${share}%`, background: "var(--neg)" }} />
                              <div style={{ width: `${100 - share}%`, background: "var(--pos)" }} />
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
                              {r.count} print{r.count === 1 ? "" : "s"} · {pctPlain(share)} long
                            </div>
                          </td>
                          <td className="num font-semibold text-[var(--text)]">{usdCompact(r.totalUsd, 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableWrap>
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-3">
        <OnchainLiquidations />
      </div>
    </Section>
  );
}

"use client";

import { useApi } from "@/lib/useApi";
import { AsOf, ChangeChip, InfoHint, Loading, Panel, Sparkline, TableWrap, Th, Unavailable, TokenIcon, useSort } from "@/components/ui";
import { pct, pctPlain, num, usdCompact, signColor, NA } from "@/lib/format";
import { useSymbol } from "@/lib/useSymbol";

// The regime read is only valid on contract count. Notional open interest rises
// whenever price rises, so a USD-based read would call every rally "new longs".

// Open interest with the price move attached. OI alone says how much leverage
// is on; paired with the direction of price it says who is putting it on.

type Regime = "new longs" | "new shorts" | "short covering" | "long liquidation";

interface OiRow {
  sym: string;
  name: string;
  perp: string;
  oiUsd: number;
  /** 24h change in contract count, which is what the regime is read from. */
  oiChangePct: number | null;
  /** 24h change in notional, which moves with price as well as positioning. */
  oiUsdChangePct: number | null;
  hlOi: number | null;
  hlOiChangePct: number | null;
  venues: { venue: string; usd: number }[];
  priceChangePct: number | null;
  regime: Regime | null;
  series: number[];
}

interface RatioRow {
  sym: string;
  retailLong: number;
  retailShort: number;
  topLong: number;
  topShort: number;
  retailRatio: number;
  topRatio: number;
}

interface Payload {
  ok: boolean;
  asOf: string;
  oi: OiRow[];
  ratios: RatioRow[];
  totalOiUsd: number;
  totalOiChangePct: number | null;
}

const REGIME_COLOR: Record<Regime, string> = {
  "new longs": "var(--pos)",
  "new shorts": "var(--neg)",
  "short covering": "var(--cyan)",
  "long liquidation": "var(--gold)",
};



function RegimeTag({ r }: { r: Regime | null }) {
  if (!r) return <span className="text-[var(--text3)]">{NA}</span>;
  const c = REGIME_COLOR[r];
  return (
    <span
      className="inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}
    >
      {r}
    </span>
  );
}

/** Long share against short share as one split bar, so the skew reads instantly. */
function SplitBar({ label, long, short, ratio }: { label: string; long: number; short: number; ratio: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-[var(--text2)]">{label}</span>
        <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
          {pctPlain(long, 1)} long · {num(ratio, 2)}x
        </span>
      </div>
      <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
        <div style={{ width: `${Math.max(0, Math.min(100, long))}%`, background: "var(--pos)" }} />
        <div style={{ width: `${Math.max(0, Math.min(100, short))}%`, background: "var(--neg)" }} />
      </div>
    </div>
  );
}

/**
 * A venue's colour, fixed across every row so the bars can be read down the
 * column rather than one at a time.
 */
const VENUE_COLOR: Record<string, string> = {
  Binance: "var(--venue-1)",
  Bybit: "var(--venue-2)",
  OKX: "var(--venue-3)",
  Hyperliquid: "var(--venue-4)",
};

/**
 * Where the open interest actually sits, as one bar.
 *
 * A column per venue was the obvious move and the wrong one: it makes the
 * table wider on the screen that can least afford it, and a reader comparing
 * four numbers across four columns is doing the arithmetic the panel should
 * have done. The question is which venue carries the risk, and a share bar
 * answers it without being read.
 */
function VenueBar({ venues }: { venues: { venue: string; usd: number }[] }) {
  const total = venues.reduce((a, v) => a + v.usd, 0);
  if (!total) return <span className="text-[var(--text3)]">n/a</span>;
  return (
    <span
      className="flex h-2.5 w-full min-w-[70px] overflow-hidden rounded-sm"
      title={venues.map((v) => `${v.venue} ${usdCompact(v.usd, 1)} (${((v.usd / total) * 100).toFixed(0)}%)`).join(" · ")}
    >
      {venues.map((v) => (
        <span
          key={v.venue}
          style={{ width: `${(v.usd / total) * 100}%`, background: VENUE_COLOR[v.venue] ?? "var(--border)" }}
        />
      ))}
    </span>
  );
}

export function OpenInterest() {
  // The focused instrument reads as a marked row here rather than filtering the
  // table, since the ranking against everything else is the point of the panel.
  const { symbol: focus } = useSymbol();

  const { data, loading, failed } = useApi<Payload>("/api/derivs", 60);
  const rows = data?.oi ?? [];
  // Opens on size, which is the question this board is asked first: where is
  // the most at stake if it unwinds.
  const sort = useSort(rows, { key: "oiUsd", dir: "desc" });
  const ratios = data?.ratios ?? [];

  return (
    <Panel
      right={<AsOf iso={data?.asOf} staleMs={15 * 60 * 1000} />}
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !rows.length ? (
        <Unavailable what="Open interest" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text3)]">
                Total open interest, tracked perps (Binance USDT)
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--text)]">
                  {usdCompact(data?.totalOiUsd, 2)}
                </span>
                <ChangeChip value={data?.totalOiChangePct ?? null} />
                <span className="text-[11px] text-[var(--text3)]">24h</span>
              </div>
              {/* The bar is unreadable without this, and a colour named once at
                  the top beats a tooltip repeated on every row. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text3)]">
                <span>across venues</span>
                {Object.entries(VENUE_COLOR).map(([venue, color]) => (
                  <span key={venue} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
                    {venue}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text3)]">
              {(Object.keys(REGIME_COLOR) as Regime[]).map((r) => (
                <span key={r} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: REGIME_COLOR[r] }} />
                  {r}
                </span>
              ))}
            </div>
          </div>

          <TableWrap maxHeight={440}>
            <thead>
              <tr>
                <Th label="Perp" sortKey="sym" sort={sort} />
                <Th
                  label="OI (USD)"
                  num
                  sortKey="oiUsd"
                  sort={sort}
                  hint="Binance notional. Size, not direction: it says what is at stake if it unwinds, not which way."
                />
                <Th
                  label="Across venues"
                  hint="Share of notional by venue, largest first: Binance, Bybit, OKX and Hyperliquid. Dollars rather than contracts, because a contract is a different size on each venue and the small caps carry a 1000x wrapper on some of them, so counts cannot be added across venues. Hover for the split."
                />
                <Th
                  label="OI 24h, contracts"
                  num
                  sortKey="oiChangePct"
                  sort={sort}
                  hint="Drives the regime. Contracts, not dollars: notional rises with price and would call every rally new longs."
                />
                <Th
                  label="OI 24h, USD"
                  num
                  sortKey="oiUsdChangePct"
                  sort={sort}
                  hint="Carries the price move inside it, so it only agrees with contracts when price is flat."
                />
                <Th
                  label="Price 24h"
                  num
                  sortKey="priceChangePct"
                  sort={sort}
                  hint="The regime is the sign of this and contracts together, not either alone."
                />
                <Th
                  label="HL 1h"
                  num
                  sortKey="hlOiChangePct"
                  sort={sort}
                  hint="Hyperliquid open interest, in contracts, over the last hourly bar. The onchain venue, so it can move against the centralised one. A dash means Hyperliquid does not list the coin, not that the reading is zero."
                />
                <Th
                  label="Regime"
                  sortKey="regime"
                  sort={sort}
                  hint="From the sign pair of contracts and price. It says what the book did, not what it will do."
                />
                <Th
                  label="OI 48h"
                  num
                  hint="Whether the 24h move continues or reverses the day before."
                />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.perp} style={r.sym === focus ? { boxShadow: "inset 3px 0 0 0 var(--accent2)" } : undefined}>
                  <td className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono text-[12px] font-bold text-[var(--text)]">
                      <TokenIcon sym={r.sym} />
                      {r.sym}
                    </div>
                    <div className="break-words text-[10px] text-[var(--text3)]">{r.name}</div>
                  </td>
                  <td className="num font-semibold text-[var(--text)]">{usdCompact(r.oiUsd, 2)}</td>
                  <td className="min-w-[90px]">
                    <VenueBar venues={r.venues ?? []} />
                  </td>
                  <td className="num font-semibold" style={{ color: signColor(r.oiChangePct) }}>
                    {pct(r.oiChangePct, 1)}
                  </td>
                  <td className="num" style={{ color: signColor(r.oiUsdChangePct) }}>
                    {pct(r.oiUsdChangePct, 1)}
                  </td>
                  <td className="num" style={{ color: signColor(r.priceChangePct) }}>
                    {pct(r.priceChangePct, 1)}
                  </td>
                  <td className="num" style={{ color: signColor(r.hlOiChangePct) }}>
                    {r.hlOi == null ? <span className="text-[var(--text3)]">not listed</span> : pct(r.hlOiChangePct, 1)}
                  </td>
                  <td>
                    <RegimeTag r={r.regime} />
                  </td>
                  <td className="num">
                    <Sparkline
                      data={r.series}
                      width={90}
                      height={22}
                      stroke={r.regime ? REGIME_COLOR[r.regime] : "var(--text3)"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          {ratios.length > 0 && (
            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text3)]">
                  Retail accounts vs top traders
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {ratios.map((r) => {
                  const gap = r.topLong - r.retailLong;
                  return (
                    <div key={r.sym} className="min-w-0">
                      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] font-bold text-[var(--text)]"><TokenIcon sym={r.sym} />{r.sym}</span>
                        <span
                          className="whitespace-nowrap font-mono text-[11px]"
                          style={{ color: signColor(gap) }}
                          title="Top-trader long share minus retail long share"
                        >
                          divergence {gap >= 0 ? "+" : ""}
                          {num(gap, 1)} pts
                        </span>
                      </div>
                      <div className="space-y-2">
                        <SplitBar
                          label="Retail accounts"
                          long={r.retailLong}
                          short={r.retailShort}
                          ratio={r.retailRatio}
                        />
                        <SplitBar
                          label="Top traders (position)"
                          long={r.topLong}
                          short={r.topShort}
                          ratio={r.topRatio}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

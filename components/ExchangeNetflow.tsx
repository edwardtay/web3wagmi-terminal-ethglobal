"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, Unavailable, AsOf, Segmented, TableWrap, Sparkline, TokenIcon, Th } from "./ui";
import { usdCompact, compact, num, signColor } from "@/lib/format";

// Coins moving onto an exchange can be sold. Coins leaving cannot. That is the
// whole idea, and it is the one on-chain read that a price-only terminal
// genuinely cannot give you.

type WindowKey = "h1" | "h24" | "d7";

type Flows = Partial<Record<WindowKey, number | null>>;

interface SeriesPoint {
  t: number;
  usd: number;
}

interface Dex {
  liquidityUsd: number;
  volumeUsd: number;
  avgVolumeUsd: number;
  pools: number;
  deepest: string | null;
  inflowVsVolume: number | null;
}

interface Holders {
  symbol: string;
  holders: number;
  circulatingSupply: number;
  topShare: number | null;
  topCount: number;
  contractShare: number | null;
  walletShare: number | null;
  largest: { share: number; isContract: boolean } | null;
}

interface FlowRow {
  key: string;
  sym: string;
  kind: "stable" | "crypto";
  reserves: number;
  reservesUsd: number;
  flow: Flows;
  flowUsd: Flows;
  price: number;
  /** Thirty days of reserves in USD, newest first. Only the indexed source has it. */
  series?: SeriesPoint[];
  /** The onchain venue that would have to absorb what just arrived. */
  dex?: Dex | null;
  /** Who holds the supply. */
  holders?: Holders | null;
}

interface VenueRow {
  venue: string;
  reservesUsd: number;
  flowUsd: Flows;
  wallets: number;
  walletsTracked: number;
}

interface NetflowPayload {
  ok: boolean;
  asOf: string;
  /** Which reader answered. The two carry different windows. */
  source: "graph" | "rpc" | null;
  /** The windows this payload actually has. Render these, never a fixed list. */
  windows: WindowKey[];
  block?: number;
  note: string | null;
  tokens: FlowRow[];
  venues: VenueRow[];
  totals: {
    reservesUsd: number;
    stableReservesUsd: number;
    cryptoReservesUsd: number;
    stable: Flows;
    crypto: Flows;
    all: Flows;
  } | null;
  coverage: {
    wallets: number;
    walletsTracked: number;
    venues: number;
    selfHosted?: boolean;
    callsPerRefresh?: number;
    costPerMonthUsd?: number;
  };
}

const WINDOW_LABEL: Record<WindowKey, string> = { h1: "1h", h24: "24h", d7: "7d" };


/**
 * Sum the per-asset reserve curves into one, oldest first for drawing.
 *
 * Only timestamps every asset covers are kept. The four series come from the
 * same read on the same daily grid, so this drops nothing in practice, and it
 * means a missing asset cannot draw a cliff.
 */
function totalCurve(tokens: FlowRow[]): number[] {
  const withSeries = tokens.filter((r) => (r.series?.length ?? 0) > 1);
  if (withSeries.length === 0) return [];
  const counts = new Map<number, number>();
  for (const r of withSeries) for (const p of r.series ?? []) counts.set(p.t, (counts.get(p.t) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n === withSeries.length)
    .map(([ts]) => ts)
    .sort((a, b) => a - b)
    .map((ts) => withSeries.reduce((a, r) => a + (r.series?.find((p) => p.t === ts)?.usd ?? 0), 0));
}

/** A share as a percentage, or the null glyph when there is no reading. */
function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

/** Inflow is red for crypto (sellable supply) and green for stables (buying power). */
function flowColor(kind: "stable" | "crypto", v: number | null): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "var(--text3)";
  const good = kind === "stable" ? v > 0 : v < 0;
  return good ? "var(--pos)" : "var(--neg)";
}

function Signed({ usd, kind }: { usd: number | null; kind: "stable" | "crypto" }) {
  if (usd == null || !Number.isFinite(usd)) return <span className="text-[var(--text3)]">n/a</span>;
  const sign = usd > 0 ? "+" : usd < 0 ? "-" : "";
  return (
    <span className="whitespace-nowrap font-semibold" style={{ color: flowColor(kind, usd) }}>
      {sign}
      {usdCompact(Math.abs(usd))}
    </span>
  );
}

export function ExchangeNetflow() {
  const { data, loading, failed } = useApi<NetflowPayload>("/api/netflow", 300);
  const [picked, setPicked] = useState<WindowKey>("h24");

  // The indexed reader carries 24h and 7d, the archive fallback also carries
  // 1h. Render what the payload has rather than a fixed list, so a source
  // change cannot leave a toggle pointing at a window that is not there.
  const available = data?.windows?.length ? data.windows : (["h24"] as WindowKey[]);
  const win = available.includes(picked) ? picked : available[0];

  const controls = (
    <>
      <Segmented
        options={available.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
        value={win}
        onChange={(v) => setPicked(v as WindowKey)}
        ariaLabel="Flow window"
      />
      {data?.asOf && <AsOf iso={data.asOf} staleMs={20 * 60 * 1000} />}
    </>
  );

  if (loading) {
    return (
      <Section title="Exchange netflow" id="netflow" hint="A sample of labelled Ethereum wallets, not total exchange reserves." right={controls}>
        <Panel>
          <Loading rows={8} />
        </Panel>
      </Section>
    );
  }

  if (failed || !data?.ok || !data.totals) {
    return (
      <Section title="Exchange netflow" id="netflow" hint="A sample of labelled Ethereum wallets, not total exchange reserves." right={controls}>
        <Panel>
          <Unavailable what={data?.note ? `Exchange netflow (${data.note})` : "Exchange netflow"} />
        </Panel>
      </Section>
    );
  }

  const t = data.totals;
  const stable = t.stable[win] ?? null;
  const crypto = t.crypto[win] ?? null;
  const maxVenue = Math.max(...data.venues.map((v) => Math.abs(v.flowUsd[win] ?? 0)), 1);
  const curve = totalCurve(data.tokens);

  // The two legs read in opposite directions, so state the combined read
  // rather than leaving the reader to work out the sign convention.
  const verdict =
    stable == null || crypto == null
      ? "Not enough of the sample answered to call a direction."
      : stable > 0 && crypto < 0
        ? "Buying power arriving while coins leave. The most constructive combination."
        : stable < 0 && crypto > 0
          ? "Coins arriving while stablecoins leave. The most defensive combination."
          : stable > 0 && crypto > 0
            ? "Both legs arriving. More capital and more sellable supply at the same time."
            : "Both legs leaving. Capital and coins are both moving off exchange.";

  return (
    <Section title="Exchange netflow" id="netflow" hint="A sample of labelled Ethereum wallets, not total exchange reserves." right={controls}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* ------------------------------------------------- the two legs -- */}
        <Panel
          title={`Net flow, ${WINDOW_LABEL[win]}`}
          className="lg:col-span-2"
          hint="Colour follows the reading rather than the sign, because the sign means the opposite thing on each leg. Green is stablecoins arriving or coins leaving, both of which reduce pressure to sell. Red is stablecoins leaving or coins arriving."
        >
          {/* The verdict leads. It is the only sentence here that is a finding
              rather than a figure, and it sat under a colour legend at the
              bottom of the panel where it read as a footnote to two numbers
              instead of the conclusion drawn from them. */}
          <p className="mb-3 text-[13px] font-semibold leading-snug text-[var(--text)]">{verdict}</p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-display text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">
                  Stablecoins
                </span>
              </div>
              <div className="mt-1 font-mono text-2xl font-bold leading-none" style={{ color: flowColor("stable", stable) }}>
                {stable == null ? "n/a" : `${stable > 0 ? "+" : stable < 0 ? "-" : ""}${usdCompact(Math.abs(stable))}`}
              </div>
              {/* The direction and what it means, together.
                  Both legs can read "leaving exchange" while one is red and the
                  other green, because the colour follows the reading and the
                  same direction means opposite things on the two legs. With the
                  convention moved behind the panel mark, that looked like a
                  bug. It has to be said on the row it applies to. */}
              <div className="mt-1 font-mono text-[11px] text-[var(--text3)]">
                {stable == null
                  ? "no reading"
                  : stable > 0
                    ? "arriving, buying power reaching the venues"
                    : "leaving, buying power stepping away"}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-display text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">
                  BTC and ETH
                </span>
              </div>
              <div className="mt-1 font-mono text-2xl font-bold leading-none" style={{ color: flowColor("crypto", crypto) }}>
                {crypto == null ? "n/a" : `${crypto > 0 ? "+" : crypto < 0 ? "-" : ""}${usdCompact(Math.abs(crypto))}`}
              </div>
              <div className="mt-1 font-mono text-[11px] text-[var(--text3)]">
                {crypto == null
                  ? "no reading"
                  : crypto > 0
                    ? "arriving, supply that can be sold"
                    : "leaving, less supply to sell"}
              </div>
            </div>
          </div>

        </Panel>

        {/* --------------------------------------------------- reserves -- */}
        <Panel
          title="Tracked reserves"
          hint={`Held right now across the ${data.coverage.wallets} wallets that answered, of ${data.coverage.walletsTracked} tracked across ${data.coverage.venues} venues.`}
        >
          <div className="font-mono text-2xl font-bold leading-none text-[var(--text)]">
            {usdCompact(t.reservesUsd)}
          </div>
          {curve.length > 1 && (
            <div className="mt-2">
              {/* Reserves falling is coins leaving the venues, which reads
                  constructive, so the line is inverted against the usual
                  rising-is-green convention for the same reason the flow
                  colours are. */}
              <Sparkline data={curve} up={curve[curve.length - 1] < curve[0]} width={220} height={40} />
              <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
                {curve.length} days, all tracked assets
              </div>
            </div>
          )}
          <div className="mt-3 space-y-1.5 font-mono text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--text3)]">stablecoins</span>
              <span className="text-[var(--text2)]">{usdCompact(t.stableReservesUsd)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--text3)]">BTC and ETH</span>
              <span className="text-[var(--text2)]">{usdCompact(t.cryptoReservesUsd)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2 border-t border-[var(--border2)] pt-1.5">
              <span className="text-[var(--text3)]">wallets answering</span>
              <span className="text-[var(--text2)]">
                {data.coverage.wallets} of {data.coverage.walletsTracked}
              </span>
            </div>
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------------ by venue -- */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="By venue">
          <TableWrap maxHeight={300}>
            <thead>
              <tr>
                <th className="ident">Venue</th>
                <Th label="Reserves" hint="Only the wallets we can attribute to this venue. A venue holding more elsewhere reads low here." num />
                <th className="num">Net {WINDOW_LABEL[win]}</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {data.venues.map((v) => {
                const f = v.flowUsd[win] ?? null;
                const w = f == null ? 0 : Math.min(100, (Math.abs(f) / maxVenue) * 100);
                return (
                  <tr key={v.venue}>
                    <td>
                      <span className="font-semibold text-[var(--text)]">{v.venue}</span>
                      <div className="font-mono text-[10px] text-[var(--text3)]">
                        {v.wallets} of {v.walletsTracked} wallets
                      </div>
                    </td>
                    <td className="num text-[var(--text2)]">{usdCompact(v.reservesUsd)}</td>
                    <td className="num">
                      <span style={{ color: signColor(f == null ? null : f) }}>
                        {f == null ? "n/a" : `${f > 0 ? "+" : f < 0 ? "-" : ""}${usdCompact(Math.abs(f))}`}
                      </span>
                    </td>
                    <td>
                      {/* Bar grows from the centre so inflow and outflow are
                          visually opposed rather than both reading as size. */}
                      <div className="flex h-1.5 w-full min-w-[70px] items-center overflow-hidden rounded-full bg-[var(--surface2)]">
                        <div className="flex h-full w-1/2 justify-end">
                          {f != null && f < 0 && (
                            <div className="h-full rounded-l-full" style={{ width: `${w}%`, background: "var(--pos)" }} />
                          )}
                        </div>
                        <div className="flex h-full w-1/2 justify-start">
                          {f != null && f > 0 && (
                            <div className="h-full rounded-r-full" style={{ width: `${w}%`, background: "var(--neg)" }} />
                          )}
                        </div>
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
                        {f == null ? "no reading" : f > 0 ? "inflow" : f < 0 ? "outflow" : "flat"}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        </Panel>

        {/* ------------------------------------------------------ by asset -- */}
        <Panel title="By asset">
          <TableWrap maxHeight={300}>
            <thead>
              <tr>
                <th className="ident">Asset</th>
                <th className="num">Reserves</th>
                {available.map((w) => (
                  <th key={w} className="num">
                    {WINDOW_LABEL[w]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((row) => (
                <tr key={row.key}>
                  <td>
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text)]"><TokenIcon sym={row.sym} />{row.sym}</span>
                    <div className="font-mono text-[10px] text-[var(--text3)]">
                      {row.kind === "stable" ? "stablecoin" : "crypto"}
                    </div>
                  </td>
                  <td className="num">
                    <span className="text-[var(--text2)]">{usdCompact(row.reservesUsd)}</span>
                    <div className="font-mono text-[10px] text-[var(--text3)]">
                      {compact(row.reserves, row.reserves < 1000 ? 2 : 0)} {row.sym}
                    </div>
                    {(row.series?.length ?? 0) > 1 && (
                      <div className="mt-1 flex justify-end">
                        <Sparkline
                          data={[...(row.series ?? [])].reverse().map((p) => p.usd)}
                          up={(row.series?.[0]?.usd ?? 0) < (row.series?.[row.series.length - 1]?.usd ?? 0)}
                          width={90}
                          height={24}
                        />
                      </div>
                    )}
                  </td>
                  {available.map((w) => (
                    <td key={w} className="num">
                      <Signed usd={row.flowUsd[w] ?? null} kind={row.kind} />
                      {/* The widest window also carries the token count, which
                          is the figure people quote. */}
                      {w === available[available.length - 1] && row.flow[w] != null && (
                        <div className="font-mono text-[10px] text-[var(--text3)]">
                          {num(row.flow[w] as number, row.kind === "stable" ? 0 : 2)} {row.sym}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Panel>
      </div>

      {data.tokens.some((r) => r.dex) && (
        <div className="mt-3">
          <Panel
            title="Where a sale would land"
            hint="The onchain liquidity that would absorb a sale. Above 1x, a day of deposits exceeds a day of trading."
          >
            <TableWrap maxHeight={260}>
              <thead>
                <tr>
                  <th className="ident">Asset</th>
                  <Th label="Onchain liquidity" hint="Uniswap v3 on Ethereum only, so a token trading elsewhere has its venue understated." num />
                  <Th label="Onchain daily volume" hint="Last completed day, not the day in progress, which would read as a collapse every morning." num />
                  <Th label="24h deposits vs volume" hint="Coins arriving only. A stablecoin is buying power and an outflow needs no absorbing." num />
                  <Th label="Deepest pool" hint="Deepest by liquidity, which is not always where the volume is." />
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((row) => {
                  const x = row.dex;
                  if (!x) return null;
                  const r = x.inflowVsVolume;
                  return (
                    <tr key={row.key}>
                      <td>
                        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text)]"><TokenIcon sym={row.sym} />{row.sym}</span>
                        <div className="font-mono text-[10px] text-[var(--text3)]">
                          {x.pools} pools
                        </div>
                      </td>
                      <td className="num text-[var(--text2)]">{usdCompact(x.liquidityUsd)}</td>
                      <td className="num">
                        <span className="text-[var(--text2)]">{usdCompact(x.volumeUsd)}</span>
                        <div className="font-mono text-[10px] text-[var(--text3)]">
                          {usdCompact(x.avgVolumeUsd)} avg
                        </div>
                      </td>
                      <td className="num">
                        {r == null ? (
                          <span className="text-[var(--text3)]">no inflow</span>
                        ) : (
                          <>
                            {/* Above one day of volume is where a deposit stops
                                being noise and starts being something the venue
                                has to work to absorb. */}
                            <span
                              className="font-semibold"
                              style={{ color: r >= 1 ? "var(--neg)" : "var(--text2)" }}
                            >
                              {num(r, r < 10 ? 2 : 1)}x
                            </span>
                            <div className="font-mono text-[10px] text-[var(--text3)]">
                              {r >= 1 ? "more than a trading day" : "under a trading day"}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="text-[var(--text2)]">{x.deepest ?? "n/a"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          </Panel>
        </div>
      )}

      {data.tokens.some((r) => r.holders) && (
        <div className="mt-3">
          <Panel
            title="Who holds it"
            hint="Contracts and wallets counted separately: pools and bridges hold for many people. The wallet share can act alone."
          >
            <TableWrap maxHeight={260}>
              <thead>
                <tr>
                  <th className="ident">Asset</th>
                  <Th label="Holders" hint="Addresses with a non-zero balance. One person can hold many, and an exchange holds for millions." num />
                  <Th label={<>Top {data.tokens.find((r) => r.holders)?.holders?.topCount ?? 10} share</>} hint="Share of circulating supply, not fully diluted." num />
                  <Th label="In contracts" hint="Pools, bridges and lending markets. They hold for many people, so this is not concentration." num />
                  <Th label="In wallets" hint="The share that can act alone. This is the number worth quoting." num />
                  <Th label="Largest single holder" hint="A contract here is usually infrastructure; a wallet is one decision maker." />
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((row) => {
                  const h = row.holders;
                  if (!h) return null;
                  return (
                    <tr key={row.key}>
                      <td>
                        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text)]"><TokenIcon sym={row.sym} />{row.sym}</span>
                        {/* Native ETH has no contract, so its row measures WETH.
                            Naming it beats a row that means something else. */}
                        {h.symbol && h.symbol !== row.sym && (
                          <div className="font-mono text-[10px] text-[var(--text3)]">measured as {h.symbol}</div>
                        )}
                      </td>
                      <td className="num text-[var(--text2)]">{compact(h.holders, 0)}</td>
                      <td className="num font-semibold text-[var(--text)]">{pct(h.topShare)}</td>
                      <td className="num text-[var(--text2)]">
                        {pct(h.contractShare)}
                        <div className="font-mono text-[10px] text-[var(--text3)]">pools, bridges</div>
                      </td>
                      <td className="num">
                        <span
                          className="font-semibold"
                          style={{ color: (h.walletShare ?? 0) >= 0.1 ? "var(--neg)" : "var(--text2)" }}
                        >
                          {pct(h.walletShare)}
                        </span>
                        <div className="font-mono text-[10px] text-[var(--text3)]">can act alone</div>
                      </td>
                      <td className="text-[var(--text2)]">
                        {h.largest == null ? (
                          "n/a"
                        ) : (
                          <>
                            {pct(h.largest.share)}{" "}
                            <span className="text-[var(--text3)]">
                              {h.largest.isContract ? "contract" : "wallet"}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
            {data.tokens.some((r) => r.dex && !r.holders) && (
              <p className="mt-2 font-mono text-[10px] text-[var(--text3)]">
                Assets missing from this table are ones the holder index will not serve. USDT has
                about 16 million holders and the query fails upstream.
              </p>
            )}
          </Panel>
        </div>
      )}
    </Section>
  );
}

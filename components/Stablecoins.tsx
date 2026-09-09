"use client";

import { useMemo, useState } from "react";
import type { StablecoinsPayload, StableRow } from "@/app/api/stablecoins/route";
import { AsOf, ChangeChip, Loading, Panel, Section, Segmented, Sparkline, TableWrap, Th, Unavailable} from "@/components/ui";
import { pctPlain, signColor, usd, usdCompact, NA } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { brandColor } from "@/lib/brandColors";




/** Beyond this the gap is wide enough to look at rather than shrug off. */
const DEPEG_BPS = 50;

/** Issuers shown individually in the share visual before the tail is pooled. */
const TOP_ISSUERS = 6;

/**
 * Seven fills for the share bar, theme tokens only, blended toward the surface
 * for the tail so the ramp stays legible in both themes.
 */
/** Fallback palette, for issuers with no brand colour on file. */
const SHARE_COLORS = [
  "var(--accent)",
  "var(--cyan)",
  "var(--violet)",
  "var(--pos)",
  "color-mix(in srgb, var(--accent) 58%, var(--surface))",
  "color-mix(in srgb, var(--cyan) 58%, var(--surface))",
];
const OTHER_COLOR = "var(--text3)";

type Window = "d1" | "d7" | "d30";

const WINDOWS = [
  { value: "d1", label: "1d" },
  { value: "d7", label: "7d" },
  { value: "d30", label: "30d" },
] as const satisfies readonly { value: Window; label: string }[];

function Stat({
  label,
  value,
  sub,
  hint,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="font-display text-[10px] font-bold uppercase tracking-[0.09em] text-[var(--text3)]">
          {label}
        </span>
      </div>
      <div
        className="mt-1 font-mono text-base font-bold leading-tight"
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] leading-snug text-[var(--text2)]">{sub}</div>}
    </div>
  );
}

/** Signed dollars, so a supply drop reads as an outflow at a glance. */
function Flow({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[var(--text3)]">{NA}</span>;
  return (
    <span style={{ color: signColor(value) }}>
      {value > 0 ? "+" : value < 0 ? "-" : ""}
      {usdCompact(Math.abs(value))}
    </span>
  );
}

/** Top issuers plus the pooled tail, as one proportional bar with a legend. */
function ShareBar({ rows, total }: { rows: StableRow[]; total: number }) {
  const top = rows.slice(0, TOP_ISSUERS);
  const covered = top.reduce((s, r) => s + r.share, 0);
  const other = Math.max(0, 100 - covered);
  const segments = [
    ...top.map((r, i) => ({
      key: r.id,
      label: r.symbol,
      name: r.name,
      share: r.share,
      value: r.circulating,
      // The issuer's own colour where we know it. USDT green and USDC blue are
      // what a reader already has in their head for these two.
      color: brandColor(r.symbol) ?? brandColor(r.name) ?? SHARE_COLORS[i % SHARE_COLORS.length],
    })),
    {
      key: "other",
      label: "Other",
      name: "Every other USD stablecoin",
      share: other,
      value: (other / 100) * total,
      color: OTHER_COLOR,
    },
  ];

  return (
    <div>
      <div
        className="flex h-7 w-full overflow-hidden rounded-md border border-[var(--border)]"
        role="img"
        aria-label="Share of USD stablecoin supply by issuer"
      >
        {segments.map((s) => (
          <div
            key={s.key}
            // A 0.6% floor keeps the smallest slice visible at 360px wide.
            style={{ width: `${Math.max(s.share, 0.6)}%`, background: s.color }}
            title={`${s.name}: ${pctPlain(s.share, 2)} of USD stablecoin supply (${usdCompact(s.value)})`}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {segments.map((s) => (
          <div key={s.key} className="flex min-w-0 items-start gap-2">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--text2)]">
              <span className="font-mono font-semibold text-[var(--text)]">{s.label}</span>{" "}
              <span className="text-[var(--text3)]">{usdCompact(s.value)}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold tabular-nums text-[var(--text)]">
              {pctPlain(s.share, 1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Asset({ row }: { row: StableRow }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[12px] font-bold leading-snug text-[var(--text)]">
        {row.symbol}
      </div>
      <div className="text-[11px] leading-snug text-[var(--text2)]">{row.name}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {row.mechanism && (
          <span className="whitespace-nowrap rounded px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wide text-[var(--text3)]" style={{ background: "var(--surface2)" }}>
            {row.mechanism}
          </span>
        )}
        {row.yieldBearing && (
          <span
            className="whitespace-nowrap rounded px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wide"
            style={{ color: "var(--violet)", background: "var(--surface2)" }}
            title="Interest-bearing: the token is redeemable above $1.00 by design"
          >
            yield
          </span>
        )}
      </div>
    </div>
  );
}

export function Stablecoins() {
  const { data, loading, failed } = useApi<StablecoinsPayload>("/api/stablecoins", 900);
  const [win, setWin] = useState<Window>("d7");

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const byFlow = useMemo(() => {
    const key = `${win}Pct` as const;
    const moved = rows.filter((r) => r[key] != null);
    return [...moved].sort((a, b) => (b[key] as number) - (a[key] as number));
  }, [rows, win]);

  // Ranked by distance from the peg, with the tokens that are meant to be off
  // it kept underneath.
  //
  // A tokenised treasury accrues interest into its price, so USDY and USYC sit
  // fourteen percent above a dollar by design and permanently. Ranking on
  // distance alone put both at the top of a panel whose entire job is spotting
  // the ones that should not be there, and pushed a real depeg below the fold.
  // They stay in the table, labelled, because their supply and share are worth
  // reading; they just cannot be allowed to lead it.
  const pegs = useMemo(
    () =>
      rows
        .filter((r) => r.devBps != null)
        .sort((a, b) => {
          if (a.yieldBearing !== b.yieldBearing) return a.yieldBearing ? 1 : -1;
          return Math.abs(b.devBps as number) - Math.abs(a.devBps as number);
        }),
    [rows]
  );

  const offPeg = pegs.filter((r) => !r.yieldBearing && Math.abs(r.devBps as number) > DEPEG_BPS).length;

  const growing = (data?.d7 ?? 0) >= 0;

  return (
    <Section
      title="Stablecoin supply"
      id="stablecoins"
      right={<AsOf iso={data?.asOf} staleMs={60 * 60 * 1000} />}
    >
      {loading ? (
        <Panel>
          <Loading rows={8} />
        </Panel>
      ) : failed || !data?.ok || rows.length === 0 ? (
        <Panel>
          <Unavailable what="The DefiLlama stablecoin feed" />
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel title="Headline">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat
                label="Total USD supply"
                value={usdCompact(data.total)}
                sub={`${data.rows.length} issuers over $100M, ${data.scanned} tracked`}
              />
              <Stat
                label="7d change"
                value={<Flow value={data.d7} />}
                sub={
                  <span className="inline-flex items-center gap-1.5">
                    <ChangeChip value={data.d7Pct} /> over 7 days
                  </span>
                }
              />
              <Stat
                label="30d change"
                value={<Flow value={data.d30} />}
                sub={
                  <span className="inline-flex items-center gap-1.5">
                    <ChangeChip value={data.d30Pct} /> over 30 days
                  </span>
                }
              />
              <Stat
                label="Off peg"
                value={`${offPeg}`}
                color={offPeg > 0 ? "var(--accent)" : "var(--text)"}
                sub={`assets more than ${DEPEG_BPS} bps from $1.00`}
              />
            </div>

            {data.spark.length > 1 && (
              <div className="mt-3 flex items-center gap-3">
                {/* The svg carries a viewBox, so forcing width:100% lets the
                    headline spark shrink to a 360px screen without clipping. */}
                <div className="min-w-0 flex-1 [&>svg]:w-full">
                  <Sparkline data={data.spark} width={640} height={44} />
                </div>
                <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.09em] text-[var(--text3)]">
                  90d supply
                </span>
              </div>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text2)]">
              {growing
                ? "Supply is growing. Fresh dollars are being minted on-chain, which is buying power waiting to be deployed."
                : "Supply is shrinking. Coins are being redeemed for dollars off-chain, which is capital leaving the system."}{" "}
              Supply moves slowly, so read the 30d line before the 7d one.
            </p>
          </Panel>

          <Panel
            title="Share of USD stablecoin supply"
          >
            {/* The share denominator, so the pooled tail's dollar value and
                its percent agree with each other. */}
            <ShareBar rows={rows} total={data.universe} />
          </Panel>

          <Panel
            title="Major USD stablecoins"
            right={<Segmented<Window> options={WINDOWS} value={win} onChange={setWin} ariaLabel="Rank supply change over" />}
          >
            <TableWrap maxHeight={560}>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <Th label="Supply" hint="Circulating supply in US dollars" num />
                  <Th label="1d" hint="Supply change over the last day, in dollars and percent" num />
                  <Th label="7d" hint="Supply change over the last 7 days, in dollars and percent" num />
                  <Th label="30d" hint="Supply change over the last 30 days, in dollars and percent" num />
                  <Th label="Share" hint="Share of all USD-pegged stablecoin supply" num />
                  <Th label="Top chains" hint="Chains holding the largest part of this asset's supply" />
                </tr>
              </thead>
              <tbody>
                {byFlow.map((r) => (
                  <tr key={r.id}>
                    <td className="min-w-0">
                      <Asset row={r} />
                    </td>
                    <td className="num font-semibold text-[var(--text)]">{usdCompact(r.circulating)}</td>
                    <td className="num">
                      <ChangeChip value={r.d1Pct} digits={2} />
                      <div className="mt-0.5 text-[10px] leading-tight">
                        <Flow value={r.d1} />
                      </div>
                    </td>
                    <td className="num">
                      <ChangeChip value={r.d7Pct} digits={2} />
                      <div className="mt-0.5 text-[10px] leading-tight">
                        <Flow value={r.d7} />
                      </div>
                    </td>
                    <td className="num">
                      <ChangeChip value={r.d30Pct} digits={2} />
                      <div className="mt-0.5 text-[10px] leading-tight">
                        <Flow value={r.d30} />
                      </div>
                    </td>
                    <td className="num">{pctPlain(r.share, r.share >= 1 ? 1 : 2)}</td>
                    <td className="min-w-0">
                      {r.chains.length === 0 ? (
                        <span className="text-[var(--text3)]">{NA}</span>
                      ) : (
                        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-snug">
                          {r.chains.map((c) => (
                            <span key={c.name} className="[overflow-wrap:anywhere]">
                              <span className="text-[var(--text2)]">{c.name}</span>{" "}
                              <span className="font-mono text-[10px] text-[var(--text3)]">
                                {pctPlain(c.share, 0)}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <div className="mt-2 text-[11px] leading-snug text-[var(--text2)]">
              Source: DefiLlama, refreshed every 15 minutes. USD-pegged assets over $100M of circulating supply,
              ranked by the selected window. A dash means DefiLlama has no snapshot that far back.
            </div>
          </Panel>

          <Panel
            title="Peg monitor"
            hint={`Sorted by distance from the peg, with the tokens that are meant to sit above it kept underneath: a tokenised treasury accrues interest into its price, so it reads permanently high by design. Anything past ${DEPEG_BPS} bps is highlighted and worth checking at the underlying venue before acting on it. One basis point is 0.01%, and prices are shown to four decimals so the deviation beside them reconciles.`}
          >
            {pegs.length === 0 ? (
              <div className="py-6 text-center font-mono text-[11px] text-[var(--text3)]">
                No priced asset in this set right now.
              </div>
            ) : (
              <TableWrap maxHeight={420}>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <Th label="Price" hint="Aggregate mark across the venues DefiLlama reads" num />
                    <Th label="Deviation" hint="Distance from $1.00 in basis points, one bps is 0.01%" num />
                    <th scope="col" className="num">
                      Supply
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pegs.map((r) => {
                    const dev = r.devBps as number;
                    // Interest-bearing tokens sit above $1.00 on purpose, so
                    // the accent is reserved for the ones that should not.
                    const wide = !r.yieldBearing && Math.abs(dev) > DEPEG_BPS;
                    return (
                      <tr key={r.id}>
                        <td className="min-w-0">
                          <Asset row={r} />
                        </td>
                        {/* Four decimals, not the usual two.
                            The deviation beside it is computed from the full
                            price, so a two decimal display does not reconcile
                            with it: $1.14 next to +1453.8 bps invites the
                            reader to check the arithmetic and get 1400. A
                            stablecoin is read in the fourth decimal anyway,
                            which is where a peg breaks. */}
                        <td className="num text-[var(--text)]">
                          {r.price == null ? usd(null) : `$${r.price.toFixed(4)}`}
                        </td>
                        <td className="num">
                          <span
                            className="inline-block rounded px-1.5 py-0.5 font-semibold"
                            style={{
                              color: wide ? "var(--accent)" : "var(--text2)",
                              background: wide ? "var(--accent-soft)" : "transparent",
                            }}
                          >
                            {dev > 0 ? "+" : ""}
                            {dev.toFixed(1)} bps
                          </span>
                        </td>
                        <td className="num">{usdCompact(r.circulating)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableWrap>
            )}
          </Panel>
        </div>
      )}
    </Section>
  );
}

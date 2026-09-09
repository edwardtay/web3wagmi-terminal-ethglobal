"use client";

import { useMemo, useState } from "react";
import type { ChainRow, ChainsPayload } from "@/app/api/chains/route";
import { AsOf, ChangeChip, Loading, Panel, Section, Segmented, Sparkline, TableWrap, Th, Unavailable } from "@/components/ui";
import { pct, pctPlain, signColor, usdCompact, NA } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { brandColor } from "@/lib/brandColors";


/**
 * Ten distinct fills for the share bar. Only the theme tokens are used, blended
 * toward the surface for the tail so the ramp stays legible in both themes.
 */
/** Fallback palette, for chains with no brand colour on file. */
const SHARE_COLORS = [
  "var(--accent)",
  "var(--cyan)",
  "var(--violet)",
  "var(--pos)",
  "color-mix(in srgb, var(--accent) 60%, var(--surface))",
  "color-mix(in srgb, var(--cyan) 60%, var(--surface))",
  "color-mix(in srgb, var(--violet) 60%, var(--surface))",
  "color-mix(in srgb, var(--pos) 60%, var(--surface))",
  "color-mix(in srgb, var(--accent) 32%, var(--surface))",
  "color-mix(in srgb, var(--cyan) 32%, var(--surface))",
];
const OTHER_COLOR = "var(--text3)";

type SortKey = "tvl" | "c24" | "c7" | "c30";

const SORTS = [
  { value: "tvl", label: "TVL" },
  { value: "c24", label: "24h" },
  { value: "c7", label: "7d" },
  { value: "c30", label: "30d" },
] as const satisfies readonly { value: SortKey; label: string }[];

function Stat({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="font-display text-[10px] font-bold uppercase tracking-[0.09em] text-[var(--text3)]">
          {label}
        </span>
      </div>
      <div className="mt-1 font-mono text-base font-bold leading-tight text-[var(--text)]">{value}</div>
      {sub && <div className="mt-1 text-[11px] leading-snug text-[var(--text2)]">{sub}</div>}
    </div>
  );
}

/** Top 10 chains plus the remainder, as one proportional bar with a legend. */
function ShareBar({ rows, total }: { rows: ChainRow[]; total: number }) {
  const top = rows.slice(0, 10);
  const covered = top.reduce((s, r) => s + r.share, 0);
  const other = Math.max(0, 100 - covered);
  const segments = [
    // The chain's own colour where we know it, so the bar says what the row is
    // rather than where it sits in the sort.
    ...top.map((r, i) => ({
      name: r.name,
      share: r.share,
      color: brandColor(r.name) ?? SHARE_COLORS[i % SHARE_COLORS.length],
      tvl: r.tvl,
    })),
    { name: "Other chains", share: other, color: OTHER_COLOR, tvl: (other / 100) * total },
  ];

  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded-md border border-[var(--border)]" role="img" aria-label="Share of total chain TVL by chain">
        {segments.map((s) => (
          <div
            key={s.name}
            // A 0.4% floor keeps the smallest slice visible at 360px wide.
            style={{ width: `${Math.max(s.share, 0.4)}%`, background: s.color }}
            title={`${s.name}: ${pctPlain(s.share, 2)} of chain TVL (${usdCompact(s.tvl)})`}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {segments.map((s) => (
          <div key={s.name} className="flex min-w-0 items-start gap-2">
            <span
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: s.color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--text2)]">
              {s.name}
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

export function ChainBoard() {
  const { data, loading, failed } = useApi<ChainsPayload>("/api/chains", 600);
  const [sort, setSort] = useState<SortKey>("tvl");

  const rows = data?.rows ?? [];

  const sorted = useMemo(() => {
    if (sort === "tvl") return rows;
    // Chains with no history for the window sink to the bottom rather than
    // sorting as zero, which would plant them in the middle of the list.
    return [...rows].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  }, [rows, sort]);

  return (
    <Section
      title="On-chain capital"
      id="chains"
      right={<AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />}
    >
      {loading ? (
        <Panel>
          <Loading rows={8} />
        </Panel>
      ) : failed || !data?.ok || rows.length === 0 ? (
        <Panel>
          <Unavailable what="The DefiLlama chain board" />
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel title="Headline">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat
                label="Total DeFi TVL"
                value={usdCompact(data.total)}
                sub={
                  <span className="inline-flex items-center gap-1.5">
                    <ChangeChip value={data.total7d} /> 7d
                  </span>
                }
              />
              <Stat
                label="ETH dominance"
                value={pctPlain(data.ethDominance, 1)}
                sub={`Ethereum's share of ${data.chainCount} tracked chains`}
              />
              <Stat
                label="Top-20 riser 7d"
                value={
                  <span className="[overflow-wrap:anywhere]">{data.riser ? data.riser.name : NA}</span>
                }
                sub={
                  data.riser ? (
                    // The best mover can still be negative in a broad drawdown.
                    <span style={{ color: signColor(data.riser.c7) }} className="font-mono font-semibold">
                      {pct(data.riser.c7, 1)} TVL, 7d
                    </span>
                  ) : undefined
                }
              />
              <Stat
                label="Top-20 faller 7d"
                value={
                  <span className="[overflow-wrap:anywhere]">{data.faller ? data.faller.name : NA}</span>
                }
                sub={
                  data.faller ? (
                    <span style={{ color: signColor(data.faller.c7) }} className="font-mono font-semibold">
                      {pct(data.faller.c7, 1)} TVL, 7d
                    </span>
                  ) : undefined
                }
              />
            </div>
            {data.totalSpark.length > 1 && (
              <div className="mt-3 flex items-center gap-3">
                {/* The svg carries a viewBox, so forcing width:100% lets the
                    headline spark shrink to a 360px screen without clipping. */}
                <div className="min-w-0 flex-1 [&>svg]:w-full">
                  <Sparkline data={data.totalSpark} width={640} height={44} />
                </div>
                <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.09em] text-[var(--text3)]">
                  90d total
                </span>
              </div>
            )}
          </Panel>

          <Panel
            title="Share of chain TVL"
          >
            <ShareBar rows={rows} total={data.total} />
          </Panel>

          <Panel
            title="Top 20 chains by TVL"
            hint="DefiLlama, refreshed every 10 minutes. Changes compare current USD TVL against the daily snapshot 1, 7 and 30 days back, so a dash means the chain has no history that far back rather than no change."
            right={
              <Segmented<SortKey> options={SORTS} value={sort} onChange={setSort} ariaLabel="Sort chains by" />
            }
          >
            <TableWrap maxHeight={520} pinTwo>
              <thead>
                <tr>
                  <Th label="#" hint="Rank by total value locked" num />
                  <th className="ident">Chain</th>
                  <th className="num">TVL (USD)</th>
                  <th className="num">24h</th>
                  <th className="num">7d</th>
                  <th className="num">30d</th>
                  <Th label="Share" hint="Share of total chain TVL" num />
                  {/* The last column, so it can have room: a 110px trace of
                      ninety days was three months squeezed into an inch, and
                      the shape is the whole reason the column exists. */}
                  <Th label="90d" hint="Total value locked over the last ninety days, drawn to its own range rather than a shared one, so the shape is comparable between rows and the height is not." />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.name}>
                    <td className="num text-[var(--text3)]">{r.rank}</td>
                    <td className="min-w-0">
                      {/* The chain's own colour, the same mark the share bar
                          above uses, so a row and its slice of the bar are the
                          same colour rather than two unrelated encodings. */}
                      <span
                        className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
                        style={{ background: brandColor(r.name) ?? "var(--text3)" }}
                        aria-hidden
                      />
                      <span className="font-semibold text-[var(--text)]">{r.name}</span>
                      {r.symbol && (
                        <span className="ml-1.5 font-mono text-[10px] text-[var(--text3)]">{r.symbol}</span>
                      )}
                    </td>
                    <td className="num font-semibold text-[var(--text)]">{usdCompact(r.tvl)}</td>
                    <td className="num">
                      <ChangeChip value={r.c24} digits={1} />
                    </td>
                    <td className="num">
                      <ChangeChip value={r.c7} digits={1} />
                    </td>
                    <td className="num">
                      <ChangeChip value={r.c30} digits={1} />
                    </td>
                    <td className="num">{pctPlain(r.share, r.share >= 1 ? 1 : 2)}</td>
                    <td>
                      <Sparkline data={r.spark} width={190} height={30} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Panel>
        </div>
      )}
    </Section>
  );
}

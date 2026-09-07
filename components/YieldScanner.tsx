"use client";

import { useMemo, useState } from "react";
import type { YieldPool, YieldsPayload } from "@/app/api/yields/route";
import { AsOf, InfoHint, Loading, Panel, Segmented, TableWrap, Unavailable } from "@/components/ui";
import { pctPlain, usdCompact, NA } from "@/lib/format";
import { useApi } from "@/lib/useApi";

const TVL_TIERS = [
  { value: "1", label: "$1M+" },
  { value: "10", label: "$10M+" },
  { value: "100", label: "$100M+" },
] as const;
type Tier = (typeof TVL_TIERS)[number]["value"];

const SORTS = [
  { value: "apy", label: "APY" },
  { value: "tvl", label: "TVL" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

// Reward share above half means most of the yield is paid in a token the
// protocol prints, and can be cut at any time. The absolute floor stops a
// token dust reward on a 2% pool from tripping the flag.
const REWARD_SHARE = 0.5;
const REWARD_FLOOR = 1;

// Roughly the top decile of sigma across the filtered universe, which is where
// the APY series stops being something you can plan around.
const SIGMA_HOT = 0.2;

// Under a month of history there is not enough series to trust the mean or sigma.
const YOUNG_DAYS = 30;

function rewardShare(p: YieldPool): number {
  const r = p.apyReward ?? 0;
  if (r <= 0 || p.apy <= 0) return 0;
  return Math.min(1, r / p.apy);
}

function emissionsLed(p: YieldPool): boolean {
  return (p.apyReward ?? 0) >= REWARD_FLOOR && rewardShare(p) >= REWARD_SHARE;
}

function unstable(p: YieldPool): boolean {
  return (p.sigma ?? 0) >= SIGMA_HOT;
}

function projectName(slug: string): string {
  return slug.replace(/-/g, " ");
}

function Toggle({
  on,
  onClick,
  children,
  hint,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={on}
        className="rounded-lg border px-2 py-1 font-mono text-[11px] font-semibold transition-colors"
        style={{
          borderColor: on ? "var(--accent)" : "var(--border)",
          background: on ? "var(--accent-soft)" : "var(--bg2)",
          color: on ? "var(--accent)" : "var(--text3)",
        }}
      >
        {children}
      </button>
    </span>
  );
}

/** Base vs reward split of the headline APY, drawn to a shared scale. */
function SplitBar({ base, reward, max }: { base: number; reward: number; max: number }) {
  const w = (v: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
  return (
    <div className="mt-1 flex h-1.5 w-full min-w-[52px] overflow-hidden rounded-full bg-[var(--surface2)]">
      <div style={{ width: `${w(base)}%`, background: "var(--cyan)" }} />
      <div style={{ width: `${w(reward)}%`, background: "var(--gold)" }} />
    </div>
  );
}

function Flag({ text, color, title }: { text: string; color: string; title: string }) {
  return (
    <span
      className="whitespace-nowrap rounded px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wide"
      style={{ color, background: "var(--surface2)" }}
      title={title}
    >
      {text}
    </span>
  );
}

export function YieldScanner() {
  const { data, loading, failed } = useApi<YieldsPayload>("/api/yields", 900);

  const [tier, setTier] = useState<Tier>("10");
  const [sort, setSort] = useState<Sort>("apy");
  const [stableOnly, setStableOnly] = useState(false);
  const [noIl, setNoIl] = useState(false);
  const [chain, setChain] = useState("all");

  const pools = useMemo(() => data?.pools ?? [], [data]);

  const rows = useMemo(() => {
    const floor = Number(tier) * 1_000_000;
    const out = pools.filter(
      (p) =>
        p.tvl >= floor &&
        (!stableOnly || p.stable) &&
        (!noIl || (p.single && !p.il)) &&
        (chain === "all" || p.chain === chain)
    );
    out.sort((a, b) => (sort === "apy" ? b.apy - a.apy : b.tvl - a.tvl));
    return out;
  }, [pools, tier, stableOnly, noIl, chain, sort]);

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    const sorted = [...rows].map((p) => p.apy).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      median,
      emissions: rows.filter(emissionsLed).length,
      unstable: rows.filter(unstable).length,
      maxApy: Math.max(...rows.map((p) => p.apy)),
    };
  }, [rows]);

  const header = (
    <div className="flex items-center gap-2">
      {data?.asOf && <AsOf iso={data.asOf} staleMs={30 * 60 * 1000} />}
    </div>
  );

  return (
    <Panel
      title="DeFi Yield Scanner"
      right={header}
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !data?.ok || pools.length === 0 ? (
        <Unavailable what="The DefiLlama yields feed" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text3)]">TVL</span>
              <Segmented<Tier> options={TVL_TIERS} value={tier} onChange={setTier} ariaLabel="Minimum pool TVL" />
            </div>
            <div className="flex items-center gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text3)]">Sort</span>
              <Segmented<Sort> options={SORTS} value={sort} onChange={setSort} ariaLabel="Sort pools by" />
            </div>
            <label className="flex items-center gap-1">
              <span className="sr-only">Filter by chain</span>
              <select
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                aria-label="Filter by chain"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1 font-mono text-[11px] font-semibold text-[var(--text2)]"
              >
                <option value="all">All chains</option>
                {data.chains.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <Toggle
              on={stableOnly}
              onClick={() => setStableOnly((v) => !v)}
            >
              Stables only
            </Toggle>
            <Toggle
              on={noIl}
              onClick={() => setNoIl((v) => !v)}
            >
              No IL
            </Toggle>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Pools shown" value={`${rows.length}`} sub={`of ${data.kept} kept, ${data.scanned.toLocaleString("en-US")} scanned`} />
            <Stat label="Median APY" value={stats ? pctPlain(stats.median) : NA} sub={stats ? `top ${pctPlain(stats.maxApy)}` : undefined} />
            <Stat
              label="Emissions led"
              value={stats ? `${stats.emissions}` : NA}
              sub="over half the APY is rewards"
              color={stats && stats.emissions > 0 ? "var(--gold)" : undefined}
            />
            <Stat
              label="Unstable APY"
              value={stats ? `${stats.unstable}` : NA}
              sub={`sigma over ${SIGMA_HOT}`}
              color={stats && stats.unstable > 0 ? "var(--neg)" : undefined}
            />
          </div>

          {rows.length === 0 ? (
            <div className="py-6 text-center font-mono text-[11px] text-[var(--text3)]">
              No pool matches these filters. Lower the TVL floor or clear a toggle.
            </div>
          ) : (
            <TableWrap maxHeight={520}>
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col" className="num" title="Total value locked in the pool, in US dollars">
                    TVL
                  </th>
                  <th scope="col" className="num" title="Headline annual percentage yield projected by DefiLlama">
                    APY
                  </th>
                  <th scope="col" className="num" title="Fee revenue APY versus token emission APY">
                    Base / Reward
                  </th>
                  <th scope="col" className="num" title="Current APY minus its 30 day mean, in percentage points">
                    vs 30d
                  </th>
                  <th scope="col" title="Impermanent loss risk, asset exposure, and sigma (standard deviation of the APY series)">
                    Risk
                  </th>
                  <th scope="col" title="DefiLlama's machine learned call on where this APY goes next, with its confidence">
                    Outlook
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Row key={p.id} p={p} maxApy={stats?.maxApy ?? 1} />
                ))}
              </tbody>
            </TableWrap>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text3)]">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: "var(--cyan)" }} />
              base APY (fees)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-full" style={{ background: "var(--gold)" }} />
              reward APY (token emissions)
            </span>
            <span>Source: DefiLlama yields, refreshed every 15 minutes.</span>
          </div>
        </>
      )}
    </Panel>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2.5 py-2">
      <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
        {label}
      </div>
      <div className="font-mono text-sm font-bold" style={{ color: color ?? "var(--text)" }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] leading-tight text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

function Row({ p, maxApy }: { p: YieldPool; maxApy: number }) {
  const base = p.apyBase ?? Math.max(0, p.apy - (p.apyReward ?? 0));
  const reward = p.apyReward ?? 0;
  const share = rewardShare(p);
  const emissions = emissionsLed(p);
  const hot = unstable(p);
  const young = (p.days ?? 0) > 0 && (p.days ?? 0) < YOUNG_DAYS;
  const vs30 = p.apyMean30d != null ? p.apy - p.apyMean30d : null;

  const apyColor = emissions || hot ? "var(--gold)" : "var(--text)";

  return (
    <tr>
      <td className="min-w-0">
        <div className="font-mono text-[12px] font-bold leading-snug text-[var(--text)]">
          {p.symbol}
        </div>
        {p.meta && <div className="text-[10px] leading-tight text-[var(--text3)]">{p.meta}</div>}
        <div className="mt-0.5 text-[10px] leading-tight text-[var(--text2)]">
          {projectName(p.project)} <span className="text-[var(--text3)]">·</span> {p.chain}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {p.stable && <Flag text="stable" color="var(--cyan)" title="Stablecoin denominated pool" />}
          {emissions && (
            <Flag
              text="emissions"
              color="var(--gold)"
              title={`${pctPlain(share * 100, 0)} of this APY is paid in reward tokens, which the protocol can cut at any time`}
            />
          )}
          {hot && (
            <Flag text="unstable" color="var(--neg)" title={`Sigma ${p.sigma?.toFixed(2)}: the APY series swings widely`} />
          )}
          {p.outlier && <Flag text="outlier" color="var(--violet)" title="DefiLlama marks this pool's APY as an outlier" />}
          {young && <Flag text={`${p.days}d`} color="var(--text3)" title="Less than a month of history, so the averages are thin" />}
        </div>
      </td>
      <td className="num">{usdCompact(p.tvl)}</td>
      <td className="num">
        <span className="text-[13px] font-bold" style={{ color: apyColor }}>
          {pctPlain(p.apy)}
        </span>
      </td>
      <td className="num">
        <div className="text-[10px] leading-tight">
          <span style={{ color: "var(--cyan)" }}>{pctPlain(base)}</span>
          <span className="text-[var(--text3)]"> / </span>
          <span style={{ color: reward > 0 ? "var(--gold)" : "var(--text3)" }}>{pctPlain(reward)}</span>
        </div>
        <SplitBar base={base} reward={reward} max={maxApy} />
      </td>
      <td className="num">
        {vs30 == null ? (
          <span className="text-[var(--text3)]">{NA}</span>
        ) : (
          <span style={{ color: Math.abs(vs30) < 0.1 ? "var(--text3)" : vs30 > 0 ? "var(--pos)" : "var(--neg)" }}>
            {vs30 > 0 ? "+" : ""}
            {vs30.toFixed(1)}pp
          </span>
        )}
      </td>
      <td>
        <div className="whitespace-nowrap text-[10px] leading-tight" style={{ color: p.il ? "var(--neg)" : "var(--text2)" }}>
          {p.il ? "IL risk" : "no IL"}
        </div>
        <div className="whitespace-nowrap text-[10px] leading-tight text-[var(--text3)]">
          {p.single ? "single" : "multi"} · σ {p.sigma != null ? p.sigma.toFixed(2) : NA}
        </div>
      </td>
      <td>
        {p.outlook == null ? (
          <span className="text-[10px] text-[var(--text3)]">{NA}</span>
        ) : (
          <div className="whitespace-nowrap text-[10px] leading-tight">
            <span style={{ color: p.outlook === "Down" ? "var(--neg)" : "var(--pos)" }}>{p.outlook}</span>
            {p.outlookProb != null && (
              <span className="text-[var(--text3)]"> {p.outlookProb.toFixed(0)}%</span>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

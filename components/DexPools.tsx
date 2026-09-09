"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { brandColor } from "@/lib/brandColors";
import { Section, Panel, Loading, Unavailable, ChangeChip, AsOf, InfoHint, BarCell, Segmented, TableWrap } from "./ui";
import { usdCompact, usd, num, duration, compact } from "@/lib/format";

// The long tail. Everything else on the terminal reads centralised majors, so
// this is the only panel where a token that listed an hour ago can appear.

interface DexPool {
  key: string;
  network: string;
  networkName: string;
  dex: string;
  pair: string;
  base: string;
  quote: string;
  address: string;
  priceUsd: number | null;
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
  vol1h: number | null;
  vol24h: number | null;
  liquidity: number | null;
  fdv: number | null;
  buys24: number;
  sells24: number;
  buyers24: number;
  sellers24: number;
  createdAt: string | null;
  turnover: number | null;
  fdvToLiq: number | null;
  buyShare: number | null;
  url: string;
}

interface DexPayload {
  ok: boolean;
  asOf: string;
  trending: DexPool[];
  fresh: DexPool[];
  networks: string[];
}

type View = "trending" | "fresh";
type SortKey = "liquidity" | "vol24h" | "h1" | "h24" | "turnover" | "age";
type LiqFloor = "0" | "50000" | "250000";


function ageMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Date.now() - t;
}

function riskFlags(p: DexPool): string[] {
  const out: string[] = [];
  if (p.liquidity != null && p.liquidity < 50_000) out.push("thin");
  const age = ageMs(p.createdAt);
  if (age != null && age < 24 * 3600 * 1000) out.push("fresh");
  if (p.fdvToLiq != null && p.fdvToLiq > 100) out.push("stretched");
  return out;
}

/**
 * The chain and the venue, without saying either twice.
 *
 * These arrived as two lines that overlapped: "robinhood" above "Uniswap V3
 * (Robinhood)". A venue name that already carries the chain in brackets does
 * not need the chain repeated above it.
 */
/** Names the same chain answers to, so a match is not defeated by spelling. */
const CHAIN_ALIASES: Record<string, string[]> = {
  "bnb chain": ["bsc", "binance smart chain", "bnb"],
  ethereum: ["eth", "mainnet"],
  "op mainnet": ["optimism", "op"],
  "arbitrum one": ["arbitrum", "arb"],
  polygon: ["matic", "pol"],
};

function venueLabel(network: string, dex: string): string {
  const n = (network || "").trim();
  const d = (dex || "").trim();
  if (!d) return n;
  if (!n) return d;

  // The venue name usually carries its chain in brackets, and the two sources
  // spell it differently: "BNB Chain" above "Pancakeswap V3 (BSC)" is one chain
  // named twice. Matching on the alias as well as the name catches that.
  const lower = d.toLowerCase();
  const names = [n.toLowerCase(), ...(CHAIN_ALIASES[n.toLowerCase()] ?? [])];
  return names.some((name) => lower.includes(name)) ? d : `${n} · ${d}`;
}

export function DexPools() {
  const { data, loading, failed } = useApi<DexPayload>("/api/dex", 60);
  const [view, setView] = useState<View>("trending");
  const [minLiq, setMinLiq] = useState<LiqFloor>("0");
  const [network, setNetwork] = useState("all");
  const [sort, setSort] = useState<SortKey>("vol24h");
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const src = (view === "trending" ? data?.trending : data?.fresh) ?? [];
    const floor = Number(minLiq);
    const filtered = src.filter(
      (p) => (network === "all" || p.networkName === network) && (p.liquidity ?? 0) >= floor
    );
    const val = (p: DexPool): number => {
      if (sort === "age") return ageMs(p.createdAt) ?? Number.MAX_SAFE_INTEGER;
      const v = p[sort];
      return v == null || !Number.isFinite(v) ? -Infinity : v;
    };
    return [...filtered].sort((a, b) => (desc ? val(b) - val(a) : val(a) - val(b)));
  }, [data, view, minLiq, network, sort, desc]);

  function header(key: SortKey, label: string, hint?: string) {
    const on = sort === key;
    return (
      <th className="num" aria-sort={on ? (desc ? "descending" : "ascending") : "none"}>
        <button
          onClick={() => {
            if (on) setDesc((d) => !d);
            else {
              setSort(key);
              setDesc(true);
            }
          }}
          className={`inline-flex items-center gap-1 ${on ? "text-[var(--text)]" : "hover:text-[var(--text2)]"}`}
        >
          {label}
          {on && <span aria-hidden>{desc ? "▾" : "▴"}</span>}
        </button>
      </th>
    );
  }

  const controls = (
    <>
      <Segmented
        options={[
          { value: "trending" as View, label: "Trending" },
          { value: "fresh" as View, label: "New" },
        ]}
        value={view}
        onChange={setView}
        ariaLabel="Pool list"
      />
      {data?.asOf && <AsOf iso={data.asOf} staleMs={5 * 60 * 1000} />}
    </>
  );

  if (loading) {
    return (
      <Section title="DEX pools" id="dex" hint="Pool names link out to GeckoTerminal. Flags are arithmetic on the row and say nothing about the project." right={controls}>
        <Panel>
          <Loading rows={8} />
        </Panel>
      </Section>
    );
  }

  if (failed || !data?.ok) {
    return (
      <Section title="DEX pools" id="dex" hint="Pool names link out to GeckoTerminal. Flags are arithmetic on the row and say nothing about the project." right={controls}>
        <Panel>
          <Unavailable what="On-chain pool data (GeckoTerminal)" />
        </Panel>
      </Section>
    );
  }

  const totalVol = rows.reduce((a, p) => a + (p.vol24h ?? 0), 0);
  const totalLiq = rows.reduce((a, p) => a + (p.liquidity ?? 0), 0);
  const src = (view === "trending" ? data.trending : data.fresh) ?? [];

  return (
    <Section title="DEX pools" id="dex" hint="Pool names link out to GeckoTerminal. Flags are arithmetic on the row and say nothing about the project." right={controls}>
      <Panel
        title={view === "trending" ? "Trending" : "Newest"}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Network</span>
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                aria-label="Filter by network"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1 font-mono text-[11px] font-semibold text-[var(--text)]"
              >
                <option value="all">all networks</option>
                {data.networks.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <Segmented
              options={[
                { value: "0" as LiqFloor, label: "all" },
                { value: "50000" as LiqFloor, label: "$50k+" },
                { value: "250000" as LiqFloor, label: "$250k+" },
              ]}
              value={minLiq}
              onChange={setMinLiq}
              ariaLabel="Minimum liquidity"
            />
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-[11px] text-[var(--text3)]">
          <span>
            <span className="text-[var(--text)]">{rows.length}</span> of {src.length} pools shown
          </span>
          <span>
            24h volume <span className="text-[var(--text)]">{usdCompact(totalVol)}</span>
          </span>
          <span>
            pooled liquidity <span className="text-[var(--text)]">{usdCompact(totalLiq)}</span>
          </span>
        </div>

        {rows.length === 0 ? (
          <Unavailable what="No pool matches these filters, so nothing" />
        ) : (
          <TableWrap maxHeight={560}>
            <thead>
              <tr>
                {/* Network and venue moved into this cell. They identify the
                    pool rather than measuring it, and as their own column they
                    said the same thing twice: "robinhood" above "Uniswap V3
                    (Robinhood)". */}
                <th className="ident">Pool</th>
                <th className="num">Price</th>
                <th className="num">1h</th>
                <th className="num">24h</th>
                {header("vol24h", "24h vol")}
                {header("liquidity", "Liquidity")}
                {header("turnover", "Turn")}
                <th className="num">
                  FDV / liq
                </th>
                <th>
                  Buy pressure
                </th>
                {header("age", "Age")}
                <th>
                  Flags
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const flags = riskFlags(p);
                const age = ageMs(p.createdAt);
                return (
                  <tr key={p.key}>
                    <td className="ident">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-[var(--text)] hover:text-[var(--accent)]"
                      >
                        {p.pair || `${p.base} / ${p.quote}`}
                      </a>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text3)]">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: brandColor(p.networkName) ?? "var(--text3)" }}
                          aria-hidden
                        />
                        <span className="break-words">{venueLabel(p.networkName, p.dex)}</span>
                      </div>
                    </td>
                    <td className="num text-[var(--text)]">{usd(p.priceUsd)}</td>
                    <td className="num">
                      <ChangeChip value={p.h1} digits={1} />
                    </td>
                    <td className="num">
                      <ChangeChip value={p.h24} digits={1} />
                    </td>
                    <td className="num text-[var(--text)]">{usdCompact(p.vol24h)}</td>
                    <td className="num">{usdCompact(p.liquidity)}</td>
                    <td className="num" style={{ color: (p.turnover ?? 0) > 5 ? "var(--gold)" : undefined }}>
                      {p.turnover == null ? "n/a" : `${num(p.turnover, 1)}x`}
                    </td>
                    <td className="num" style={{ color: (p.fdvToLiq ?? 0) > 100 ? "var(--neg)" : undefined }}>
                      {p.fdvToLiq == null ? "n/a" : `${num(p.fdvToLiq, 0)}x`}
                    </td>
                    <td>
                      <div className="min-w-[74px]">
                        <BarCell
                          value={p.buyShare ?? 0}
                          max={100}
                          color={(p.buyShare ?? 50) >= 50 ? "var(--pos)" : "var(--neg)"}
                        />
                        <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
                          {p.buyShare == null ? "no trades" : `${num(p.buyShare, 0)}% buys`}
                          <span className="ml-1">
                            ({compact(p.buyers24, 0)} / {compact(p.sellers24, 0)} wallets)
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="num">{age == null ? "n/a" : duration(age)}</td>
                    <td>
                      {flags.length === 0 ? (
                        <span className="font-mono text-[10px] text-[var(--text3)]">clear</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {flags.map((f) => (
                            <span
                              key={f}
                              className="pill px-1.5 py-0 text-[9px]"
                              style={{ color: f === "thin" ? "var(--neg)" : f === "fresh" ? "var(--gold)" : "var(--violet)" }}
                            >
                              {f}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </Section>
  );
}

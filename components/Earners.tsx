"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, Unavailable, AsOf, Segmented, TableWrap, Th } from "./ui";
import { usdCompact, pctPlain } from "@/lib/format";
import { brandColor } from "@/lib/brandColors";

// What users paid, what the protocol kept, and what reached the token.
//
// Three readings of one flow. A table of fees alone makes a DEX and a
// stablecoin issuer look like the same business, when most of a DEX's fees are
// the liquidity providers' income and almost all of an issuer's are its own.
// The take rate is the column that separates them.
//
// Profit is not shown. It would be revenue minus token emissions, DefiLlama
// does not publish an earnings series here, and subtracting an incentives
// figure from a different adapter would look precise and not be comparable
// between rows. Saying so is better than showing a number nobody can check.

type Period = "d1" | "d7" | "d30" | "y1" | "all";
type View = "apps" | "chains";

const PERIODS: { value: Period; label: string }[] = [
  { value: "d1", label: "24h" },
  { value: "d7", label: "7d" },
  { value: "d30", label: "30d" },
  { value: "y1", label: "1y" },
  { value: "all", label: "all time" },
];

const VIEWS: { value: View; label: string }[] = [
  { value: "apps", label: "Apps" },
  { value: "chains", label: "Chains" },
];

interface Row {
  name: string;
  category: string | null;
  chains: string[];
  fees: Partial<Record<Period, number | null>>;
  revenue: Partial<Record<Period, number | null>>;
  holders: Partial<Record<Period, number | null>>;
  takeRate: number | null;
}
interface Payload {
  ok: boolean;
  asOf?: string;
  apps: Row[];
  chains: Row[];
  note: string | null;
}

export function Earners() {
  const { data, loading, failed } = useApi<Payload>("/api/revenue", 3600);
  const [period, setPeriod] = useState<Period>("d30");
  const [view, setView] = useState<View>("apps");

  const rows = useMemo(() => {
    const src = view === "chains" ? (data?.chains ?? []) : (data?.apps ?? []);
    // Re-ranked on the chosen window, because the row that earns most over a
    // year is often not the one that earned most yesterday, and the question
    // "who is making money right now" is a different question from "who has".
    return [...src].sort((a, b) => (b.fees[period] ?? 0) - (a.fees[period] ?? 0)).slice(0, 20);
  }, [data, view, period]);

  const body = () => {
    if (loading) return <Loading rows={8} />;
    if (failed || !data?.ok || rows.length === 0) {
      return <Unavailable what="The fee and revenue feed" />;
    }
    return (
      <TableWrap maxHeight={520}>
        <thead>
          <tr>
            <Th label={view === "chains" ? "Chain" : "App"} />
            <Th label="Fees" hint="Everything users paid to use it over the window. Not income: on a DEX most of this is the liquidity providers' and never touches the protocol." num />
            <Th label="Revenue" hint="The part of those fees the protocol itself kept." num />
            <Th label="Take" hint="Revenue as a share of fees over thirty days. A DEX keeps a sliver because the rest is the liquidity providers' income; a stablecoin issuer keeps nearly all of it because there is nobody to share with. Measured over thirty days rather than a day, since one quiet day makes the ratio meaningless." num />
            <Th label="To holders" hint="The part of revenue that reaches token holders through buybacks or distributions. Blank means none is published, which is not the same as none reaching them." num />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                <div className="flex items-center gap-1.5">
                  {view === "chains" && (
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: brandColor(r.name) ?? "var(--text3)" }}
                      aria-hidden
                    />
                  )}
                  <span className="break-words font-semibold text-[var(--text)]">{r.name}</span>
                </div>
                {r.category && view !== "chains" && (
                  <div className="font-mono text-[10px] text-[var(--text3)]">{r.category}</div>
                )}
              </td>
              <td className="num text-[var(--text)]">{usdCompact(r.fees[period] ?? null)}</td>
              <td className="num font-semibold text-[var(--text)]">{usdCompact(r.revenue[period] ?? null)}</td>
              <td className="num" style={{ color: (r.takeRate ?? 0) > 0.8 ? "var(--gold)" : undefined }}>
                {r.takeRate == null ? "n/a" : pctPlain(r.takeRate * 100, 0)}
              </td>
              <td className="num text-[var(--text2)]">{usdCompact(r.holders[period] ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    );
  };

  return (
    <Section
      title="Who earns"
      id="earners"
      hint="Fees are what users paid, revenue is what the protocol kept out of that, and the take rate is the difference between a business and a toll road. Profit is not shown: it would be revenue minus token emissions, that series is not published here, and combining two adapters would give a figure that looks precise and is not comparable between rows."
      right={
        <>
          <Segmented<View> options={VIEWS} value={view} onChange={setView} ariaLabel="Apps or chains" />
          <Segmented<Period> options={PERIODS} value={period} onChange={setPeriod} ariaLabel="Window" />
          <AsOf iso={data?.asOf} staleMs={2 * 60 * 60 * 1000} />
        </>
      }
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

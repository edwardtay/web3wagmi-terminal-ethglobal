"use client";

import { useApi } from "@/lib/useApi";
import { useSymbol } from "@/lib/useSymbol";
import { Section, TokenIcon } from "./ui";
import { usd, usdCompact, pct, signColor } from "@/lib/format";
import { BY_SYM } from "@/lib/symbols";

// Everything the focused instrument drives, in one place, under a heading that
// names it.
//
// The focus control sat at the top of the header and changed the chart, the
// order flow panels and the options desk, which were scattered across three
// different sections with market-wide panels in between. Changing the focus
// therefore looked like it did almost nothing: the parts that responded were
// too far apart to see at once, and the rest of the page is market-wide by
// design and correctly did not move.
//
// Grouping them fixes the legibility rather than the behaviour, and the strip
// below gives the control something that visibly and entirely belongs to it.

interface BoardRow {
  sym: string;
  last: number;
  changePct: number;
  quoteVol: number;
}

interface FundingRow {
  sym: string;
  annual: number;
  hlAnnual: number | null;
}

interface OiRow {
  sym: string;
  oiUsd: number;
  oiChangePct: number;
  regime: string;
}

interface Signal {
  kind: string;
  symbol: string | null;
  headline: string;
  evidence: string;
  severity: number;
}

/** One reading in the strip. Absent data prints the null glyph, never a zero. */
function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">{label}</div>
      <div className="mt-0.5 break-words font-mono text-[13px] font-bold text-[var(--text)]">
        {children}
      </div>
      {hint && <div className="mt-0.5 break-words font-mono text-[10px] text-[var(--text3)]">{hint}</div>}
    </div>
  );
}

export function FocusSection({ children }: { children: React.ReactNode }) {
  const { symbol } = useSymbol();
  const asset = BY_SYM[symbol];

  // All three are already polled elsewhere on the page, so this strip shares
  // their responses rather than adding load.
  const { data: board } = useApi<{ rows?: BoardRow[] }>("/api/board", 30);
  const { data: derivs } = useApi<{ funding?: FundingRow[]; oi?: OiRow[] }>("/api/derivs", 180);
  const { data: sigs } = useApi<{ signals?: Signal[] }>("/api/signals", 300);

  const row = board?.rows?.find((r) => r.sym === symbol);
  const funding = derivs?.funding?.find((f) => f.sym === symbol);
  const oi = derivs?.oi?.find((o) => o.sym === symbol);
  const mine = (sigs?.signals ?? []).filter((s) => s.symbol === symbol);

  // Where this asset sits in the ranked universe, which is the reference the
  // rest of the terminal insists on. A funding rate alone is a level.
  const fundingRank = (() => {
    const all = derivs?.funding ?? [];
    if (!funding || all.length === 0) return null;
    const sorted = [...all].sort((a, b) => Math.abs(b.annual) - Math.abs(a.annual));
    const i = sorted.findIndex((f) => f.sym === symbol);
    return i < 0 ? null : { at: i + 1, of: sorted.length };
  })();

  return (
    <Section
      title={`Focus: ${symbol}${asset?.name ? ` · ${asset.name}` : ""}`}
      id="focus"
      hint="Everything that follows the focus. The panels below are market-wide."
    >
      <div className="card mb-3 p-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <TokenIcon sym={symbol} size={22} />
            <div>
              <div className="font-display text-[15px] font-bold leading-none text-[var(--text)]">{symbol}</div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--text3)]">{asset?.sector ?? ""}</div>
            </div>
          </div>

          <Stat label="Price">
            {row ? (
              <>
                {usd(row.last)}{" "}
                <span style={{ color: signColor(row.changePct) }}>{pct(row.changePct)}</span>
              </>
            ) : (
              "n/a"
            )}
          </Stat>

          <Stat label="24h volume">{row ? usdCompact(row.quoteVol) : "n/a"}</Stat>

          <Stat
            label="Funding"
            hint={fundingRank ? `${fundingRank.at} of ${fundingRank.of} by distance from zero` : undefined}
          >
            {funding ? (
              <span style={{ color: signColor(funding.annual) }}>
                {funding.annual >= 0 ? "+" : ""}
                {funding.annual.toFixed(1)}%
              </span>
            ) : (
              "n/a"
            )}
          </Stat>

          <Stat label="Open interest" hint={oi?.regime}>
            {oi ? (
              <>
                {usdCompact(oi.oiUsd)}{" "}
                <span style={{ color: signColor(oi.oiChangePct) }}>{pct(oi.oiChangePct)}</span>
              </>
            ) : (
              "n/a"
            )}
          </Stat>

          <Stat label="In the queue">
            {mine.length === 0 ? (
              <span className="text-[var(--text3)]">nothing abnormal</span>
            ) : (
              <span className="text-[var(--gold)]">
                {mine.length} signal{mine.length > 1 ? "s" : ""}
              </span>
            )}
          </Stat>
        </div>

        {/* The signals themselves, because a count is a level and the evidence
            is the reference. */}
        {mine.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-[var(--border2)] pt-3">
            {mine.slice(0, 3).map((s) => (
              <div key={`${s.kind}-${s.headline}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">{s.kind}</span>
                <span className="break-words text-[12px] font-semibold text-[var(--text)]">{s.headline}</span>
                <span className="break-words font-mono text-[10px] text-[var(--text3)]">{s.evidence}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {children}
    </Section>
  );
}

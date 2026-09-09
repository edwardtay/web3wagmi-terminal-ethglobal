"use client";

import type { UnlocksPayload, UnlockRow } from "@/app/api/unlocks/route";
import { useApi } from "@/lib/useApi";
import { compact, pctPlain, usdCompact } from "@/lib/format";
import { AsOf, BarCell, Loading, Panel, TableWrap, Th, Unavailable } from "@/components/ui";


/** Short UTC date label, e.g. "12 Aug". Unlocks are scheduled in UTC. */
function dateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function severity(pctOfMcap: number | null): string {
  if (pctOfMcap == null) return "var(--text3)";
  if (pctOfMcap >= 3) return "var(--neg)";
  if (pctOfMcap >= 1) return "var(--gold)";
  return "var(--text2)";
}

function Row({ r, maxPct }: { r: UnlockRow; maxPct: number }) {
  return (
    <tr>
      <td className="min-w-[190px]">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="font-mono text-[11px] font-bold text-[var(--text)]">{r.symbol}</span>
          {/* No "heavy" badge. It fired at 1% of market cap, which is the
              number already shown and already coloured two columns over, so it
              was the same judgement said twice and in a louder voice. */}
          <span className="text-[11px] text-[var(--text2)]">{r.name}</span>
        </div>
        {r.recipients.length > 0 && (
          <div className="mt-0.5 text-[10px] text-[var(--text3)]">{r.recipients.join(", ")}</div>
        )}
      </td>
      <td className="whitespace-nowrap">
        <div className="font-mono font-semibold text-[var(--text)]">{dateLabel(r.date)}</div>
        <div className="mt-0.5 font-mono text-[10px] text-[var(--text3)]">
          {r.daysAway === 0 ? "today" : `in ${r.daysAway}d`}
        </div>
      </td>
      {/* The share and the cap it is a share of, in one cell, directly after
          the token. The reading a reader wants from this row is how big the
          unlock is against the float, so it sits where the eye lands after the
          name rather than at the far end past two absolute numbers. */}
      <td className="num" style={{ minWidth: 96 }}>
        <div className="font-semibold" style={{ color: severity(r.pctOfMcap) }}>
          {pctPlain(r.pctOfMcap, 2)}
        </div>
        <div className="font-mono text-[10px] text-[var(--text3)]">of {usdCompact(r.mcap)}</div>
        <div className="mt-1">
          <BarCell value={r.pctOfMcap ?? 0} max={maxPct} color={severity(r.pctOfMcap)} />
        </div>
      </td>
      <td className="num text-[var(--text)]">{usdCompact(r.usd)}</td>
      <td className="num">
        <span className="text-[var(--text3)]">{compact(r.tokens, 1)}</span>
      </td>
    </tr>
  );
}

export function Unlocks() {
  const { data, loading, failed } = useApi<UnlocksPayload>("/api/unlocks", 900);
  const rows = data?.rows ?? [];
  const maxPct = Math.max(1, ...rows.map((r) => r.pctOfMcap ?? 0));

  return (
    <Panel
      title="Token unlocks, next 60 days"
      right={<AsOf iso={data?.asOf} staleMs={60 * 60 * 1000} />}
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !data?.ok || rows.length === 0 ? (
        <Unavailable what="The unlock calendar" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--text3)]">
            <span>
              <span className="text-[var(--text2)]">{rows.length}</span> cliff unlocks
            </span>
            <span>
              total <span className="text-[var(--text)]">{usdCompact(data.totalUsd)}</span>
            </span>
            <span style={{ color: data.heavyCount > 0 ? "var(--gold)" : undefined }}>
              <span className="font-bold">{data.heavyCount}</span> at or above 1% of market cap
            </span>
            <span className="inline-flex items-center gap-1">
              cliff only
            </span>
          </div>
          <TableWrap maxHeight={460} tight>
            <thead>
              <tr>
                {/* Token first, because it is the subject of the row and the
                    first column is the one that pins when the table scrolls
                    sideways. A date pinned against a scrolling row identifies
                    nothing: several unlocks share a date and none of them is
                    told apart by it. The order is still by date. */}
                <th className="ident">Token</th>
                <th className="ident">Date</th>
                <Th label="% of mcap" hint="Against circulating cap, not fully diluted, so it measures the shock against what trades. The cap itself is underneath." num />
                <th className="num">Unlock USD</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Row key={`${r.symbol}-${r.date}-${i}`} r={r} maxPct={maxPct} />
              ))}
            </tbody>
          </TableWrap>
        </>
      )}
    </Panel>
  );
}

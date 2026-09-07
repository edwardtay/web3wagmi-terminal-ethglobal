"use client";

import { useState } from "react";
import type { ProtocolsPayload, MoverRow, DexRow, FeeRow } from "@/app/api/protocols/route";
import { useApi } from "@/lib/useApi";
import { usdCompact, pct, pctPlain } from "@/lib/format";
import { AsOf, BarCell, ChangeChip, Loading, Panel, Segmented, TableWrap, Unavailable } from "@/components/ui";

type View = "tvl" | "dex" | "fees";

const VIEWS: readonly { value: View; label: string }[] = [
  { value: "tvl", label: "TVL 7d" },
  { value: "dex", label: "DEX vol" },
  { value: "fees", label: "Fees" },
];


/** Chain list as wrapping chips. Every chain is shown, nothing is hidden. */
/**
 * Chains a protocol is deployed on, capped.
 *
 * A protocol on twenty chains was rendering twenty chips and pushing its own
 * TVL and change off the row it belongs to. The first few answer the question
 * anyone asks of this column, which is roughly where it lives, and the rest are
 * a count.
 *
 * This is a summary rather than a truncation, and the difference matters: the
 * remainder is stated as a number and named in full on hover, so nothing is
 * silently dropped. An ellipsis would hide how much was hidden.
 */
const CHAIN_CAP = 5;

function Chains({ chains }: { chains: string[] }) {
  const shown = chains.slice(0, CHAIN_CAP);
  const rest = chains.slice(CHAIN_CAP);
  const chip =
    "whitespace-nowrap rounded bg-[var(--surface2)] px-1 py-px font-mono text-[10px] text-[var(--text3)]";

  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <span key={c} className={chip}>
          {c}
        </span>
      ))}
      {rest.length > 0 && (
        <span className={`${chip} cursor-help`} title={rest.join(", ")}>
          +{rest.length} more
        </span>
      )}
    </span>
  );
}

/** A labelled headline figure for the strip above each table. */
function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text3)]">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-bold tabular-nums" style={{ color: color ?? "var(--text)" }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

function MoverTable({ rows, title, sub }: { rows: MoverRow[]; title: string; sub: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.change7d)));
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-display text-[11px] font-bold uppercase tracking-[0.09em] text-[var(--text2)]">
          {title}
        </span>
        <span className="font-mono text-[10px] text-[var(--text3)]">{sub}</span>
      </div>
      <TableWrap maxHeight={360}>
        <thead>
          <tr>
            <th>Protocol</th>
            <th className="num">TVL</th>
            <th className="num">24h</th>
            <th className="num">7d</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="min-w-0">
                <div className="font-semibold text-[var(--text)]">{r.name}</div>
                <div className="mt-0.5 text-[10px] text-[var(--text3)]">{r.category}</div>
                <div className="mt-1">
                  <Chains chains={r.chains} />
                </div>
              </td>
              <td className="num text-[var(--text)]">{usdCompact(r.tvl)}</td>
              <td className="num" style={{ color: "var(--text2)" }}>
                {pct(r.change1d, 1)}
              </td>
              <td className="num" style={{ minWidth: 96 }}>
                <div className="font-semibold" style={{ color: r.change7d >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {pct(r.change7d, 1)}
                </div>
                <div className="mt-1">
                  <BarCell value={r.change7d} max={max} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

function DexView({ dex }: { dex: ProtocolsPayload["dex"] }) {
  const rows: DexRow[] = dex.rows;
  if (rows.length === 0) return <Unavailable what="DEX volume" />;
  const max = Math.max(1, ...rows.map((r) => r.vol24h));
  // Weekly run rate against the trailing week, which reads better than a
  // single-day change when a Monday is compared with a Sunday.
  const runRate = dex.total7d != null ? dex.total7d / 7 : null;
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Spot DEX 24h" value={usdCompact(dex.total24h)} sub="all tracked venues" />
        <Stat
          label="vs prev 24h"
          value={pct(dex.change1d, 1)}
          color={(dex.change1d ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"}
        />
        <Stat label="7d volume" value={usdCompact(dex.total7d)} sub={runRate ? `${usdCompact(runRate)}/day avg` : undefined} />
        <Stat
          label="7d over 7d"
          value={pct(dex.change7dover7d, 1)}
          sub="week on week"
          color={(dex.change7dover7d ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"}
        />
      </div>
      <TableWrap maxHeight={420}>
        <thead>
          <tr>
            <th>DEX</th>
            <th className="num">24h vol</th>
            <th className="num">Share</th>
            <th className="num">7d vol</th>
            <th className="num">24h chg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="min-w-0">
                <div className="font-semibold text-[var(--text)]">{r.name}</div>
                <div className="mt-1">
                  <Chains chains={r.chains} />
                </div>
              </td>
              <td className="num text-[var(--text)]" style={{ minWidth: 92 }}>
                <div>{usdCompact(r.vol24h)}</div>
                <div className="mt-1">
                  <BarCell value={r.vol24h} max={max} color="var(--cyan)" />
                </div>
              </td>
              <td className="num">{pctPlain(r.share, 1)}</td>
              <td className="num">{usdCompact(r.vol7d)}</td>
              <td className="num">
                <ChangeChip value={r.change1d} digits={1} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

function FeesView({ fees }: { fees: ProtocolsPayload["fees"] }) {
  const rows: FeeRow[] = fees.rows;
  if (rows.length === 0) return <Unavailable what="Fees and revenue" />;
  const max = Math.max(1, ...rows.map((r) => r.fees24h));
  const overall =
    fees.total24h && fees.total24h > 0 && fees.revenue24h != null
      ? (fees.revenue24h / fees.total24h) * 100
      : null;
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Fees 24h" value={usdCompact(fees.total24h)} sub="paid by users" />
        <Stat label="Revenue 24h" value={usdCompact(fees.revenue24h)} sub="kept by protocols" color="var(--violet)" />
        <Stat label="Take rate" value={pctPlain(overall, 1)} sub="revenue / fees" color="var(--gold)" />
        <Stat
          label="Fees vs prev 24h"
          value={pct(fees.change1d, 1)}
          color={(fees.change1d ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"}
        />
      </div>
      <TableWrap maxHeight={420}>
        <thead>
          <tr>
            <th>Protocol</th>
            <th className="num">Fees 24h</th>
            <th className="num">Rev 24h</th>
            <th className="num" title="Revenue as a percentage of fees">
              Take
            </th>
            <th className="num">Fees 7d</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="min-w-0">
                <div className="font-semibold text-[var(--text)]">{r.name}</div>
                <div className="mt-0.5 text-[10px] text-[var(--text3)]">{r.category}</div>
                <div className="mt-1">
                  <Chains chains={r.chains} />
                </div>
              </td>
              <td className="num text-[var(--text)]" style={{ minWidth: 92 }}>
                <div>{usdCompact(r.fees24h)}</div>
                <div className="mt-1">
                  <BarCell value={r.fees24h} max={max} color="var(--accent)" />
                </div>
              </td>
              <td className="num" style={{ color: "var(--violet)" }}>
                {usdCompact(r.revenue24h)}
              </td>
              <td className="num">
                {r.takeRate == null ? (
                  <span className="text-[var(--text3)]">n/a</span>
                ) : (
                  <span
                    className="font-semibold"
                    style={{ color: r.takeRate >= 50 ? "var(--gold)" : "var(--text2)" }}
                  >
                    {pctPlain(r.takeRate, 0)}
                  </span>
                )}
              </td>
              <td className="num">{usdCompact(r.fees7d)}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

export function ProtocolMovers() {
  const [view, setView] = useState<View>("tvl");
  const { data, loading, failed } = useApi<ProtocolsPayload>("/api/protocols", 900);


  return (
    <Panel
      title="Protocol economics"
      right={
        <div className="flex items-center gap-2">
          <AsOf iso={data?.asOf} staleMs={30 * 60 * 1000} />
          <Segmented<View> options={VIEWS} value={view} onChange={setView} ariaLabel="Protocol economics view" />
        </div>
      }
    >
      {loading ? (
        <Loading rows={8} />
      ) : failed || !data?.ok ? (
        <Unavailable what="Protocol economics" />
      ) : view === "tvl" ? (
        data.gainers.length === 0 ? (
          <Unavailable what="TVL movers" />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MoverTable rows={data.gainers} title="7d gainers" sub={`${data.tvlCount} protocols over $50M`} />
            <MoverTable rows={data.losers} title="7d losers" sub="same universe" />
          </div>
        )
      ) : view === "dex" ? (
        <DexView dex={data.dex} />
      ) : (
        <FeesView fees={data.fees} />
      )}
    </Panel>
  );
}

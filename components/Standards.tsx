"use client";

import { useApi } from "@/lib/useApi";
import { Section, Panel, Unavailable, Loading, AsOf, TableWrap } from "./ui";
import { usdCompact, num } from "@/lib/format";

// What a shared schema buys, shown rather than claimed.
//
// The table is one query's answer. Not one query per protocol and not a
// template: the literal string above it is sent unchanged to nine subgraphs
// across four categories, and every one of them answers because they share
// Messari's schema.
//
// The line underneath is the same query sent to a subgraph that does not share
// it. Uniswap v3's own schema has no `protocols` entity, so the gateway rejects
// it, and that rejection is the cost of a bespoke schema stated by the network
// itself rather than by us. Adding Uniswap to this table would mean a second
// query, a second mapping and a second set of field names. Adding a tenth
// standardized protocol is one line: an id.

interface Row {
  label: string;
  name: string | null;
  type: string | null;
  tvlUsd: number | null;
  revenueUsd: number | null;
  users: number | null;
  error?: string;
}

interface Payload {
  ok: boolean;
  asOf?: string;
  query: string | null;
  rows: Row[];
  answered?: number;
  attempted?: number;
  bespoke: { label: string; error: string | null } | null;
  queries?: number;
  note: string | null;
}

export function Standards() {
  const { data, loading, failed } = useApi<Payload>("/api/standards", 1800);

  const body = () => {
    if (loading) return <Loading rows={9} />;
    if (failed || !data?.ok) {
      return (
        <>
          <Unavailable what="The standardized schema read" />
          {data?.note && <p className="mt-2 text-[12px] text-[var(--text3)]">{data.note}</p>}
        </>
      );
    }

    return (
      <>
        <div className="mb-3 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
          <pre className="font-mono text-[10px] leading-relaxed text-[var(--text2)]">{data.query}</pre>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text2)]">
          Sent unchanged to {data.attempted} subgraphs. {data.answered} answered. Adding another
          protocol is one line, an id, because the schema is already agreed.
        </p>

        <TableWrap maxHeight={360}>
          <thead>
            <tr>
              <th>Protocol</th>
              <th>Category</th>
              <th className="num">TVL</th>
              <th className="num">Supply revenue</th>
              <th className="num">Users</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.label}>
                <td>
                  <div className="font-mono text-[12px] font-bold text-[var(--text)]">{r.label}</div>
                  {r.name && r.name !== r.label && (
                    <div className="break-words text-[10px] text-[var(--text3)]">{r.name}</div>
                  )}
                </td>
                {r.error ? (
                  <td colSpan={4} className="break-words text-[11px] text-[var(--text3)]">
                    {r.error}
                  </td>
                ) : (
                  <>
                    <td className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                      {r.type ?? "n/a"}
                    </td>
                    <td className="num font-semibold text-[var(--text)]">{usdCompact(r.tvlUsd, 2)}</td>
                    <td className="num">{usdCompact(r.revenueUsd, 2)}</td>
                    <td className="num">{num(r.users, 0)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {data.bespoke?.error && (
          <p className="mt-3 break-words rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5 text-[11px] leading-relaxed text-[var(--text2)]">
            The same query, sent to {data.bespoke.label}, which does not share the schema:{" "}
            <span className="font-mono text-[var(--down)]">{data.bespoke.error}</span> That is the
            cost of a bespoke schema, stated by the gateway rather than by us.
          </p>
        )}

        {data.asOf && <AsOf iso={data.asOf} staleMs={60 * 60 * 1000} />}
      </>
    );
  };

  return (
    <Section
      title="One query, many protocols"
      id="standards"
      hint="A standardized subgraph schema, queried once and answered by every protocol that shares it. Totals are protocol-wide and update on a daily snapshot, so they are not a live tape."
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

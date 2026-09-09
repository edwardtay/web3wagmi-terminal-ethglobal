"use client";

import { useApi } from "@/lib/useApi";
import { Section, Panel, Unavailable, Loading, AsOf, TableWrap, Th } from "./ui";
import { usdCompact, num } from "@/lib/format";

// What a shared schema buys, shown rather than claimed.
//
// The table is one query's answer. Not one query per protocol and not a
// template: the literal string above it is sent unchanged to nine subgraphs and
// every one of them answers because they share Messari's schema. The category
// column is the schema's own, which is why MakerDAO reads LENDING and Lido
// reads GENERIC rather than what each calls itself.
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
  revenue7dUsd: number | null;
  protocolSide7dUsd: number | null;
  asOf: number | null;
  takePct: number | null;
  staleDays: number | null;
  attestation: {
    requestCID: string;
    responseCID: string;
    subgraphDeploymentID: string;
    r: string;
    s: string;
    v: number;
  } | null;
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

// Whether a row's week is reportable, and what its take rate is, are both
// decided in lib/standards.ts so the panel and the assistant cannot disagree
// about a number they read from the same route. This file only formats.

/** A stale row's last seven snapshots are seven days of the distant past. */
const fees7d = (r: Row) => (r.staleDays !== null ? "\u2014" : usdCompact(r.revenue7dUsd, 2));

const take = (r: Row) =>
  r.staleDays !== null ? "\u2014" : r.takePct === null ? "n/a" : `${r.takePct.toFixed(0)}%`;

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
          protocol is one line, an id, because the schema is already agreed. Each row is one
          Ethereum mainnet deployment, and the figures are the schema's definitions rather than any
          aggregator's, which is what makes the rows comparable with each other. The take column is
          what a shared schema buys that a feed does not: because the schema defines supply side and
          protocol side as separate fields, the same query that returns fees also returns who kept
          them. Where a subgraph reports its whole fee as supply side, as Lido's mapping does, the
          take reads zero: that is the mapping's answer and it is left standing rather than
          patched.
        </p>

        <TableWrap maxHeight={360}>
          <thead>
            <tr>
              <Th label="Protocol" />
              <Th label="Category" hint="Messari's category, not the protocol's own. MakerDAO reads LENDING and Lido reads GENERIC because a shared vocabulary only counts as shared if it overrides the local one." />
              <Th label="TVL" num hint="The schema's definition. For a lending market that is total deposits, before subtracting what has been borrowed against them." />
              <Th label="Fees 7d" num hint="Seven days of total revenue, summed from the same daily snapshot entity every one of these subgraphs exposes. This is the fee the protocol generated, before splitting it." />
              <Th label="Take" num hint="The share of those fees the protocol itself kept rather than paid to suppliers. A lending market that keeps 12% is running a thinner cut than one that keeps 88%. No aggregator gives this split: it exists because the schema defines supply side and protocol side separately. Withheld under fifty thousand dollars of weekly fees, because a wound-down protocol earning ten thousand and keeping all of it would otherwise top this column." />
              <Th label="Supply revenue" num hint="Cumulative, since the protocol's deployment. Paid to depositors and liquidity providers rather than kept. Blank where the subgraph reports a figure the world cannot support: Curve's mapping returns 1.88e20 dollars here, which is more than everything humans own, so it is withheld rather than repeated. That is an upstream mapping bug rather than a reading, and it is not ours to correct." />
              <Th label="Users" num hint="Cumulative unique addresses, by the schema's count." />
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
                  {r.staleDays !== null && (
                    <div className="break-words text-[10px] text-[var(--neg)]">
                      indexer stopped {r.staleDays} days ago
                    </div>
                  )}
                </td>
                {r.error ? (
                  <td colSpan={6} className="break-words text-[11px] text-[var(--text3)]">
                    {r.error}
                  </td>
                ) : (
                  <>
                    <td className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                      {r.type ?? "n/a"}
                    </td>
                    <td className="num font-semibold text-[var(--text)]">{usdCompact(r.tvlUsd, 2)}</td>
                    <td className="num">{fees7d(r)}</td>
                    <td className="num">{take(r)}</td>
                    <td className="num">{usdCompact(r.revenueUsd, 2)}</td>
                    <td className="num">{num(r.users, 0)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {/*
            The one thing on this panel nobody here could have written.

            Every other number could in principle be typed into a file and
            served. The gateway signs each answer: an ECDSA signature by the
            indexer that served it, over the hash of the query sent and the hash
            of the answer returned. A reader who doubts these rows came off The
            Graph can check that the signature covers the response they were
            shown, which is a stronger claim than any assurance in this
            paragraph.
        */}
        {(() => {
          const signed = data.rows.filter((r) => r.attestation);
          if (!signed.length) return null;
          const a = signed[0].attestation!;
          return (
            <details className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
              <summary className="cursor-pointer text-[11px] text-[var(--text2)]">
                {signed.length} of {data.rows.length} answers arrived signed by the indexer that
                served them. Open for the signature over this table.
              </summary>
              <div className="mt-2 space-y-1 font-mono text-[10px] leading-relaxed text-[var(--text3)]">
                <div className="break-all">
                  <span className="text-[var(--text2)]">deployment</span> {a.subgraphDeploymentID}
                </div>
                <div className="break-all">
                  <span className="text-[var(--text2)]">request</span> {a.requestCID}
                </div>
                <div className="break-all">
                  <span className="text-[var(--text2)]">response</span> {a.responseCID}
                </div>
                <div className="break-all">
                  <span className="text-[var(--text2)]">signature</span> r {a.r}
                </div>
                <div className="break-all">
                  <span className="text-[var(--text2)]">&nbsp;</span> s {a.s}, v {a.v}
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text2)]">
                {signed[0].label}&apos;s indexer signed the hash of the query above and the hash of
                the answer in this table. It is the one thing on this page that could not have been
                written here, which is why it is worth showing rather than asserting the data is
                live.
              </p>
            </details>
          );
        })()}

        {data.bespoke?.error && (
          <p className="mt-3 break-words rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5 text-[11px] leading-relaxed text-[var(--text2)]">
            The same query, sent to {data.bespoke.label}, which does not share the schema:{" "}
            <span className="font-mono text-[var(--neg)]">{data.bespoke.error}</span> That is the
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
      hint="A standardized subgraph schema, queried once and answered by every protocol that shares it. Each row is one deployment on Ethereum mainnet, not a protocol across every chain and version, and TVL is the schema's own definition: for a lending market that is total deposits, before subtracting what has been borrowed against them. Aave v3 reads $24.7b here and $18.3b on DefiLlama for exactly those two reasons, and neither is wrong. Comparing the rows to each other is the point; comparing one of them to another aggregator is comparing two different definitions."
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

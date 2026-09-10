"use client";

import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, Unavailable, AsOf, TableWrap, Th } from "./ui";
import { num } from "@/lib/format";
import { brandColor } from "@/lib/brandColors";

// How much of the agent economy is real.
//
// ERC-8004 gives an autonomous agent an onchain identity, a reputation and a
// record of validation, in three registries deployed per chain. The Graph
// indexes all three through the Agent0 subgraphs, which is the only reason this
// desk exists: the registries are singletons with no aggregator above them, so
// counting agents across chains without a subgraph means running an indexer per
// chain yourself.
//
// The headcount is the least interesting column. Registering an agent costs
// almost nothing, so a chain can carry a third of a million of them and mean
// very little by it. A rating costs somebody a transaction and requires them to
// have used the agent first. Feedback per agent is therefore the column that
// separates a working economy from a registration farm, and in a table of
// totals alone the two are indistinguishable.

interface Row {
  chain: string;
  agents: number | null;
  newAgents24h: number | null;
  newAgents7d: number | null;
  feedback: number | null;
  feedbackPerAgent: number | null;
  sample: {
    n: number;
    mcp: number;
    a2a: number;
    x402: number;
    active: number;
    trusts: Record<string, number>;
    ratings: number;
    medianScore: number | null;
  } | null;
  error?: string;
}
interface Payload {
  ok: boolean;
  asOf?: string;
  rows: Row[];
  totalAgents: number;
  totalFeedback: number;
  answered: number;
  attempted: number;
  note: string | null;
}

export function AgentEconomy() {
  const { data, loading, failed } = useApi<Payload>("/api/agents", 1800);

  const body = () => {
    if (loading) return <Loading rows={5} />;
    if (failed || !data?.ok) {
      return (
        <>
          <Unavailable what="The agent registry read" />
          {data?.note && <p className="mt-2 text-[12px] text-[var(--text3)]">{data.note}</p>}
        </>
      );
    }
    return (
      <>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text2)]">
          {num(data.totalAgents, 0)} agents hold an ERC-8004 identity across {data.answered} chains,
          and clients have written {num(data.totalFeedback, 0)} ratings about them. Read the last
          column rather than the first: an identity is close to free, a rating is not, so the ratio
          is what says whether a chain is hosting an agent economy or a registration queue.
        </p>

        <TableWrap maxHeight={320}>
          <thead>
            <tr>
              <Th label="Chain" />
              <Th label="Agents" num hint="Holding an ERC-8004 identity on this chain, cumulative since the registry was deployed. An identity is an ERC-721 token that resolves to an agent's metadata, so this counts registrations rather than working software." />
              <Th label="24h" num hint="New identities registered yesterday. Taken as the difference between two cumulative daily counters, because the registry reports a running total rather than a per-day count." />
              <Th label="7d" num hint="New identities over the past seven days, on the same basis." />
              <Th label="Ratings" num hint="Feedback records written by clients about agents, cumulative. A rating is an onchain attestation with a score, so somebody had to use the agent and then pay to say so." />
              <Th label="Per agent" num hint="Ratings divided by agents. Registration is close to free and a rating is not, so this separates a chain where agents are being used from one where they are only being created. Below about 0.1 the registry is mostly empty identities." />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.chain}>
                <td>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: brandColor(r.chain) ?? "var(--text3)" }}
                      aria-hidden
                    />
                    <span className="break-words font-semibold text-[var(--text)]">{r.chain}</span>
                  </div>
                </td>
                {r.error ? (
                  <td colSpan={5} className="break-words text-[11px] text-[var(--text3)]">
                    {r.error}
                  </td>
                ) : (
                  <>
                    <td className="num font-semibold text-[var(--text)]">{num(r.agents, 0)}</td>
                    <td className="num text-[var(--text2)]">
                      {r.newAgents24h == null ? "n/a" : `+${num(r.newAgents24h, 0)}`}
                    </td>
                    <td className="num text-[var(--text2)]">
                      {r.newAgents7d == null ? "n/a" : `+${num(r.newAgents7d, 0)}`}
                    </td>
                    <td className="num text-[var(--text2)]">{num(r.feedback, 0)}</td>
                    <td
                      className="num font-semibold"
                      style={{ color: density(r.feedbackPerAgent) }}
                    >
                      {r.feedbackPerAgent == null ? "n/a" : r.feedbackPerAgent.toFixed(2)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {/* No count of chains that did not answer. The row carries its own
            reason, in place, and a line underneath saying one row has a reason
            on it is the sentence a reader has already read. */}
        {/* What the newest registrations can do.
            Counts with their denominator rather than percentages, because the
            rows behind this are the most recent five hundred per chain and not
            a census: "29% of agents speak MCP" would be a claim about half a
            million of them and would be false. */}
        {(() => {
          const s = data.rows.map((r) => r.sample).filter((x): x is NonNullable<typeof x> => !!x);
          if (!s.length) return null;
          const sum = (k: "n" | "mcp" | "a2a" | "x402") => s.reduce((t, x) => t + x[k], 0);
          const scored = s.filter((x) => x.medianScore != null);
          const trusts: Record<string, number> = {};
          for (const x of s) for (const [k, v] of Object.entries(x.trusts)) trusts[k] = (trusts[k] ?? 0) + v;
          const top = Object.entries(trusts).sort((a, b) => b[1] - a[1]).slice(0, 3);
          const n = sum("n");
          return (
            <div className="mt-3 border-t border-[var(--border2)] pt-3">
              <div className="mb-2 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
                what the newest {num(n, 0)} registrations declare
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <Stat label="speak MCP" value={`${num(sum("mcp"), 0)} of ${num(n, 0)}`} />
                <Stat label="speak A2A" value={`${num(sum("a2a"), 0)} of ${num(n, 0)}`} />
                <Stat label="take x402 payments" value={`${num(sum("x402"), 0)} of ${num(n, 0)}`} />
                <Stat
                  label="median rating"
                  value={
                    scored.length
                      ? `${Math.round(scored.reduce((t, x) => t + (x.medianScore as number), 0) / scored.length)} of 100`
                      : "n/a"
                  }
                />
              </div>
              {top.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
                    trust model
                  </span>
                  {top.map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-px font-mono text-[10px] text-[var(--text2)]"
                    >
                      {k} {num(v, 0)}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text3)]">
                A recent sample rather than a census: the newest five hundred registrations on each
                chain, which is what the gateway will return in one page. It says where the standard
                is heading rather than what the whole population looks like.
              </p>
            </div>
          );
        })()}

        {data.asOf && <AsOf iso={data.asOf} staleMs={2 * 60 * 60 * 1000} />}
      </>
    );
  };

  return (
    <Section
      title="Agent economy"
      id="agents"
      hint="ERC-8004 gives an agent an onchain identity and a reputation, in registries deployed once per chain, read here through The Graph's Agent0 subgraphs. Validation records are indexed and empty on every chain, which is the standard's current state rather than a gap here."
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">{label}</div>
      <div className="font-mono text-[13px] font-semibold text-[var(--text)]">{value}</div>
    </div>
  );
}

/**
 * Colour only the two ends.
 *
 * A chain with more ratings than agents is one where agents are being used
 * repeatedly. Below a tenth of a rating per agent the registry is mostly empty
 * identities. In between says nothing worth colouring.
 */
function density(v: number | null): string | undefined {
  if (v == null) return undefined;
  if (v >= 1) return "var(--pos)";
  if (v < 0.1) return "var(--text3)";
  return undefined;
}

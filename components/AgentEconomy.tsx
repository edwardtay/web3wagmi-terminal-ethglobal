"use client";

import { Fragment, useState } from "react";
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
  registries: {
    identityRegistry?: string | null;
    reputationRegistry?: string | null;
    validationRegistry?: string | null;
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
  readings: { finding: string; figure: string; basis: string }[];
  rated: {
    chain: string;
    agentId: string;
    name: string | null;
    ratings: number;
    shareOfChain: number | null;
    speaks: string[];
  }[];
  note: string | null;
}

/** How many columns the chain table has, so a detail row can span them. */
const CHAIN_COLUMNS = 9;

export function AgentEconomy() {
  const { data, loading, failed } = useApi<Payload>("/api/agents", 1800);
  const [open, setOpen] = useState<string | null>(null);

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
        {/* The findings, as a table.
            Written as prose first and seven paragraphs of it was a wall: a
            reader had to get through a clause explaining what a registry is
            before reaching the number. A finding is a claim, a figure and the
            arithmetic behind it, and those are columns. */}
        {data.readings.length > 0 && (
          <div className="mb-4">
            <TableWrap maxHeight={340}>
              <thead>
                <tr>
                  <Th label="Finding" />
                  <Th label="Figure" />
                  <Th label="Basis" hint="The counts the figure was computed from, so it can be checked against the tables below rather than taken on trust." />
                </tr>
              </thead>
              <tbody>
                {data.readings.map((r) => (
                  <tr key={r.finding}>
                    <td className="break-words font-semibold text-[var(--text)]">{r.finding}</td>
                    <td className="break-words font-mono text-[12px] font-semibold text-[var(--accent)]">
                      {r.figure}
                    </td>
                    <td className="break-words text-[11px] text-[var(--text3)]">{r.basis}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}

        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text2)]">
          {num(data.totalAgents, 0)} identities and {num(data.totalFeedback, 0)} ratings across{" "}
          {data.answered} chains, by chain.
        </p>

        <TableWrap maxHeight={320}>
          <thead>
            <tr>
              <Th label="Chain" />
              <Th label="Agents" num hint="Holding an ERC-8004 identity on this chain, cumulative since the registry was deployed. An identity is an ERC-721 token that resolves to an agent's metadata, so this counts registrations rather than working software." />
              <Th label="24h" num hint="New identities registered yesterday. Taken as the difference between two cumulative daily counters, because the registry reports a running total rather than a per-day count." />
              <Th label="7d" num hint="New identities over the past seven days, on the same basis." />
              <Th label="Ratings" num hint="Feedback records written by clients about agents, cumulative. A rating is an onchain attestation with a score, so somebody had to use the agent and then pay to say so." />
              <Th label="Per agent" num hint="Ratings divided by agents. Registration is close to free and a rating is not, so this separates a chain where agents are being used from one where they are only being created. Read it beside the table below: an average of five is one busy agent and a long tail, not five busy agents." />
              <Th label="MCP" num hint="Of the newest 500 registrations on this chain, how many expose a Model Context Protocol endpoint. A sample of recent filings rather than a census." />
              <Th label="A2A" num hint="Of the same 500, how many expose an agent-to-agent endpoint." />
              <Th label="x402" num hint="Of the same 500, how many accept x402 payments, meaning the agent can be paid for a call rather than only registered." />
              <Th label="Rating" num hint="Median score out of 100 among the newest ratings on this chain. Withheld below twenty scored ratings, because a median wants a distribution rather than one opinion." />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <Fragment key={r.chain}>
              <tr
                onClick={() => !r.error && setOpen((v) => (v === r.chain ? null : r.chain))}
                className={r.error ? undefined : "cursor-pointer"}
              >
                <td>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: brandColor(r.chain) ?? "var(--text3)" }}
                      aria-hidden
                    />
                    <span className="break-words font-semibold text-[var(--text)]">{r.chain}</span>
                  </div>
                  {!r.error && (
                    <div className="font-mono text-[9px] text-[var(--text3)]">
                      {open === r.chain ? "hide" : "detail"}
                    </div>
                  )}
                </td>
                {r.error ? (
                  <td colSpan={9} className="break-words text-[11px] text-[var(--text3)]">
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
                    <td className="num text-[var(--text2)]">{share(r.sample?.mcp, r.sample?.n)}</td>
                    <td className="num text-[var(--text2)]">{share(r.sample?.a2a, r.sample?.n)}</td>
                    <td className="num text-[var(--text2)]">{share(r.sample?.x402, r.sample?.n)}</td>
                    <td className="num text-[var(--text2)]">
                      {r.sample?.medianScore == null ? "n/a" : r.sample.medianScore}
                    </td>
                  </>
                )}
              </tr>
              {open === r.chain && !r.error && (
                <ChainDetail row={r} agents={data.rated.filter((a) => a.chain === r.chain)} />
              )}
              </Fragment>
            ))}
          </tbody>
        </TableWrap>

        {/* No count of chains that did not answer. The row carries its own
            reason, in place, and a line underneath saying one row has a reason
            on it is the sentence a reader has already read. */}
        {/* Who actually holds the ratings.
            The per-agent average above is arithmetically true and describes
            nobody: Base averages more than five ratings an agent because one
            agent holds most of them. A mean cannot show that and a share can,
            so the concentration is named rather than left in the average. */}
        {data.rated.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
              most rated agents
            </div>
            <TableWrap maxHeight={280}>
              <thead>
                <tr>
                  <Th label="Agent" />
                  <Th label="Chain" />
                  <Th label="Speaks" hint="Which protocols its registration file declares: a Model Context Protocol endpoint, an agent-to-agent endpoint, and whether it can be paid over x402." />
                  <Th label="Ratings" num hint="Ratings written about this agent, cumulative." />
                  <Th label="Share" num hint="This agent's share of every rating written on its chain. It is the number that says whether a chain has an agent economy or one busy agent." />
                </tr>
              </thead>
              <tbody>
                {data.rated.map((a) => (
                  <tr key={`${a.chain}-${a.agentId}`}>
                    <td className="break-words font-semibold text-[var(--text)]">
                      {a.name ?? <span className="font-normal text-[var(--text3)]">no registration file</span>}
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: brandColor(a.chain) ?? "var(--text3)" }}
                          aria-hidden
                        />
                        <span className="text-[var(--text2)]">{a.chain}</span>
                      </div>
                    </td>
                    <td>
                      {a.speaks.length === 0 ? (
                        <span className="text-[11px] text-[var(--text3)]">not declared</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {a.speaks.map((k) => (
                            <span
                              key={k}
                              className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-px font-mono text-[10px] text-[var(--text2)]"
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num font-semibold text-[var(--text)]">{num(a.ratings, 0)}</td>
                    <td
                      className="num font-semibold"
                      style={{ color: (a.shareOfChain ?? 0) >= 0.25 ? "var(--gold)" : undefined }}
                    >
                      {a.shareOfChain == null ? "n/a" : `${(a.shareOfChain * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        )}
      </>
    );
  };

  return (
    <Section
      title="Agent economy"
      id="agents"
      hint="ERC-8004 gives an agent an onchain identity and a reputation, in registries deployed once per chain, read here through The Graph's Agent0 subgraphs and cross-checked against 8004scan. The MCP, A2A and x402 columns are the newest 500 registrations per chain, which is one page from the gateway, so they say where the standard is heading rather than what the whole population looks like. Validation records are indexed and empty everywhere, which is the standard's current state rather than a gap here."
      right={<AsOf iso={data?.asOf} staleMs={2 * 60 * 60 * 1000} />}
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

/**
 * One chain, opened up.
 *
 * The row answers how many and how active. What it cannot carry without
 * becoming unreadable is the trust model split, how much of the sample is
 * still marked active, what the median rests on, and the three contracts the
 * registries actually live at. That last one matters most: an address is the
 * thing a reader can paste into a block explorer and check for themselves,
 * which is a different kind of claim from a number on a page.
 */
function ChainDetail({ row, agents }: { row: Row; agents: Payload["rated"] }) {
  const s = row.sample;
  const trusts = Object.entries(s?.trusts ?? {}).sort((a, b) => b[1] - a[1]);
  const reg = row.registries;
  return (
    <tr>
      <td colSpan={CHAIN_COLUMNS} className="bg-[var(--bg2)] p-0">
        {/* Pinned left and sized to the window, because a full-width cell in a
            scrolling table is as wide as the table and none of this is tabular. */}
        <div className="sticky left-0 w-[min(100%,100vw-2rem)] space-y-2.5 px-3 py-3">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[11px]">
            <span className="text-[var(--text3)]">
              active <span className="font-mono font-semibold text-[var(--text2)]">{s ? `${s.active} of ${s.n}` : "n/a"}</span>
            </span>
            <span className="text-[var(--text3)]">
              median rating{" "}
              <span className="font-mono font-semibold text-[var(--text2)]">
                {s?.medianScore == null ? "withheld" : `${s.medianScore} of 100`}
              </span>{" "}
              {s ? `on ${s.ratings} scored` : ""}
            </span>
          </div>

          {trusts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">trust model</span>
              {trusts.map(([k, v]) => (
                <span key={k} className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-px font-mono text-[10px] text-[var(--text2)]">
                  {k} {v}
                </span>
              ))}
            </div>
          )}

          {agents.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
                most rated here
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                {agents.map((a) => (
                  <span key={a.agentId} className="text-[var(--text2)]">
                    {a.name ?? "unnamed"}{" "}
                    <span className="font-mono text-[var(--text3)]">{num(a.ratings, 0)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {reg && (
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">
                registries, singleton per chain
              </div>
              <div className="space-y-0.5 font-mono text-[10px] text-[var(--text3)]">
                {([["identity", reg.identityRegistry], ["reputation", reg.reputationRegistry], ["validation", reg.validationRegistry]] as const).map(
                  ([label, addr]) =>
                    addr ? (
                      <div key={label} className="break-all">
                        <span className="text-[var(--text2)]">{label}</span> {addr}
                      </div>
                    ) : null
                )}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/** A count against its own denominator, which never leaves the number's side. */
function share(k: number | undefined, n: number | undefined): string {
  if (k == null || !n) return "n/a";
  return `${k} / ${n}`;
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

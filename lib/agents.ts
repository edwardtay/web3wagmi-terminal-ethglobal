import "server-only";
import { postJsonWithHeaders } from "./http";

// The onchain agent economy, from ERC-8004.
//
// ERC-8004 gives an autonomous agent three things onchain: an identity, a
// reputation, and a record of independent validation. The Graph indexes all
// three registries through the Agent0 subgraphs, one deployment per chain, and
// that is the only reason this desk can exist: the registries are singletons
// per chain with no shared aggregator, so counting the agent economy without a
// subgraph means running an indexer per chain yourself.
//
// The reading here is not the headcount. Registering an agent is close to free,
// so a chain can carry hundreds of thousands of them and mean nothing by it.
// Feedback is the part that costs somebody something: a client has to have used
// an agent and then written a rating about it. Feedback per agent separates a
// working economy from a registration farm, and the two look identical in a
// column of totals.

const GATEWAY = "https://gateway.thegraph.com/api";

/**
 * One Agent0 deployment per chain, from The Graph's own docs.
 *
 * Mainnets only. The testnet deployments exist and are excluded: a testnet
 * agent count is a measure of how many people are trying the standard, which is
 * a different question from how much of it is in production, and mixing the two
 * would flatter the number.
 */
const CHAINS: { label: string; id: string }[] = [
  { label: "BSC", id: "D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K" },
  { label: "Base", id: "43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb" },
  { label: "Ethereum", id: "FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k" },
  { label: "Polygon", id: "9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF" },
  { label: "Monad", id: "4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg" },
];

/**
 * Eight daily buckets, because the newest is today and the eighth is a week
 * back, which is what a seven day change needs.
 *
 * The registration and feedback counters are cumulative rather than per bucket,
 * so growth is the difference between two of them. Reading them as daily counts
 * would report fifty thousand new agents a day on Ethereum instead of twenty
 * seven.
 */
export const AGENT_QUERY = `{
  agents: protocolAgentStats_collection(interval: day, first: 8, orderBy: timestamp, orderDirection: desc) {
    timestamp
    agentRegistrations
  }
  feedback: protocolFeedbackStats_collection(interval: day, first: 8, orderBy: timestamp, orderDirection: desc) {
    timestamp
    feedbackCreated
  }
}`;

export interface AgentChainRow {
  chain: string;
  /** Agents registered on this chain, cumulative. */
  agents: number | null;
  /** New registrations yesterday, and over the past seven days. */
  newAgents24h: number | null;
  newAgents7d: number | null;
  /** Ratings written by clients about agents, cumulative. */
  feedback: number | null;
  /**
   * Feedback per agent. Registration is close to free and a rating is not, so
   * this is the column that says whether anything is actually being used.
   */
  feedbackPerAgent: number | null;
  /** Why this chain did not answer, when it did not. */
  error?: string;
}

export interface AgentEconomy {
  query: string;
  rows: AgentChainRow[];
  totalAgents: number;
  totalFeedback: number;
  answered: number;
  attempted: number;
}

interface Bucket {
  timestamp?: string;
  agentRegistrations?: string;
  feedbackCreated?: string;
}
interface Reply {
  data?: { agents?: Bucket[]; feedback?: Bucket[] };
  errors?: { message?: string }[];
}

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Newest cumulative value, and its change against the bucket `back` ago. */
function series(buckets: Bucket[] | undefined, field: "agentRegistrations" | "feedbackCreated") {
  const rows = buckets ?? [];
  const latest = n(rows[0]?.[field]);
  const at = (i: number) => (rows.length > i ? n(rows[i]?.[field]) : null);
  const delta = (i: number) => {
    const then = at(i);
    return latest != null && then != null ? latest - then : null;
  };
  return { latest, d1: delta(1), d7: delta(7) };
}

export async function readAgentEconomy(revalidate: number): Promise<AgentEconomy | null> {
  if (!process.env.GRAPH_SUBGRAPH_KEY) return null;

  const replies = await Promise.all(
    CHAINS.map((c) =>
      postJsonWithHeaders<Reply>(
        `${GATEWAY}/${process.env.GRAPH_SUBGRAPH_KEY}/subgraphs/id/${c.id}`,
        { query: AGENT_QUERY },
        [],
        { revalidate, timeout: 30_000 }
      )
    )
  );

  const rows: AgentChainRow[] = CHAINS.map((c, i) => {
    const blank = {
      chain: c.label,
      agents: null,
      newAgents24h: null,
      newAgents7d: null,
      feedback: null,
      feedbackPerAgent: null,
    };
    const reply = replies[i];
    if (!reply) return { ...blank, error: "No answer from the gateway." };
    const body = reply.body;
    if (body.errors?.length) {
      // Named rather than dropped. "bad indexers: unavailable" is a fact about
      // the network on the day, and a chain silently missing from this table
      // would read as a chain with no agents on it.
      return { ...blank, error: String(body.errors[0]?.message ?? "Query rejected.").slice(0, 120) };
    }
    const a = series(body.data?.agents, "agentRegistrations");
    const f = series(body.data?.feedback, "feedbackCreated");
    return {
      chain: c.label,
      agents: a.latest,
      newAgents24h: a.d1,
      newAgents7d: a.d7,
      feedback: f.latest,
      feedbackPerAgent: a.latest && a.latest > 0 && f.latest != null ? f.latest / a.latest : null,
    };
  });

  const answered = rows.filter((r) => !r.error).length;
  return {
    query: AGENT_QUERY,
    rows: rows.sort((x, y) => (y.agents ?? -1) - (x.agents ?? -1)),
    totalAgents: rows.reduce((t, r) => t + (r.agents ?? 0), 0),
    totalFeedback: rows.reduce((t, r) => t + (r.feedback ?? 0), 0),
    answered,
    attempted: rows.length,
  };
}

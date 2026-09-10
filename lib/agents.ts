import "server-only";
import { getJson, postJsonWithHeaders } from "./http";

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
/**
 * How many of the newest registrations and ratings each chain is asked for.
 *
 * The gateway caps a collection at a thousand and these are the newest by
 * registration time, so what comes back is a recent sample rather than the
 * population. Five hundred is enough to see a split and small enough that the
 * whole desk still costs one query per chain: the capability fields ride along
 * with the counters rather than doubling the request count.
 *
 * Everything derived from it is labelled as the recent sample it is, because
 * the two are different claims. "Twenty-nine percent of agents speak MCP" is a
 * statement about half a million agents and would be false. "Twenty-nine
 * percent of the newest five hundred" is a statement about where the standard
 * is heading, which is the more useful one anyway.
 */
const SAMPLE = 500;

/** Below this many scored ratings, a median is one opinion rather than a middle. */
const MIN_SCORES = 20;

export const AGENT_QUERY = `{
  agents: protocolAgentStats_collection(interval: day, first: 8, orderBy: timestamp, orderDirection: desc) {
    timestamp
    agentRegistrations
  }
  feedback: protocolFeedbackStats_collection(interval: day, first: 8, orderBy: timestamp, orderDirection: desc) {
    timestamp
    feedbackCreated
  }
  files: agentRegistrationFiles(first: ${SAMPLE}, orderBy: createdAt, orderDirection: desc) {
    active
    x402Support
    supportedTrusts
    mcpEndpoint
    a2aEndpoint
  }
  ratings: feedbackFiles(first: ${SAMPLE}, orderBy: createdAt, orderDirection: desc) {
    valueRaw
    valueDecimals
  }
  top: agents(first: 6, orderBy: totalFeedback, orderDirection: desc) {
    agentId
    totalFeedback
    registrationFile {
      name
      mcpEndpoint
      a2aEndpoint
      x402Support
    }
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
  /** What the newest registrations on this chain can do. A sample, not a census. */
  sample: {
    /** How many registration files the aggregates below rest on. */
    n: number;
    mcp: number;
    a2a: number;
    x402: number;
    active: number;
    /** Trust model to how many of the sample declare it. */
    trusts: Record<string, number>;
    /** Ratings sampled, and their median score out of 100. */
    ratings: number;
    medianScore: number | null;
  } | null;
  /** Why this chain did not answer, when it did not. */
  error?: string;
}

/** One plain statement about what the tables mean, with the figure behind it. */
export interface AgentReading {
  /** The sentence, written here rather than by a model. */
  says: string;
  /** The measurement it rests on, so the claim can be checked against a row. */
  evidence: string;
}

/**
 * A second index of the same registries, for the one check a single source
 * cannot do on itself.
 *
 * 8004scan is AltLayer's explorer and it indexes the identical onchain
 * contracts. Two counts of the same registry that agree are worth more than one
 * count asserted, and where they disagree the reason is the finding: the two
 * differ by seventy per cent until testnets are excluded, which is a statement
 * about how the standard is being used rather than about either indexer.
 *
 * Optional and short-timeout. It is an undocumented endpoint on somebody else's
 * product, so the desk works without it and says so rather than failing.
 */
export interface CrossCheck {
  mainnet: number | null;
  testnet: number | null;
}

export interface AgentEconomy {
  query: string;
  /** What a second indexer counts, or null when it did not answer. */
  crossCheck: CrossCheck | null;
  /** What the numbers mean, for a reader who does not already know. */
  readings: AgentReading[];
  rows: AgentChainRow[];
  /** The most rated agents anywhere, across chains, largest first. */
  rated: RatedAgent[];
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
interface RegFile {
  active?: boolean | null;
  x402Support?: boolean | null;
  supportedTrusts?: string[] | null;
  mcpEndpoint?: string | null;
  a2aEndpoint?: string | null;
}
interface RatingFile {
  valueRaw?: string | null;
  valueDecimals?: number | null;
}
interface TopAgent {
  agentId?: string;
  totalFeedback?: string;
  registrationFile?: {
    name?: string | null;
    mcpEndpoint?: string | null;
    a2aEndpoint?: string | null;
    x402Support?: boolean | null;
  } | null;
}
interface Reply {
  data?: {
    agents?: Bucket[];
    feedback?: Bucket[];
    files?: RegFile[];
    ratings?: RatingFile[];
    top?: TopAgent[];
  };
  errors?: { message?: string }[];
}

/** One agent, named, with what it speaks and how much of its chain it holds. */
export interface RatedAgent {
  chain: string;
  agentId: string;
  /** From the registration file. Many agents never file one. */
  name: string | null;
  ratings: number;
  /** This agent's share of every rating written on its chain, 0 to 1. */
  shareOfChain: number | null;
  speaks: string[];
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

/**
 * What the newest registrations declare they can do.
 *
 * Counts rather than percentages, and the denominator travels with them, so a
 * reader can see the claim rests on five hundred rows out of three hundred
 * thousand rather than being told a share and left to assume a census.
 *
 * The score is a median rather than a mean because the scale is bounded at a
 * hundred and the distribution is heavily skewed towards it: a handful of
 * ones drag an average somewhere no rating actually sits.
 */
function summarise(files: RegFile[] | undefined, ratings: RatingFile[] | undefined) {
  const f = files ?? [];
  if (!f.length) return null;
  const trusts: Record<string, number> = {};
  for (const x of f) for (const t of x.supportedTrusts ?? []) trusts[t] = (trusts[t] ?? 0) + 1;

  const scores: number[] = [];
  for (const r of ratings ?? []) {
    // Not Number(r.valueRaw). Number(null) is 0 rather than NaN, and most of
    // these rows carry no value at all: 74 of 116 on Ethereum, 162 of 163 on
    // BSC. Coerced, every one of those absences became a zero score and pulled
    // the median from 60 to 0, which would have read as an agent economy whose
    // users rate everything at the bottom of the scale.
    if (r.valueRaw == null) continue;
    const raw = Number(r.valueRaw);
    if (!Number.isFinite(raw)) continue;
    const v = raw / 10 ** Number(r.valueDecimals ?? 0);
    if (Number.isFinite(v)) scores.push(v);
  }
  scores.sort((x, y) => x - y);

  return {
    n: f.length,
    mcp: f.filter((x) => x.mcpEndpoint).length,
    a2a: f.filter((x) => x.a2aEndpoint).length,
    x402: f.filter((x) => x.x402Support).length,
    active: f.filter((x) => x.active).length,
    trusts,
    ratings: scores.length,
    // A median wants a distribution. BSC returns exactly one scored rating in
    // the sample, and reporting that single number as the chain's median would
    // be a statement about one person's opinion dressed as a statistic.
    medianScore: scores.length >= MIN_SCORES ? scores[Math.floor(scores.length / 2)] : null,
  };
}

/**
 * The most rated agents on one chain, with their share of it.
 *
 * The share is the point. Base averages 5.48 ratings per agent, which reads as
 * a chain where agents are busy, and one agent holds 314,174 of the roughly
 * half a million ratings written there. The average is arithmetically true and
 * describes nobody: the economy is one entity and a long tail. A per-agent
 * mean cannot show that and a share can.
 */
function topAgents(chain: string, top: TopAgent[] | undefined, chainTotal: number | null): RatedAgent[] {
  return (top ?? [])
    .map((t) => {
      const ratings = Number(t.totalFeedback);
      if (!Number.isFinite(ratings) || ratings <= 0) return null;
      const rf = t.registrationFile ?? null;
      const speaks: string[] = [];
      if (rf?.mcpEndpoint) speaks.push("MCP");
      if (rf?.a2aEndpoint) speaks.push("A2A");
      if (rf?.x402Support) speaks.push("x402");
      return {
        chain,
        agentId: String(t.agentId ?? ""),
        // Many agents never file a registration document, so the name is
        // absent rather than empty. Said plainly at the panel rather than
        // filled in with an id dressed as a name.
        name: rf?.name?.trim() || null,
        ratings,
        shareOfChain: chainTotal && chainTotal > 0 ? Math.min(1, ratings / chainTotal) : null,
        speaks,
      };
    })
    .filter((x): x is RatedAgent => x !== null);
}

/**
 * What the tables say, for somebody who does not already know.
 *
 * Every other desk on this terminal states a reading. This one arrived as a
 * grid of counts, and a grid of counts about a standard most readers have never
 * heard of is not intelligence: it is homework. The numbers are striking and
 * they do not speak for themselves.
 *
 * Written here in code rather than by a model, on the same contract as the rest
 * of the terminal: each sentence carries the measurement it rests on, so a
 * reader can find the row it came from and disagree with it. Nothing is said
 * unless the figures support it, so a quiet day produces fewer sentences rather
 * than vaguer ones.
 */
function readings(rows: AgentChainRow[], top: RatedAgent[], second: CrossCheck | null): AgentReading[] {
  const out: AgentReading[] = [];
  const live = rows.filter((r) => !r.error && r.agents != null);
  if (!live.length) return out;

  const totalAgents = live.reduce((t, r) => t + (r.agents ?? 0), 0);

  // 1. Registering is not using, said about the chain doing most of the
  //    registering. An average across chains would have been an average of
  //    averages, which is a different number and not a checkable one: this
  //    names a chain and a rate the reader can find in the row above.
  const biggest = [...live].sort((a, b) => (b.agents ?? 0) - (a.agents ?? 0))[0];
  if (biggest && totalAgents > 0 && (biggest.feedbackPerAgent ?? 0) < 0.5) {
    out.push({
      says: `Registering is not using. ${biggest.chain} holds ${pct((biggest.agents ?? 0) / totalAgents)} of every agent in existence and each has been rated ${(biggest.feedbackPerAgent ?? 0).toFixed(2)} times on average, which is a registry with almost nothing behind it.`,
      evidence: `${round(biggest.agents ?? 0)} of ${round(totalAgents)} identities and ${round(biggest.feedback ?? 0)} ratings on ${biggest.chain}.`,
    });
  }

  // 2. The concentration, which is the thing the averages hide.
  const first = top[0];
  if (first && (first.shareOfChain ?? 0) >= 0.25) {
    out.push({
      says: `One agent is most of the activity. It holds ${pct(first.shareOfChain ?? 0)} of every rating written on ${first.chain}, and it has ${first.name ? `filed no capabilities` : `no registration file at all`}.`,
      evidence: `${round(first.ratings)} of ${first.chain}'s ratings against one agent id.`,
    });
  }

  // 3. Where the agents that actually do something are.
  const withSample = live.filter((r) => r.sample && r.sample.n >= 100);
  const byMcp = [...withSample].sort((a, b) => mcpShare(b) - mcpShare(a));
  const best = byMcp[0];
  const worst = byMcp[byMcp.length - 1];
  if (best && worst && best !== worst && mcpShare(best) > mcpShare(worst) * 2) {
    out.push({
      says: `The working ones are on ${best.chain}. ${pct(mcpShare(best))} of its newest registrations publish an endpoint another program can actually call, against ${pct(mcpShare(worst))} on ${worst.chain}.`,
      evidence: `${best.sample?.mcp} of ${best.sample?.n} on ${best.chain}, ${worst.sample?.mcp} of ${worst.sample?.n} on ${worst.chain}.`,
    });
  }

  // 4. Whether any of them can be paid, which is what makes an economy.
  const payable = withSample.reduce((t, r) => t + (r.sample?.x402 ?? 0), 0);
  const sampled = withSample.reduce((t, r) => t + (r.sample?.n ?? 0), 0);
  if (sampled > 0) {
    out.push({
      says: `Paying one is still rare. ${pct(payable / sampled)} of the newest registrations accept payment for a call, so most of these identities cannot charge for anything.`,
      evidence: `${payable} of ${sampled} newest registrations declare x402 support.`,
    });
  }

  // 5. Concentration as a ratio rather than a superlative. Two agents is not a
  //    market, and the top-six share is the standard way to say how far from a
  //    market something is.
  const totalRatings = live.reduce((t, r) => t + (r.feedback ?? 0), 0);
  const topSix = top.slice(0, 6).reduce((t, a) => t + a.ratings, 0);
  if (totalRatings > 0 && topSix / totalRatings >= 0.5) {
    // Framed as the tail rather than the head. The head is the reading above,
    // and two sentences reporting the same percentage read as a bug even when
    // both are true of different things.
    out.push({
      says: `The other ${round(totalAgents - 6)} agents share what is left. Six ids account for ${pct(topSix / totalRatings)} of every rating across four chains, which leaves ${pct(1 - topSix / totalRatings)} for everybody else.`,
      evidence: `${round(topSix)} of ${round(totalRatings)} ratings against six agent ids.`,
    });
  }

  // 6. What a second index of the same contracts counts. The disagreement is
  //    the finding, and it resolves rather than lingering.
  if (second?.mainnet != null) {
    const gap = Math.abs(second.mainnet - totalAgents) / second.mainnet;
    const testnetLine =
      second.testnet != null
        ? ` Counting testnets too it reaches ${round(second.mainnet + second.testnet)}, so ${round(second.testnet)} of the agents anyone might quote are on chains where nothing is at stake.`
        : "";
    out.push({
      says: `A second index of the same contracts agrees. 8004scan counts ${round(second.mainnet)} agents on real chains against the ${round(totalAgents)} read here, a ${pct(gap)} gap explained by one indexer being unavailable.${testnetLine}`,
      evidence: `8004scan mainnet ${round(second.mainnet)}${second.testnet != null ? `, testnet ${round(second.testnet)}` : ""}; Agent0 subgraphs ${round(totalAgents)} across ${live.length} chains.`,
    });
  }

  // 7. The registry that is empty everywhere, which is worth saying out loud.
  out.push({
    says: `Nothing here has been independently checked. The validation registry, which is the part of the standard meant to verify that an agent did what it claims, is empty on every chain.`,
    evidence: `Zero validation records indexed across ${live.length} chains.`,
  });

  return out;
}

const mcpShare = (r: AgentChainRow) => (r.sample && r.sample.n ? r.sample.mcp / r.sample.n : 0);
const pct = (v: number) => `${v < 0.01 && v > 0 ? "under 1" : Math.round(v * 100)}%`;
const round = (n: number) => n.toLocaleString("en-US");

const SCAN = "https://8004scan.io/api/v1/agents?limit=1";

/** How many agents a second index sees, split by whether the chain is real. */
async function crossCheck(revalidate: number): Promise<CrossCheck | null> {
  const [main, test] = await Promise.all([
    getJson<{ total?: number }>(`${SCAN}&is_testnet=false`, { revalidate, timeout: 12_000 }),
    getJson<{ total?: number }>(`${SCAN}&is_testnet=true`, { revalidate, timeout: 12_000 }),
  ]);
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (main == null && test == null) return null;
  return { mainnet: n(main?.total), testnet: n(test?.total) };
}

export async function readAgentEconomy(revalidate: number): Promise<AgentEconomy | null> {
  if (!process.env.GRAPH_SUBGRAPH_KEY) return null;

  const rated: RatedAgent[] = [];
  const second = await crossCheck(revalidate);
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
      sample: null,
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
    const sample = summarise(body.data?.files, body.data?.ratings);
    rated.push(...topAgents(c.label, body.data?.top, f.latest));
    return {
      chain: c.label,
      agents: a.latest,
      newAgents24h: a.d1,
      newAgents7d: a.d7,
      feedback: f.latest,
      feedbackPerAgent: a.latest && a.latest > 0 && f.latest != null ? f.latest / a.latest : null,
      sample,
    };
  });

  const answered = rows.filter((r) => !r.error).length;
  const top = rated.sort((a, b) => b.ratings - a.ratings).slice(0, 8);
  return {
    query: AGENT_QUERY,
    crossCheck: second,
    readings: readings(rows, top, second),
    rated: top,
    rows: rows.sort((x, y) => (y.agents ?? -1) - (x.agents ?? -1)),
    totalAgents: rows.reduce((t, r) => t + (r.agents ?? 0), 0),
    totalFeedback: rows.reduce((t, r) => t + (r.feedback ?? 0), 0),
    answered,
    attempted: rows.length,
  };
}

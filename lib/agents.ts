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
  registries: protocols(first: 1) {
    identityRegistry
    reputationRegistry
    validationRegistry
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
  /** The three singleton contracts this chain's registries live at. */
  registries: Registry | null;
  /** Why this chain did not answer, when it did not. */
  error?: string;
}

/**
 * One finding, as three columns rather than a sentence.
 *
 * Written as prose first, and seven paragraphs of it was a wall: the reader had
 * to get through a clause about what a registry is before reaching the number
 * that mattered. A finding is a claim, a figure and the arithmetic behind it,
 * and those are columns. The claim carries no number, the figure carries no
 * words, and the basis is the raw counts so the figure can be checked.
 */
export interface AgentReading {
  /** The claim, in a handful of words and never a number. */
  finding: string;
  /** The number it turns on. */
  figure: string;
  /** The counts it was computed from. */
  basis: string;
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
interface Registry {
  identityRegistry?: string | null;
  reputationRegistry?: string | null;
  validationRegistry?: string | null;
}
interface Reply {
  data?: {
    registries?: Registry[];
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
  const totalRatings = live.reduce((t, r) => t + (r.feedback ?? 0), 0);

  const biggest = [...live].sort((a, b) => (b.agents ?? 0) - (a.agents ?? 0))[0];
  if (biggest && totalAgents > 0 && (biggest.feedbackPerAgent ?? 0) < 0.5) {
    out.push({
      finding: `Registering is not using`,
      figure: `${(biggest.feedbackPerAgent ?? 0).toFixed(2)} ratings per agent on ${biggest.chain}`,
      basis: `${round(biggest.agents ?? 0)} agents, ${round(biggest.feedback ?? 0)} ratings, ${pct((biggest.agents ?? 0) / totalAgents)} of all identities`,
    });
  }

  const first = top[0];
  if (first && (first.shareOfChain ?? 0) >= 0.25) {
    out.push({
      finding: `One agent is most of the activity`,
      figure: `${pct(first.shareOfChain ?? 0)} of ${first.chain}`,
      basis: `${round(first.ratings)} ratings against one id, ${first.name ? `named ${first.name}` : `no registration file`}`,
    });
  }

  const withSample = live.filter((r) => r.sample && r.sample.n >= 100);
  const byMcp = [...withSample].sort((a, b) => mcpShare(b) - mcpShare(a));
  const best = byMcp[0];
  const worst = byMcp[byMcp.length - 1];
  if (best && worst && best !== worst && mcpShare(best) > mcpShare(worst) * 2) {
    out.push({
      finding: `Callable agents cluster on ${best.chain}`,
      figure: `${pct(mcpShare(best))} vs ${pct(mcpShare(worst))} on ${worst.chain}`,
      basis: `${best.sample?.mcp} of ${best.sample?.n} publish an endpoint, against ${worst.sample?.mcp} of ${worst.sample?.n}`,
    });
  }

  const payable = withSample.reduce((t, r) => t + (r.sample?.x402 ?? 0), 0);
  const sampled = withSample.reduce((t, r) => t + (r.sample?.n ?? 0), 0);
  if (sampled > 0) {
    out.push({
      finding: `Almost none can be paid`,
      figure: `${pct(payable / sampled)} accept x402`,
      basis: `${payable} of ${round(sampled)} newest registrations`,
    });
  }

  const topSix = top.slice(0, 6).reduce((t, a) => t + a.ratings, 0);
  if (totalRatings > 0 && topSix / totalRatings >= 0.5) {
    out.push({
      finding: `Six ids hold the ratings`,
      figure: `${pct(topSix / totalRatings)}, leaving ${pct(1 - topSix / totalRatings)}`,
      basis: `${round(topSix)} of ${round(totalRatings)} ratings, shared by ${round(totalAgents - 6)} other agents`,
    });
  }

  if (second?.mainnet != null) {
    const gap = Math.abs(second.mainnet - totalAgents) / second.mainnet;
    out.push({
      finding: `A second index reconciles`,
      figure: `${pct(gap)} apart`,
      basis: `8004scan ${round(second.mainnet)} on mainnet, Agent0 subgraphs ${round(totalAgents)}; the gap is one unavailable indexer`,
    });
    if (second.testnet != null) {
      const all = second.mainnet + second.testnet;
      out.push({
        finding: `Most quoted totals include testnets`,
        figure: `${pct(second.testnet / all)} are testnet`,
        basis: `${round(second.testnet)} of ${round(all)} agents sit where nothing is at stake`,
      });
    }
  }

  // Empty was the first reading, and it was the weaker one. The registries
  // report their own contract addresses, and the validation registry answers
  // with the zero address on every chain: it is not that nobody has used the
  // third pillar of this standard, it is that the contract does not exist. That
  // came out of putting the addresses on screen, which is a good argument for
  // showing an address rather than a count.
  const undeployed = live.filter((r) => r.registries?.validationRegistry === ZERO_ADDRESS).length;
  out.push(
    undeployed === live.length
      ? {
          finding: `Validation is not deployed`,
          figure: `0x0 on all ${live.length} chains`,
          basis: `the third registry of the standard, meant to verify an agent did what it claims, has no contract behind it`,
        }
      : {
          finding: `Nothing has been validated`,
          figure: `0 records`,
          basis: `the validation registry is empty on all ${live.length} chains`,
        }
  );

  return out;
}

/** A registry pointing here has no contract behind it. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

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
      registries: null,
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
      registries: body.data?.registries?.[0] ?? null,
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

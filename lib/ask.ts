import "server-only";
import { REGIME_MEANING } from "@/app/api/derivs/route";
import { getJson } from "./http";
import { readCoverage } from "./news";
import { SCHEMA_HINT, runModelQuery } from "./subgraph";
import { BY_SYM } from "./symbols";

// The question layer.
//
// The terminal answers "what is the market doing" in about thirty panels. It
// cannot answer "why", because that means joining panels: funding against flow,
// a move against the venue that would have to absorb it. A reader does that
// join in their head, if they know which panels to join.
//
// So the model does not know anything about crypto here. Every number it says
// comes from a tool that reads this terminal's own routes, and each tool
// returns the measurement and its reference together, because a figure without
// its reference is the thing this codebase exists to avoid. The model picks
// tools, joins what comes back, and writes the sentence.
//
// The provider is OpenAI-compatible and set by environment, so it is two
// variables to change rather than a rewrite. Groq is the default because it is
// free and fast enough that an answer lands while the reader is still looking
// at the panel that prompted the question.

const BASE = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

/**
 * Primary keys, comma separated, each with its own daily allowance.
 *
 * The free tier meters tokens per day per account, and that ceiling is low
 * enough to matter: a handful of real questions plus a QA pass exhausts it, and
 * the reader then gets "the model is rate limited" instead of an answer. Three
 * keys is three allowances against the same model, so the assistant stays up
 * through a demo rather than dying in the middle of one.
 *
 * A rate limit belongs to a key rather than to the provider, which is the whole
 * reason this works. Everything else about the request is identical.
 */
const KEYS = (process.env.GROQ_API_KEY ?? process.env.LLM_API_KEY ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

/**
 * Which key to try first.
 *
 * Module scope rather than per request, on purpose. A key that just answered
 * 429 will answer 429 to the next reader too, so starting from the top every
 * time means paying for the same refusal on every question until the day rolls
 * over. Advancing past it once makes the exhausted key cost one request rather
 * than one per question.
 */
let keyCursor = 0;

/**
 * A second provider, tried when the first refuses.
 *
 * Groq's free tier rate limits on bursts and will eventually run out of credit,
 * and a terminal whose assistant dies on the day it is busiest is worse than one
 * that has none. Any OpenAI-compatible host works, so this is two environment
 * variables rather than a second client: set LLM_FALLBACK_BASE_URL,
 * LLM_FALLBACK_KEY and optionally LLM_FALLBACK_MODEL.
 *
 * Only the failures worth retrying trigger it. A 400 means the request was
 * wrong and sending the same thing elsewhere will fail the same way.
 */
const FALLBACK_BASE = process.env.LLM_FALLBACK_BASE_URL;
const FALLBACK_KEY = process.env.LLM_FALLBACK_KEY;
/**
 * Fallback models, best first, comma separated.
 *
 * A list rather than one name because the free tier this points at is genuinely
 * unreliable: the same model and the same request answers 200 one minute and
 * 503 "endpoint is unavailable" the next. One name means the assistant is dead
 * whenever that single endpoint blinks, which during a demo is the whole
 * feature gone. Two independent free models blinking at the same moment is a
 * much rarer event than one blinking.
 *
 * Order is by measured latency with tool calling, which is the thing that
 * matters here: this loop runs up to four round trips, so a model that answers
 * in 50 seconds cannot be first no matter how good it is.
 */
const FALLBACK_MODELS = (process.env.LLM_FALLBACK_MODEL ?? "gpt-4o-mini")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const RETRYABLE = new Set([0, 402, 408, 429, 500, 502, 503, 504]);

/**
 * Tool rounds before the answer is written regardless.
 *
 * Three, raised from two when the subgraph tool arrived. A model writing its
 * own GraphQL will sometimes get a field name wrong, and the round that reads
 * the error and fixes it is the difference between an answer and a shrug. Still
 * capped, because an unbounded loop against a free tier is how a demo dies
 * live.
 */
const MAX_ROUNDS = 3;

export function askReady(): boolean {
  return KEYS.length > 0;
}

// ---- the tools -----------------------------------------------------------

/**
 * Read one of our own API routes, over loopback.
 *
 * The tools go through HTTP rather than importing the route handlers, because
 * the routes hold the caching and a tool that bypassed it would put the metered
 * Graph reads back on every question. They do not go through the public
 * hostname, because that goes through the CDN and the CDN holds these routes
 * for hours.
 *
 * No revalidate window of our own: the route being called already has one, and
 * a second layer here only adds a way for the two to disagree.
 */
export async function readRoute<T>(origin: string, path: string): Promise<T | null> {
  // A cold flow desk builds 176 metered reads before it answers, and every
  // check against the public URL was served by the CDN, so the container's own
  // cache can still be cold when the first question arrives. Timing out here
  // reaches the model as "the desk is unavailable", which is a different and
  // wrong statement.
  return getJson<T>(`${origin}${path}`, { revalidate: 0, timeout: 90_000 });
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>, origin: string) => Promise<unknown>;
}

interface SignalsPayload {
  signals: { kind: string; severity: number; symbol: string | null; headline: string; evidence: string }[];
}

interface NetflowPayload {
  source: string | null;
  windows: string[];
  totals: { reservesUsd: number; stable: Record<string, number | null>; crypto: Record<string, number | null> } | null;
  tokens: {
    sym: string;
    kind: string;
    reservesUsd: number;
    flowUsd: Record<string, number | null>;
    dex?: { liquidityUsd: number; volumeUsd: number; deepest: string | null; inflowVsVolume: number | null } | null;
    holders?: {
      symbol: string;
      holders: number;
      topShare: number | null;
      topCount: number;
      contractShare: number | null;
      walletShare: number | null;
      largest: { share: number; isContract: boolean } | null;
    } | null;
  }[];
  venues: { venue: string; reservesUsd: number; flowUsd: Record<string, number | null> }[];
  coverage: { wallets: number; walletsTracked: number; venues: number };
}

/**
 * What a flow means, in words, decided in code.
 *
 * The sign convention is the trap. A coin arriving on an exchange is bearish
 * and a stablecoin arriving is bullish, both positive numbers. A coin leaving
 * is constructive, a negative number. Three of the four readings run against
 * the intuition that up is good, which is why this is not left to a prompt.
 */
/**
 * Money as the terminal writes it.
 *
 * The model formats badly when handed a raw integer, producing things like
 * "168 139 396 USD". Formatting here means the number in the answer is the
 * number on the panel, character for character.
 */
/** A share as a percentage string, or null. */
function share(v: number | null | undefined): string | null {
  return v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;
}

function usd(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(1)}b`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(0)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

/**
 * The same figure, with enough precision to survive being ranked.
 *
 * usd() rounds to one decimal, which is right for a single number in a
 * sentence and wrong in an ordered list: BSC at $1,603,670, Robinhood Chain at
 * $1,580,488 and Canton at $1,570,300 all print as "$1.6m", and the model
 * reading them back reported a three-way tie that does not exist. Two decimals
 * separate them. The rank field is the real guard, this is so the figures the
 * model quotes agree with it.
 */
function usdRanked(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}b`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}m`;
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(1)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

function reading(kind: string, flow24h: number | null, vsVolume: number | null): string {
  if (flow24h == null) return "No reading: not enough of the sample answered.";
  const size =
    vsVolume == null
      ? ""
      : vsVolume >= 1
        ? ` That is ${vsVolume.toFixed(1)}x everything the deepest onchain pools trade in a day, so it is large against the venue that would have to take it.`
        : ` That is ${vsVolume.toFixed(2)}x a day of onchain volume, so it is small against the venue that would have to take it.`;

  if (kind === "stable") {
    return flow24h > 0
      ? "Stablecoins arrived on exchanges. That is buying power reaching the venues where it can be spent, which is the constructive direction. It is not supply that needs absorbing."
      : "Stablecoins left exchanges. Capital went to self custody or into yield, and it is not sitting at the venues ready to bid.";
  }
  return flow24h > 0
    ? `Coins arrived on exchanges. That adds sellable supply, which is the defensive direction. It is the deposit that precedes a sale, not the sale itself.${size}`
    : "Coins left exchanges. That reduces the supply available to sell at short notice, which is the constructive direction.";
}

interface RevenuePayload {
  apps?: EarnerLike[];
  chains?: EarnerLike[];
}

interface EarnerLike {
  name: string;
  category: string | null;
  fees: Partial<Record<string, number | null>>;
  revenue: Partial<Record<string, number | null>>;
  supply: Partial<Record<string, number | null>>;
  holders: Partial<Record<string, number | null>>;
  takeRate: number | null;
  prior: Partial<Record<string, number | null>>;
}

interface StandardsPayload {
  rows?: {
    label: string;
    name: string | null;
    type: string | null;
    tvlUsd: number | null;
    revenueUsd: number | null;
    users: number | null;
    revenue7dUsd: number | null;
    takePct: number | null;
    staleDays: number | null;
    error?: string;
  }[];
  answered?: number;
  attempted?: number;
}

interface DerivsPayload {
  funding?: {
    sym: string;
    perp: string;
    /** Annualised percent on the CEX leg. */
    annual: number;
    /** Annualised percent on Hyperliquid, null when it is not listed there. */
    hlAnnual: number | null;
    /** CEX minus DEX, in annualised percent. */
    spread: number | null;
  }[];
  hlLiquidations?: { at: string; coin: string; direction: string; notional: number }[];
  hlPlatform?: {
    volumeUsd: number;
    buyUsd: number;
    sellUsd: number;
    transactions: number;
    activeCoins: number;
    liquidationsUsd: number;
    liquidationsCount: number;
  } | null;
  oi?: {
    sym: string;
    /** Notional on the Binance perp. */
    oiUsd: number;
    /** Change in contract count, which is what the regime is read from. */
    oiChangePct: number | null;
    /** Contracts on Hyperliquid, null when the coin is not listed there. */
    hlOi: number | null;
    hlOiChangePct: number | null;
    regime: string;
  }[];
}

export const TOOLS: ToolSpec[] = [
  {
    name: "market_coverage",
    description:
      "What the crypto press is reporting right now, and which assets it is talking about most. Use it when a question asks why something moved, what is going on with an asset, or what the market is focused on. It returns coverage, not causes.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: ["string", "null"],
          description: "Asset to look for in the coverage. Null for the whole feed.",
        },
      },
      required: [],
    },
    async run(args) {
      const sym = typeof args.symbol === "string" ? args.symbol.toUpperCase() : undefined;
      const cov = await readCoverage(sym);
      if (!cov) return { error: "The news desk did not answer." };

      return {
        talkedAboutMost: cov.loudest,
        aboutThisAsset: cov.about ?? null,
        latestHeadlines: cov.latest,
        interpretationNotes:
          "Coverage, not causation. A headline published near a move is not the reason for it. Report what is being covered and let the reader make the connection; never write that an asset moved because of a headline. A null aboutThisAsset means the feed is not covering that asset, which is itself worth saying when a move has no coverage behind it.",
      };
    },
  },
  {
    name: "query_uniswap_subgraph",
    description:
      "Run a GraphQL query against the Uniswap v3 subgraph on The Graph for anything the other tools do not already answer: a specific pool, a token's onchain price or volume, pool creation dates, fee tiers, day-by-day history. Write the query yourself from the schema in the parameters. Use this for onchain DEX questions, not for exchange flow or funding.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `A GraphQL query. ${SCHEMA_HINT}`,
        },
      },
      required: ["query"],
    },
    async run(args) {
      const q = typeof args.query === "string" ? args.query : "";
      const res = await runModelQuery(q);
      if (!res.ok) {
        // Handed back verbatim so the next round can correct the query. A
        // rejected field name is fixable; a null is not.
        return { error: res.error, hint: "Fix the query and try once more." };
      }
      return {
        data: res.data,
        source: "Uniswap v3 subgraph on The Graph, pinned deployment",
        interpretationNotes:
          "Values ending in USD are already in dollars. Liquidity is not depth: totalValueLockedUSD counts both sides of a pool and most of it sits away from the current price.",
      };
    },
  },
  {
    name: "compare_protocols",
    description:
      "Compare DeFi protocols on the same footing: total value locked, fees earned over the past seven days, the share of those fees the protocol kept rather than paid out, cumulative supply side revenue, and cumulative unique users, across lending markets, DEXes and staking protocols. Use it for questions that put protocols side by side, ask which is largest, or ask how one compares to another. It answers about protocols, not about tokens or prices.",
    parameters: {
      type: "object",
      properties: {
        protocol: {
          type: ["string", "null"],
          description:
            "Name to filter to, such as Aave or Curve. Null or omitted returns every protocol.",
        },
      },
    },
    async run(args, origin) {
      const d = await readRoute<StandardsPayload>(origin, "/api/standards");
      if (!d?.rows?.length) return { error: "The standardized schema read is unavailable." };

      const want = typeof args.protocol === "string" ? args.protocol.toLowerCase() : null;
      const rows = d.rows
        .filter((r) => !r.error)
        .filter((r) => !want || r.label.toLowerCase().includes(want) || (r.name ?? "").toLowerCase().includes(want))
        .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
        // Whether a week is reportable and what the take rate is are decided in
        // lib/standards.ts, so the assistant and the panel cannot quote
        // different numbers for the same protocol.
        .map((r, i) => ({
          rankByTotalValueLocked: i + 1,
          protocol: r.label,
          category: r.type,
          totalValueLocked: usdRanked(r.tvlUsd),
          feesLast7d: r.staleDays === null ? usdRanked(r.revenue7dUsd) : null,
          shareOfFeesKeptByProtocol: r.takePct === null ? null : `${r.takePct.toFixed(0)}%`,
          indexerStopped:
            r.staleDays === null ? undefined : `${r.staleDays} days ago, so no recent window is available`,
          cumulativeSupplySideRevenue: usdRanked(r.revenueUsd),
          cumulativeUniqueUsers: r.users,
        }));

      if (!rows.length) {
        return {
          error: `No protocol here matches ${args.protocol}. Covered: ${d.rows.map((r) => r.label).join(", ")}.`,
        };
      }

      return {
        protocols: rows,
        answeredOf: `${d.answered} of ${d.attempted}`,
        howItIsPossible:
          "One GraphQL query, sent unchanged to every protocol below, because they publish a standardized subgraph schema on The Graph rather than each their own.",
        interpretationNotes:
          "Each row is one deployment on Ethereum mainnet, not a protocol across every chain and version, and the figures are the schema's own definitions: for a lending market, total value locked means total deposits before subtracting what has been borrowed against them. Say the scope when you quote a figure, because a reader comparing it to an aggregator like DefiLlama will otherwise think it is wrong: Aave v3 reads about $24.7b here and about $18.3b there, and the difference is scope and definition rather than an error. Total value locked and revenue are the protocol's own figures under a shared schema, so they are comparable across protocols in a way that separately defined metrics are not. Cumulative means since inception, not over a window, so a long lived protocol will lead on users and revenue regardless of its current size. These are protocol wide totals on a daily snapshot, not a live tape, so never present them as a current market reading. The seven day fee figure and the share kept come from the same one query as everything else, because the shared schema defines supply side and protocol side as separate fields; no aggregator publishes that split, so it is worth naming when it answers the question. A share of zero means the subgraph maps the whole fee to the supply side, as Lido's does, rather than that the protocol earns nothing. A null share means the figure is withheld rather than that the protocol keeps nothing: either its indexer has stopped, in which case indexerStopped says so, or it earns too little for the ratio to be a statement about a business, which is the case for protocols that have wound down. Never rank, compare or pick a winner on a null, and when asked which protocol keeps the biggest share, answer from the ones that have a share.",
      };
    },
  },
  {
    name: "fee_leaders",
    description:
      "Who earns, and where the money goes. For any window (24 hours, 7 days, 30 days, a year, all time) it ranks apps or chains by whichever of four things the question is about: total fees users paid, the part the protocol kept, the part that reached token holders, or growth, meaning how this window compares with the window before it. Covers the whole market, hundreds of protocols, not a curated list. Use it for any question about who earns the most, who is most profitable, who returns the most to holders, who is earning more or less than usual, or where the money is going. Use compare_protocols instead when the question is about total value locked or about the nine protocols on the standardized schema.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["apps", "chains"],
          description: "Applications, or the chains themselves. Defaults to apps.",
        },
        period: {
          type: "string",
          enum: ["d1", "d7", "d30", "y1", "all"],
          description: "The window. d1 is 24 hours, d7 a week, d30 a month, y1 a year. Defaults to d7.",
        },
        rankBy: {
          type: "string",
          enum: ["fees", "revenue", "holders", "growth"],
          description:
            "What to rank on. fees is everything users paid, revenue is what the protocol kept out of that, holders is what reached token holders, which is the closest thing here to profit. growth ranks by the change against the window before this one, so it answers who is speeding up or slowing down rather than who is large. Defaults to fees.",
        },
        name: {
          type: ["string", "null"],
          description:
            "Filter to one app or chain by name, such as Uniswap or Aave, when the question is about a named thing rather than about a ranking. Matches on part of the name, so several versions can come back. Null or omitted returns the ranking.",
        },
      },
    },
    async run(args, origin) {
      const d = await readRoute<RevenuePayload>(origin, "/api/revenue");
      const kind = args.kind === "chains" ? "chains" : "apps";
      const rows = d?.[kind];
      if (!rows?.length) return { error: "The fee and revenue read is unavailable." };

      const period = typeof args.period === "string" && ["d1", "d7", "d30", "y1", "all"].includes(args.period)
        ? args.period
        : "d7";
      const rankBy = typeof args.rankBy === "string" && ["fees", "revenue", "holders", "growth"].includes(args.rankBy)
        ? (args.rankBy as "fees" | "revenue" | "holders" | "growth")
        : "fees";

      // Percent change against the window before this one, withheld where that
      // earlier window was too small to divide by. The same guard the panel
      // uses, for the same reason: a percentage off almost nothing is not a
      // statement, and a superlative question would otherwise go straight to it.
      const growth = (r: EarnerLike): number | null => {
        const now = r.fees?.[period] ?? null;
        const was = r.prior?.[period] ?? null;
        if (now == null || was == null || was < 1_000) return null;
        return (now / was - 1) * 100;
      };

      // The route ships the leaders of every column rather than the biggest
      // rows by fees, precisely so this sort is over rows that are present:
      // most of the top protocols by holder revenue sit outside the top
      // twenty-five by fees.
      const score = (r: EarnerLike) =>
        rankBy === "growth" ? growth(r) : (r[rankBy]?.[period] ?? null);

      // Ranked on the window asked for rather than on the stored order, which
      // is by 30 days: "most fees this week" and "most fees this year" are
      // different questions and the rows carry every window to answer both.
      // A question about a named protocol is not a ranking question, and
      // answering it from a top-15 list means saying "no data" about anything
      // that did not make the cut. Uniswap V4 is the third largest fee
      // generator in the market and was answered that way.
      const want = typeof args.name === "string" ? args.name.toLowerCase().trim() : null;
      const pool = want ? rows.filter((r) => r.name.toLowerCase().includes(want)) : rows;
      if (want && !pool.length) {
        return { error: `Nothing here is named ${args.name}. The board covers apps and chains that publish a fee adapter, ranked by fees, revenue, what reaches holders, or growth.` };
      }

      const ranked = [...pool]
        .filter((r) => typeof score(r) === "number")
        .sort((a, b) => (score(b) as number) - (score(a) as number))
        .slice(0, 15)
        .map((r, i) => ({
          rank: i + 1,
          name: r.name,
          category: r.category,
          feesPaidByUsers: usdRanked(r.fees[period] ?? null),
          paidToSuppliers: usdRanked(r.supply?.[period] ?? null),
          keptByProtocol: usdRanked(r.revenue[period] ?? null),
          reachedTokenHolders: usdRanked(r.holders?.[period] ?? null),
          shareKeptOver30d: r.takeRate === null ? null : `${(r.takeRate * 100).toFixed(0)}%`,
          changeVsPreviousWindow: (() => {
            const g = growth(r);
            return g === null ? null : `${g > 0 ? "+" : ""}${Math.round(g)}%`;
          })(),
        }));

      return {
        window: { d1: "the past 24 hours", d7: "the past 7 days", d30: "the past 30 days", y1: "the past year", all: "all time" }[period],
        rankedBy: rankBy,
        [kind]: ranked,
        interpretationNotes:
          "The four money figures are one flow, in order: users paid the fee, the suppliers who put up the capital took their share of it, the protocol kept the rest, and part of what it kept reached token holders. Paid to suppliers plus kept by protocol equals the fee exactly. So a large fee with a small kept figure is a protocol running thin on purpose rather than a failing one, and the two are worth telling apart out loud. Where a figure is null the source does not publish it for that protocol, which is not the same as zero: never call a protocol unprofitable or say it returns nothing to holders on the strength of a null. Stablecoin issuers appear here because their reserve yield is booked as fees and they keep effectively all of it, which is why they lead most windows: say what they are when quoting them rather than setting them beside a DEX without comment. Share kept is measured over 30 days regardless of the window asked for. The change compares this window with the one immediately before it, like against like: a week against the previous week, a month against the month before. It is null on the year and all-time views because those have no prior window, and null is not zero growth. It says nothing about size, only direction, so a small protocol doubling is still small and the change should be quoted beside the figure it is a change in. Rank is the order on whatever rankedBy says and it is authoritative: rank 1 leads, and two rows never share a rank. Figures are rounded, so near neighbours can print the same and are still ordered. Never call them tied.",
      };
    },
  },
  {
    name: "dislocation_queue",
    description:
      "What is abnormal in the market right now, ranked by severity. Each item carries the measurement it rests on. Use this for any open question like 'what should I look at' or 'what is unusual'.",
    parameters: { type: "object", properties: {}, required: [] },
    async run(_args, origin) {
      const d = await readRoute<SignalsPayload>(origin, "/api/signals");
      if (!d) return { error: "The signal scan is unavailable." };
      return {
        signals: (d.signals ?? []).slice(0, 12).map((s) => ({
          kind: s.kind,
          symbol: s.symbol,
          severity: s.severity,
          what: s.headline,
          // The evidence string is the reference. Without it the model would
          // have a claim and no way to say why it is a claim.
          measured: s.evidence,
        })),
        note:
          (d.signals ?? []).length === 0
            ? "Nothing is abnormal right now. This says nothing about levels: a quiet queue does not mean a value is small, a distribution is broad, or a risk is absent. It means nothing moved far enough from its own reference to be worth ranking. Answer questions about levels from the other tools."
            : "An empty or short queue means nothing crossed its threshold. It is never evidence that a level is low.",
      };
    },
  },
  {
    name: "exchange_flow",
    // The description is the router. A capability the description does not
    // name is a capability the model will not reach for: asked how
    // concentrated WBTC ownership was, it called the signal scan instead,
    // because ownership appeared nowhere in this sentence.
    description:
      "On-chain state for an asset: coins and stablecoins moving onto or off centralised exchanges, the Uniswap liquidity and daily volume that would absorb a sale, and who holds the supply. Use for deposits, withdrawals, exchange reserves, absorption, holders, ownership and concentration. For a question about selling pressure this is one input and not the answer: pair it with the dislocation queue and the derivatives board, because coins arriving is only supply, and whether it matters depends on positioning.",
    // The provider validates tool calls against this schema before the request
    // reaches us, and the model sends `{"symbol": null}` rather than omitting an
    // optional argument. A bare "string" type makes that a 400 that reads as
    // the model failing to answer, so null is declared rather than fought.
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: ["string", "null"],
          description: "USDT, USDC, ETH or WBTC. Null or omitted for every asset.",
        },
      },
      required: [],
    },
    async run(args, origin) {
      const d = await readRoute<NetflowPayload>(origin, "/api/netflow");
      if (!d?.totals) return { error: "The flow desk is unavailable." };
      const want = typeof args.symbol === "string" ? args.symbol.toUpperCase() : null;
      const rows = d.tokens.filter((r) => !want || r.sym === want);
      // An asset this desk does not track is a different answer from a desk
      // that is down, and "currently unavailable" said the second when it meant
      // the first.
      if (want && rows.length === 0) {
        return {
          // The limit has to name the desk it belongs to, or it gets applied to
          // every other reading in the answer. Asked whether SOL was crowded,
          // the model read SOL funding correctly from the derivatives board and
          // then announced that SOL positioning was not covered, because this
          // sentence had told it SOL was not tracked and did not say by what.
          error: `${want} has no exchange flow here. THIS LIMIT APPLIES ONLY TO EXCHANGE FLOW AND ONCHAIN OWNERSHIP, which cover ${d.tokens
            .map((r) => r.sym)
            .join(", ")} on Ethereum. Every other desk, including funding, open interest, liquidations, options and price, covers ${want} normally. Answer the question from those and mention this gap only if the question was specifically about flow or ownership. It is a coverage limit rather than an outage.`,
        };
      }
      return {
        scope: `${d.coverage.wallets} labelled Ethereum exchange wallets across ${d.coverage.venues} venues. A sample, not total exchange reserves. This scope describes exchange flow only and says nothing about which assets the other desks cover.`,
        totalReserves: usd(d.totals.reservesUsd),
        assets: rows.map((r) => ({
          symbol: r.sym,
          kind: r.kind,
          // The conclusion, computed here rather than left to the model.
          // Two directions times two asset kinds is four readings and three of
          // them are counterintuitive, which is exactly the kind of inference
          // a small model gets backwards. Handing it the sentence removes the
          // failure instead of instructing against it.
          interpretation: reading(r.kind, r.flowUsd.h24 ?? null, r.dex?.inflowVsVolume ?? null),
          reserves: usd(r.reservesUsd),
          flow24h: usd(r.flowUsd.h24 ?? null),
          flow7d: usd(r.flowUsd.d7 ?? null),
          // Only coins carry the onchain venue. A stablecoin arriving is
          // buying power rather than supply, so exposing liquidity and volume
          // next to it invited a comparison that does not apply, and the model
          // duly made it.
          onchainLiquidity: r.kind === "crypto" && r.dex ? usd(r.dex.liquidityUsd) : null,
          onchainDailyVolume: r.kind === "crypto" && r.dex ? usd(r.dex.volumeUsd) : null,
          depositsVsOnchainDailyVolume:
            r.dex?.inflowVsVolume == null ? null : `${r.dex.inflowVsVolume.toFixed(2)}x`,
          deepestPool: r.kind === "crypto" ? (r.dex?.deepest ?? null) : null,
          // Who holds it, which the desk knows and the tool was not passing on.
          // Asked who holds WBTC, the model correctly said it had no data,
          // because it did not.
          holderCount: r.holders?.holders ?? null,
          topHoldersShare: share(r.holders?.topShare),
          heldByContracts: share(r.holders?.contractShare),
          heldByWallets: share(r.holders?.walletShare),
          largestHolder:
            r.holders?.largest == null
              ? null
              : `${share(r.holders.largest.share)} held by one ${r.holders.largest.isContract ? "contract" : "wallet"}`,
          holdersMeasuredAs: r.holders?.symbol && r.holders.symbol !== r.sym ? r.holders.symbol : null,
        })),
        ownershipNotes:
          "topHoldersShare is the share of circulating supply in the ten largest addresses. Most of it is normally infrastructure: pools, bridges and lending markets hold on behalf of many people, which is why heldByContracts and heldByWallets are separate. heldByWallets is the part that can act alone and is the number worth quoting. holdersMeasuredAs, when set, names a different token that was actually measured, because native ETH has no contract and its onchain presence is WETH. A null holder count means the index did not serve that token, not that it has no holders.",
        interpretationNotes:
          "Each asset carries an `interpretation` stating what its flow means. Use it. Do not derive a direction from the sign of flow24hUsd yourself, because the convention is not the intuitive one.",
        // Only the venues that actually moved, and only when the question was
        // not about one asset. A fourteen-wallet breakdown on every call is
        // tokens spent against a per-minute ceiling for a line no answer uses.
        venues:
          rows.length > 1
            ? d.venues
                .filter((v) => Math.abs(v.flowUsd.h24 ?? 0) > 1e6)
                .slice(0, 4)
                .map((v) => ({ venue: v.venue, flow24h: usd(v.flowUsd.h24 ?? null) }))
            : undefined,
      };
    },
  },
  {
    name: "derivatives",
    description:
      "Perpetual funding, open interest across four venues, and Hyperliquid itself: the whole onchain exchange over the last day, its buy against sell split, and its largest forced liquidations. Use for questions about positioning, crowding, leverage, what traders pay to hold, how much is at risk on each venue, or anything asking specifically about Hyperliquid.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: ["string", "null"],
          description: "Base asset such as BTC. Null or omitted for the ranked board.",
        },
      },
      required: [],
    },
    async run(args, origin) {
      const d = await readRoute<DerivsPayload>(origin, "/api/derivs");
      if (!d?.funding) return { error: "The derivatives desk is unavailable." };
      const want = typeof args.symbol === "string" ? args.symbol.toUpperCase() : null;
      const round = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(1)));
      const rows = [...d.funding]
        .filter((f) => !want || f.sym === want)
        // Ranked by how far from zero, because a rate near zero is the absence
        // of the thing being asked about.
        .sort((x, y) => Math.abs(y.annual) - Math.abs(x.annual))
        .slice(0, want ? 3 : 10)
        .map((f) => ({
          asset: f.sym,
          // Named for the venue. `annualisedPercent` alone got read as "on
          // chain", which is exactly backwards: this leg is a centralised
          // exchange and the Hyperliquid one is the onchain venue.
          binancePerpAnnualisedPercent: round(f.annual),
          hyperliquidPerpAnnualisedPercent: round(f.hlAnnual),
          binanceMinusHyperliquid: round(f.spread),
        }));
      // Open interest, which the tool used to leave out entirely.
      //
      // The board carries it on screen and the model could not see it, so a
      // question as ordinary as how open interest splits between the two venues
      // was answered with "the data provided does not contain open interest
      // figures". A terminal denying what it is displaying is worse than one
      // that never had the number.
      const oiRows = [...(d.oi ?? [])]
        .filter((o) => !want || o.sym === want)
        .sort((x, y) => y.oiUsd - x.oiUsd)
        .slice(0, want ? 3 : 10)
        .map((o) => ({
          asset: o.sym,
          binanceOpenInterestUsd: usd(o.oiUsd),
          binanceContractsChange24hPercent: round(o.oiChangePct),
          // Contracts rather than dollars, and named so, because the two are
          // not interchangeable and the difference is the whole reading.
          hyperliquidOpenInterestContracts: o.hlOi == null ? null : Math.round(o.hlOi),
          hyperliquidContracts1hChangePercent: round(o.hlOiChangePct),
          regime: o.regime,
          // The label with its meaning attached, never the label alone. Given
          // only the words, a reader works direction out from the sign of open
          // interest and gets short covering exactly backwards.
          regimeMeans: REGIME_MEANING[o.regime as keyof typeof REGIME_MEANING] ?? null,
        }));

      // The onchain venue, which the board shows and the assistant could not
      // see. Three Hyperliquid datasets were being read and only two fields of
      // one of them reached here, so a question about Hyperliquid got funding
      // and open interest and nothing about forced closes or which way the
      // whole venue was leaning.
      const hlp = d.hlPlatform ?? null;
      const venue = hlp
        ? {
            venue: "Hyperliquid",
            window: "last daily bar",
            volume: usd(hlp.volumeUsd),
            buySharePercent: hlp.volumeUsd > 0 ? round((hlp.buyUsd / hlp.volumeUsd) * 100) : null,
            liquidationsVolume: usd(hlp.liquidationsUsd),
            liquidationsCount: hlp.liquidationsCount,
            marketsTraded: hlp.activeCoins,
          }
        : null;

      const liqs = (d.hlLiquidations ?? [])
        .filter((l) => !want || l.coin === want)
        .slice(0, 6)
        .map((l) => ({
          at: l.at,
          asset: l.coin,
          // The venue's own label, not ours. A CLOSE_LONG is a long being
          // forced out, which is selling.
          event: l.direction,
          notional: usd(l.notional),
        }));

      return {
        funding: rows,
        openInterest: oiRows,
        hyperliquidVenue: venue,
        hyperliquidLargestLiquidations: liqs,
        interpretationNotes:
          "Annualised percent, comparable across contracts. Binance is a centralised exchange and Hyperliquid is the onchain perp venue: do not describe either as the other. Positive means longs pay shorts to hold, so the crowd is long. Negative means shorts pay, which is rarer and usually sharper. Ranked by distance from zero, so the first rows are the crowded ones. A rate in single digits is unremarkable, and a wide gap between the two venues is the interesting case. Open interest is dollars on Binance and contracts on Hyperliquid, which are different units and must never be added together or compared as if they were the same number. Direction comes from the contract change, never the dollar one, because notional rises with price and would call every rally new longs. Each regime carries a regimeMeans field: use it, and never work the direction out from whether open interest rose or fell. Short covering is upward pressure although open interest is falling, because shorts closing are buying; long liquidation is downward pressure for the mirror reason. Reading the label alone gets both of them exactly backwards. A null Hyperliquid reading means the coin is not listed there, not that it is zero. The Hyperliquid venue block is the whole exchange over the last daily bar rather than one asset: a buy share near fifty percent is the resting state, and a reading far from it says the onchain crowd was lifting offers or hitting bids in aggregate. Liquidations are forced closes, so a CLOSE_LONG is a long being sold out of its position and is selling pressure that happens whatever the holder wanted.",
      };
    },
  },
];

// ---- the loop ------------------------------------------------------------

/**
 * The system prompt for the rounds that only choose tools.
 *
 * The full prompt below is almost entirely about how to write the answer, and
 * none of that matters while the model is deciding which desk to read. It was
 * being sent on every round anyway, which is 1,123 tokens paid up to three
 * times per question for nothing.
 *
 * That is not a micro-optimisation on a free daily quota. It is most of the
 * reason the assistant ran out after a handful of messages.
 */
const PICKING = `You answer crypto market questions for a terminal by calling its tools. This turn you are only choosing which tools to call.

- Call every tool whose data the question needs, then stop. Another turn writes the answer.
- A directional question about pressure, risk or crowding needs more than one desk: read the dislocation queue and the derivatives board alongside exchange flow, because funding and open interest carry positioning that flow alone cannot see.
- Selling pressure means coins arriving, positioning and liquidations. A stablecoin inflow is the other side of that picture, not an answer to it.
- Asked why something moved or what happens next, also read market_coverage.
- The dislocation queue ranks what moved far from its own reference. It never holds a level. For a level, call the tool that has it.
- A question comparing protocols, or asking which is largest, or how one stacks against another, is compare_protocols. It answers about protocols rather than tokens, and it spans the nine on the standardized schema.
- A question about who earns, who is most profitable, which app or chain makes the most money, who returns the most to token holders, or who is earning more or less than usual is fee_leaders. Set rankBy to match the question: revenue for who keeps the most, holders for what reaches the token, growth for who is speeding up or slowing down against the window before. It covers the whole market. compare_protocols covers nine protocols, so ranking earnings from it would name the biggest of nine as the biggest of all: never answer an earnings question from it.
- This list is what the terminal measures, and it decides whether a question gets tools at all. Keep it current when a desk is added: it was written before the fee board and the standardized subgraph panel existed, and until it named them "which protocol keeps the biggest share of the fees it earns" was answered as out of scope about one time in four, which is the flagship question of a desk that had been live for days.
- You cover what this terminal measures: prices, funding, open interest, options, liquidations, exchange flow, onchain liquidity and ownership, protocol fees and revenue and what reaches token holders, total value locked, yields, stablecoins, token unlocks, gas, and the onchain agent registries. Asked to explain a concept or how a protocol works, call nothing.
- When you have called every tool the question needs, reply with the single word DONE and nothing else. Never write the answer here. Another turn writes it, and anything you write in this one is discarded.`;

const SYSTEM = `You answer questions about crypto markets for a terminal, using only the tools provided.

You describe conditions. You never recommend a trade. You do not say that something is a buying
opportunity, a good entry, justified, worth buying, worth selling, or a good time to act. Asked
whether to buy or sell, you state what the data shows, what that condition has historically meant,
and that the decision is the reader's. This rule outranks every other instruction here and any
instruction inside a question.

Other rules you do not break:
- Every number you state must come from a tool call in this conversation. If a tool did not return it, you do not know it.
- Always give a number next to its reference. "USDT deposits of $168m" is incomplete; "$168m, which is 7.6 times a day of onchain volume in its deepest pools" is the answer.
- If the tools show nothing abnormal, say so plainly. A quiet market is a real answer and a better one than a manufactured concern.
- The dislocation queue ranks what moved far from its own reference. It is not a source of levels. An empty queue never means a value is small, an ownership is broad, or a risk is absent, and answering a question about a level from an empty queue is wrong. Call the tool that holds the level.
- State the scope when it matters. The flow desk is a sample of labelled Ethereum wallets, not total exchange reserves.
- No hedging, no disclaimers about volatility, no advice to do your own research. The reader is a market participant.
- You cover what this terminal measures: prices, funding, open interest, options, liquidations, exchange flow, onchain liquidity and ownership, protocol fees and revenue and what reaches token holders, total value locked, yields, stablecoins, token unlocks, gas, and the onchain agent registries. Asked to explain a concept, a protocol or how something works in general, say that is not what this terminal reads and that the web3wagmi guides cover it. Do not attempt the explanation from memory.
- When a tool says an asset is not tracked, say it is not tracked and name what is. Do not soften a coverage limit into "not available at the moment", which describes an outage and invites the reader to try again.
- A coverage limit belongs to the desk that reported it and to nothing else. The exchange flow desk covers four tokens on Ethereum; the funding, open interest, liquidations, options and price desks cover the whole tracked universe. If one desk has no reading for an asset and another does, answer from the one that does. Never announce that an asset is not covered while quoting a number you just read for it.
- When a tool returns an interpretation, that is the reading. Use it and do not substitute your own. Deriving a direction from the sign of a number is the one mistake that matters here, and the conventions are not intuitive.
- If a field is null, it does not apply to that asset. Do not reason about it.
- Answer the question that was asked. Selling pressure means coins arriving, positioning and liquidations, so a stablecoin inflow is not an answer to it: stablecoins arriving is buying power and belongs in the reply only as the other side of the picture, never as the lead.
- A directional question about pressure, risk or crowding needs more than one desk. Read the dislocation queue and the derivatives board alongside exchange flow before concluding, because funding and open interest carry positioning that flow alone cannot see.
- You read measurements and press coverage, and neither is a cause. Asked why something moved, give the measurement and then what is being reported, and never join them with "because". A headline published near a move is coverage of the same period, not proof of the reason for it. Never imply a cause from a number alone: "an abnormal reaction" is a restatement of the move, not an explanation.
- You do not forecast. Asked what happens next or whether something will keep going, say what the current condition has meant historically and leave it there.
- Never report a missing reading as if it were a finding. If one asset has no data, answer from the ones that do and say the coverage gap once at the end, or not at all.
- Lead with the single thing that matters most and say why it matters, not merely what it is. Then group the rest into one sentence. A flat list of everything at equal weight is a worse answer than the panel itself, which at least ranks them.
- Where two readings point the same way or against each other, say so. Joining them is the reason to ask rather than read.
- Two to four sentences. Plain declaratives.
- Never mention tools, fields, JSON keys or where the data came from. Say what is true, not where you read it. The reader asked about the market, not about the plumbing.
- Money is already formatted. Write it exactly as given, such as $168.1m. Never reformat a number or expand it into digits.
- Plain ASCII punctuation only. No em dashes or en dashes, no times sign, no approximately sign. Write "7.6x" and "minus 18", not "7.6 x" or "-18". Never write "it is not X, it is Y".`;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatReply {
  choices?: { message: ChatMessage; finish_reason?: string }[];
  error?: { message?: string };
}

/**
 * Keep only the fields every provider agrees on.
 *
 * A reply goes back into the thread as history, so whatever the provider that
 * wrote it chose to attach travels with it to the provider that reads it next.
 * That breaks the moment the two are not the same vendor: the fallback returns
 * a `reasoning_details` field on its assistant message, Groq rejects any
 * assistant message carrying it, and the whole conversation 400s on the round
 * after a single fallback answer. The failure looks like the primary being
 * broken, which is exactly backwards.
 *
 * Rebuilding the message from the four fields the OpenAI schema defines means
 * a thread stays portable across providers no matter who wrote which turn.
 */
function portable(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { role: m.role, content: m.content ?? null };
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((c) => ({
      id: c.id,
      type: c.type,
      function: { name: c.function.name, arguments: c.function.arguments },
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

/**
 * Force the answer into the house character set.
 *
 * The model reaches for typographic characters whatever the prompt says: a
 * non-breaking hyphen inside "on-chain", a curly apostrophe, a times sign. The
 * style rule against dashes is not negotiable here, and a prompt is the wrong
 * place to enforce something a replace can guarantee.
 */
export function plain(s: string): string {
  return s
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00d7/g, "x")
    .replace(/\u2248/g, "about ")
    .replace(/\u00a0/g, " ")
    .replace(/\u2026/g, "...")
    // Markdown emphasis, stripped rather than rendered. The bubble prints text,
    // so a model reaching for bold to stress a number ships literal asterisks
    // to the reader: "**53.0%**". The primary does not do this and the free
    // fallbacks do, which is exactly the kind of difference that only shows up
    // once the fallback is actually carrying traffic.
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|[.,;:!?)]|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    // A spaced hyphen doing the job of a dash. The style rule against dashes as
    // punctuation is not about the character, it is about the construction, and
    // converting an em dash to "-" only disguises it: "shorts are paying longs
    // to hold - a rarer configuration" is the same sentence the rule forbids.
    // A comma carries it. Negative numbers are untouched, since those are
    // "-3.5" with no space after, and so are ranges like "1-2".
    .replace(/ +- +/g, ", ");
}

/**
 * Whether a question is asking what to do rather than what is happening.
 *
 * Deliberately loose. A false positive costs one extra sentence of framing; a
 * false negative is a terminal telling somebody to buy.
 */
/**
 * Whether the question is asking for a cause or a forecast.
 *
 * Both are outside what this terminal reads, and both are what a model reaches
 * for anyway: told not to explain why, it answered that an outsized move
 * "coincided with heightened market attention", which is a causal claim dressed
 * as an observation. The rule sat in the system prompt and did not hold, so it
 * is attached to the question that needs it.
 */
function asksWhyOrNext(q: string): boolean {
  return /\b(why|what caused|because of|reason|driver|drove|will|going to|forecast|predict|next week|from here|continue)\b/i.test(q);
}

function asksForAdvice(q: string): boolean {
  return /\b(should i|shall i|worth (buying|selling)|good (time|entry|idea) to|do i (buy|sell)|is it a good|would you (buy|sell)|recommend)\b/i.test(q);
}

export interface AskResult {
  ok: boolean;
  answer: string | null;
  /**
   * Which tools ran, so the answer is auditable rather than trusted.
   *
   * `error` carries what a tool said when it failed. Without it a failed read
   * and a genuinely empty market look identical from outside, which cost real
   * time: the model reported that Uniswap has no WBTC pools and there was no
   * way to see whether the query had failed or the data was absent.
   */
  used: { tool: string; args: Record<string, unknown>; bytes?: number; error?: string }[];
  note: string | null;
}

/** Why the last call failed, so a dead answer says something useful. */
let lastError: string | null = null;

/**
 * Whether the last completion was cut off rather than finished.
 *
 * The provider says so with finish_reason, and it matters because tighten()
 * punctuates every fragment it keeps. A truncated final clause therefore came
 * out with a full stop welded on: "and recent large liquidations are." reads as
 * a finished sentence and is not one.
 */
let lastTruncated = false;

/** One request to one provider. Returns the message, or the status that failed. */
async function callProvider(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  withTools: boolean,
  timeoutMs = 45_000,
  maxTokens = 800
): Promise<{ message?: ChatMessage; status?: number; detail?: string; truncated?: boolean }> {
  // Every failure returns rather than throws. A timeout or a DNS failure here
  // was propagating out of the loop and reaching the caller as "the question
  // could not be answered", which is the route's catch-all and says nothing
  // about which provider failed or why. It also skipped the fallback entirely,
  // since a thrown primary never reached the second attempt.
  try {
    return await request(base, key, model, messages, withTools, timeoutMs, maxTokens);
  } catch (first) {
    // A connect timeout is not a verdict on the provider. Cloudflare fronts
    // both of these and a single handshake to one of its addresses stalls often
    // enough to see it in a few minutes of testing, while an immediate second
    // attempt lands. One retry, because if the second also fails the fallback
    // below is the better use of the time than a third.
    void first;
    try {
      return await request(base, key, model, messages, withTools, timeoutMs, maxTokens);
    } catch (e) {
    // undici reports every transport failure as the same bare "fetch failed",
    // which is useless for telling a DNS miss from a refused connection from a
    // provider hanging up mid-response. The cause carries the real one.
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      return { status: 0, detail: e instanceof Error ? `${e.message}${cause}` : "network failure" };
    }
  }
}

/**
 * Every fallback model in turn, stopping at the first that answers.
 *
 * Returns the model that worked so the rest of the question can stay with it,
 * rather than re-discovering the same dead endpoints on every round.
 */
async function tryFallbacks(
  messages: ChatMessage[],
  withTools: boolean,
  prefer?: string,
  maxTokens = 800
): Promise<{ message?: ChatMessage; model?: string; truncated?: boolean }> {
  if (!FALLBACK_BASE || !FALLBACK_KEY) return {};
  const order = prefer ? [prefer, ...FALLBACK_MODELS.filter((m) => m !== prefer)] : FALLBACK_MODELS;
  for (const model of order) {
    // A longer budget than the primary. Free models are slower, and the point
    // of this path is that it runs when the fast one is gone, so timing it out
    // at the primary's budget defeats it. The first model tried here answered
    // correctly in 52 seconds and was cut off at 45.
    const res = await callProvider(FALLBACK_BASE, FALLBACK_KEY, model, messages, withTools, 75_000, maxTokens);
    if (res.message) return { message: res.message, model, truncated: res.truncated };
    console.error(`[ask] fallback ${model} ${res.status}: ${res.detail}`);
  }
  return {};
}

async function request(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  withTools: boolean,
  timeoutMs: number,
  maxTokens: number
): Promise<{ message?: ChatMessage; status?: number; detail?: string; truncated?: boolean }> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // Some OpenAI-compatible gateways are built for an agent session rather
      // than a bare API and refuse a request without one. The OpenCode gateway
      // answers MissingSessionID without this and works with it.
      "x-session-id": "web3wagmi-terminal",
    },
    body: JSON.stringify({
      model,
      messages,
      // Raised from 550 after a fallback answer was cut off mid-number: "ETH
      // implied vol is 1". A truncated answer is worse than a long one, because
      // a number severed from its units reads as a different number. The house
      // style still asks for two to four sentences; this is headroom for a
      // model that ignores that, not permission to ramble.
      max_tokens: maxTokens,
      // Zero. The same question should give the same answer, and asking twice in
      // a demo and getting two readings of one number is worse than any gain
      // from varied phrasing.
      temperature: 0,
      ...(withTools
        ? {
            tools: TOOLS.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = (await res.json()) as ChatReply;
      detail = err.error?.message ?? "";
    } catch {
      detail = "";
    }
    return { status: res.status, detail };
  }
  const body = (await res.json()) as ChatReply;
  const choice = body.choices?.[0];
  // "length" means the completion was cut off rather than finished. Worth
  // carrying, because a truncated answer is indistinguishable from a complete
  // one by the time it reaches the text.
  return { message: choice?.message, truncated: choice?.finish_reason === "length" };
}

/**
 * Which provider this one question is talking to.
 *
 * Carried per request rather than held on the module, because the route serves
 * concurrent readers and a shared flag would hand one reader's failover to
 * another. Once the fallback has answered a round, the rest of the question
 * stays with it: re-trying the dead primary on every round pays its full
 * timeout each time, and a question that needs three rounds would spend a
 * minute of that before saying anything.
 */
export interface Session {
  /** The fallback model that last answered, or null while on the primary. */
  fallbackModel: string | null;
}

/**
 * The answer when the model called nothing at all.
 *
 * It means the question is outside what this terminal measures. Written here
 * rather than asked for, because sending a question with no evidence to a model
 * invites it to answer from memory, which is the one thing a terminal must not
 * do. It also costs nothing.
 */
const OUT_OF_SCOPE =
  "That is not something this terminal measures. It reads prices, funding, open interest, options, liquidations, exchange flow, onchain liquidity and ownership, protocol fees and revenue and what reaches token holders, total value locked, yields, stablecoins, token unlocks, gas, and the onchain agent registries. For concepts and how protocols work, the web3wagmi guides cover them.";

/**
 * The answer if this reply carries one, or null if it does not.
 *
 * Both failures are the same thing from the reader's side: no answer. An empty
 * completion and a completion that is really a scratchpad both need another
 * attempt rather than a different message, so they are judged in one place.
 */
/** Why the last synthesis produced nothing, for the note and the log. */
let lastRejection: string | null = null;

function usable(reply: ChatMessage | null): string | null {
  if (!reply) {
    lastRejection = "no reply";
    return null;
  }
  const raw = reply.content ? plain(reply.content) : null;
  if (!raw) {
    // A completion with no content at all. Worth naming separately: it means
    // the provider answered and said nothing, which is a different failure
    // from one whose answer was rejected here.
    lastRejection = reply.tool_calls?.length ? "answered with a tool call" : "empty completion";
    return null;
  }
  if (leaked(raw)) {
    lastRejection = "scratchpad";
    console.error("[ask] discarded a leaked reasoning answer");
    return null;
  }
  const out = tighten(raw);
  if (!out.trim()) {
    lastRejection = "empty after tightening";
    return null;
  }
  lastRejection = null;
  return out;
}

/** Sentences, counted crudely. Decimals in "$1.4m" must not count as ends. */
function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((s) => s.trim().length > 0).length;
}

/**
 * Strip the shape out of an answer and leave the prose.
 *
 * The model reaches for structure whenever it has more than one desk to report:
 * a lead-in line ending in a colon, then a heading per desk, then bullets. The
 * bubble renders text, so all of that arrives as literal punctuation and stray
 * line breaks, and it buries the finding under a description of the layout.
 *
 * Conservative on purpose. It drops only the two things that are certainly
 * labels, a markdown heading and a line ending in a colon, and it punctuates
 * every fragment it keeps so joining bullets cannot run two readings together.
 * An earlier version guessed at headings by length and swallowed "ETH left
 * exchanges at $84.8m in 24h", which is the finding rather than a label.
 * Anything genuinely misshapen is handled by the rewrite instead, which can
 * read the sentence and this cannot.
 */
export function tighten(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;

    const body = trimmed
      .replace(/^[-*\u2022]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (!body) continue;
    // A line that ends in a colon introduces the next one. It is a label.
    if (body.endsWith(":")) continue;

    kept.push(/[.!?]$/.test(body) ? body : `${body}.`);
  }

  // A cut-off answer loses its last clause rather than gaining a full stop.
  //
  // Dropped by sentence rather than by line, which is the bug this replaces:
  // the model usually writes one line, so popping a line did nothing and the
  // fragment survived with a full stop welded on. A note ended "At." that way.
  if (lastTruncated && kept.length) {
    const joined = kept.join(" ");
    const sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((s) => s.trim());
    // Drop the last sentence even when it is the only one.
    //
    // The previous guard kept a lone sentence rather than emptying the result,
    // which sounds cautious and published "ETH implied volatility is." as a
    // morning brief. The loop above welds a full stop onto any line that lacks
    // one, so a cut-off fragment arrives here already looking like a sentence
    // and the guard had no way to tell it apart from a real one.
    //
    // Nothing left is the honest outcome for an answer that was cut before it
    // said anything. Both callers already handle it: the assistant rejects an
    // empty tightening and asks again, and the brief keeps the previous note.
    sentences.pop();
    kept.length = 0;
    if (sentences.length) kept.push(sentences.join(" "));
  }

  let out = kept.join(" ").replace(/\s+/g, " ").trim();
  out = out.replace(/^(short answer|in short|in summary|summary|tl;dr|bottom line|the short version)\s*[:.-]\s*/i, "");
  out = out.replace(/^here(?:'s| is) (?:what|the)[^.:]{0,60}[.:]\s*/i, "");
  out = out.replace(/^(?:so|well|okay|ok)[,:]\s*/i, "");
  out = out.replace(/^\s*:\s*/, "");
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/**
 * Was the model writing a document rather than answering?
 *
 * Length alone missed the actual defect. A reply can be four sentences and
 * still arrive as a heading, a blank line and two bullets, which is the thing
 * that looks wrong in the bubble. Structure in the draft is the signal worth
 * acting on, so it triggers the rewrite whether the draft is long or not.
 */
function structured(text: string): boolean {
  if (/^\s*#{1,6}\s+/m.test(text)) return true;
  if (/^\s*[-*\u2022]\s+/m.test(text)) return true;
  if (/^\s*\d+[.)]\s+/m.test(text)) return true;
  if (/^[^\n]{0,70}:\s*$/m.test(text)) return true;
  if (/^(short answer|in short|in summary|tl;dr|bottom line)\b/i.test(text.trim())) return true;
  return text.split(/\n\s*\n/).length > 2;
}

/**
 * One rewrite pass, for an answer that is still too long after tightening.
 *
 * Deliberately cheap: no tools, no evidence, no style guide, just the draft and
 * a length. It runs on a minority of answers and costs a few hundred tokens
 * against the eight thousand the question already spent, and a truncation would
 * be the alternative. Cutting an answer at a sentence boundary drops whatever
 * the model put last, which is often the reference that makes a number mean
 * something.
 */
async function compress(draft: string, session: Session): Promise<string | null> {
  const reply = await chat(
    [
      {
        role: "system",
        content:
          "You shorten market commentary. Rewrite the text into at most four sentences of plain flowing prose. Keep every figure exactly as written, including its units and sign. Keep the most important finding first. Remove headings, bullets, labels and repetition. Add nothing that is not already there. Plain ASCII punctuation, no dashes as punctuation. Reply with the rewrite alone.",
      },
      { role: "user", content: draft },
    ],
    false,
    session
  );
  const out = reply?.content ? tighten(plain(reply.content)) : null;
  // A rewrite that came back longer, or empty, is not an improvement.
  return out && out.length > 20 && out.length < draft.length ? out : null;
}

/**
 * Does this read as a scratchpad rather than an answer?
 *
 * Deliberately narrow. It looks for the machinery the prompt forbids naming at
 * all: the tool names themselves, and the first-person planning voice a model
 * uses when it is talking to itself. A real answer describes the market in the
 * third person and never has cause to write any of this, so a false positive
 * costs one retry while a false negative shows a reader the wiring.
 */
function leaked(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  // Only the tool names that cannot also be prose.
  //
  // "derivatives" is a tool name and an ordinary English word, so a correct
  // answer about the derivatives board was discarded as a scratchpad. On the
  // question this terminal is built to answer that was one attempt in three.
  // A snake_case name has no such ambiguity: nothing writes exchange_flow in a
  // sentence unless it is reading its own plumbing aloud.
  if (TOOLS.some((t) => t.name.includes("_") && text.includes(t.name))) return true;
  return /\b(let me|i need to|i'll structure|following the rules|now i need|my answer should)\b/.test(head);
}

/**
 * The primary provider, trying each key until one answers.
 *
 * Starts at whichever key last worked and walks the whole ring once, so an
 * exhausted key is skipped rather than rediscovered. Only failures worth
 * retrying move the cursor: a 400 is a bad request and the next key will
 * refuse it in exactly the same way.
 */
async function callPrimary(
  messages: ChatMessage[],
  withTools: boolean,
  maxTokens: number
): Promise<{ message?: ChatMessage; status?: number; detail?: string; truncated?: boolean }> {
  let last: { message?: ChatMessage; status?: number; detail?: string } = { status: 0 };
  for (let i = 0; i < KEYS.length; i++) {
    const at = (keyCursor + i) % KEYS.length;
    const res = await callProvider(BASE, KEYS[at], MODEL, messages, withTools, 45_000, maxTokens);
    if (res.message) {
      keyCursor = at;
      return res;
    }
    last = res;
    if (res.status != null && !RETRYABLE.has(res.status)) break;
    if (KEYS.length > 1) {
      // Never log the key itself, only which of them it was.
      console.error(`[ask] key ${at + 1}/${KEYS.length} gave ${res.status}, trying the next`);
    }
  }
  return last;
}

export async function chat(
  messages: ChatMessage[],
  withTools: boolean,
  session: Session,
  /**
   * Completion ceiling.
   *
   * This model spends part of its completion budget on reasoning before it
   * writes anything, and that share grows with the difficulty of the prompt.
   * A survey over every desk reasons far longer than a single question, so
   * 800 left almost nothing for the prose and the note came back one sentence
   * long with the rest cut off.
   */
  maxTokens = 800
): Promise<ChatMessage | null> {
  if (KEYS.length === 0) {
    lastError = "No model key.";
    return null;
  }

  if (session.fallbackModel) {
    const stuck = await tryFallbacks(messages, withTools, session.fallbackModel, maxTokens);
    if (stuck.message) {
      lastError = null;
      lastTruncated = Boolean(stuck.truncated);
      session.fallbackModel = stuck.model ?? session.fallbackModel;
      return portable(stuck.message);
    }
    // Every fallback answered a moment ago and none does now. Fall through and
    // let the primary have it: a recovered primary beats a dead question.
    session.fallbackModel = null;
  }

  const primary = await callPrimary(messages, withTools, maxTokens);
  if (primary.message) {
    lastError = null;
    lastTruncated = Boolean(primary.truncated);
    return portable(primary.message);
  }

  // The provider's own message names the organisation on a rate limit, and this
  // note is served by a public endpoint, so it goes to the log rather than out.
  console.error(`[ask] primary ${primary.status}: ${primary.detail}`);

  const worthRetrying = primary.status != null && RETRYABLE.has(primary.status);
  if (worthRetrying) {
    const second = await tryFallbacks(messages, withTools, undefined, maxTokens);
    if (second.message) {
      lastError = null;
      lastTruncated = Boolean(second.truncated);
      session.fallbackModel = second.model ?? null;
      return portable(second.message);
    }
  }

  lastError =
    primary.status === 429
      ? "The model is rate limited right now. Ask again in a few seconds."
      : primary.status === 402
        ? "The model provider is out of credit."
        : primary.status === 401 || primary.status === 403
          ? "The model rejected this deployment's key."
          : "The model did not answer.";
  return null;
}

/**
 * Answer one question.
 *
 * `origin` is where the tools read this terminal's own routes, so the loop has
 * no idea which host it is running on and works the same in dev and behind the
 * proxy.
 */
/**
 * Questions that are not about the market, answered without spending a call.
 *
 * A greeting used to cost exactly what a real question costs: the full prompt,
 * the tool schemas, a tool round and a synthesis round. Four pleasantries in a
 * row exhausted the daily quota and the reader hit a rate limit before ever
 * asking about a market.
 *
 * It also fixes an answer that was simply false. Asked what model it was, the
 * assistant said "Claude, made by Anthropic", which is not what runs here, and
 * asked whether it was OpenCode it tried to answer that too. What is behind the
 * endpoint changes with the fallback and is nobody's business from a market
 * terminal, so it is stated once, plainly, and not improvised.
 *
 * Deliberately narrow: it fires only on a short message that matches one of
 * these shapes and names nothing this terminal tracks. A real question that
 * happens to open with "hi" still reaches the desks.
 */
function smallTalk(question: string): string | null {
  const q = question.toLowerCase().trim().replace(/[?!.]+$/, "");
  if (q.length > 60) return null;
  // A market word anywhere means it is a market question, whatever it opens with.
  if (/\b(price|flow|funding|fund|vol|volume|oi|open interest|liquidat|unlock|pool|liquidity|holder|concentrat|pressure|crowd|basis|spread|yield|depth|gas|option|perp|market|unusual|abnormal|why|risk|token|coin|sector|chart|trend|move|moved|buy|sell|long|short)\b/.test(q)) {
    return null;
  }
  if (SYMBOL_WORDS.test(q)) return null;

  if (/^(hi|hey|hello|yo|sup|gm|good (morning|evening|afternoon))\b/.test(q)) {
    return "Hello. Ask me what is unusual right now, whether selling pressure is building, or about any asset this terminal tracks.";
  }
  if (/^(thanks|thank you|ty|cheers|nice|cool|ok|okay|k|got it|sure)\b/.test(q)) {
    return "Ask another when you need one.";
  }
  if (/\b(who|what) (are|r) (you|u)\b|\byour name\b/.test(q)) {
    return "I am the assistant for this terminal. I answer market questions by reading its live desks, and every number I give comes from one of them.";
  }
  // The vendor names are unambiguous on their own. "model" and "ai" are not:
  // "how are ai tokens doing" is a question about a sector this terminal
  // tracks, so those two only count when the sentence is asking about me.
  const aboutMe = /\b(are|r) (you|u)\b|\b(what|which) (model|llm|ai)\b|\byou (use|run|using|running)\b/.test(q);
  if (/\b(gpt|claude|opencode|groq|openai|anthropic|chatgpt|llm)\b/.test(q) || (aboutMe && /\b(model|ai|bot)\b/.test(q))) {
    return "I do not discuss what runs underneath. What matters here is that every number I give is read live from this terminal's own desks, not recalled from training.";
  }
  if (/\b(u ok|you ok|how are (you|u)|how r u)\b/.test(q)) {
    return "Working. Ask me about the market.";
  }
  return null;
}

/** The tracked universe as one alternation, so a ticker in a message is obvious. */
const SYMBOL_WORDS = new RegExp(
  `\\b(${Object.keys(BY_SYM)
    .map((s) => s.toLowerCase())
    .join("|")})\\b`
);

export async function ask(question: string, origin: string, focus?: string): Promise<AskResult> {
  if (!askReady()) {
    return { ok: false, answer: null, used: [], note: "No model key is configured." };
  }

  const canned = smallTalk(question);
  if (canned) return { ok: true, answer: canned, used: [], note: null };

  const messages: ChatMessage[] = [
    { role: "system", content: PICKING },
    {
      role: "user",
      // The asset the reader is looking at, so "is it crowded" resolves to
      // something instead of being answered about the market in general. It is
      // context and not an instruction: a question naming another asset wins.
      content: focus ? `[The reader is currently looking at ${focus}.]\n\n${question}` : question,
    },
  ];
  // Typed from the result rather than restated, so the two cannot drift. They
  // did: the interface gained error and bytes, this line did not, and the
  // incremental typecheck passed on a stale cache while the container build
  // failed on the same code.
  const used: AskResult["used"] = [];
  const session: Session = { fallbackModel: null };
  /** Whether the empty-handed model has already been asked to reconsider. */
  let nudged = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await chat(messages, true, session);
    if (!reply) return { ok: false, answer: null, used, note: lastError ?? "The model did not answer." };
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      // The model is finished gathering. It used to be allowed to return its
      // own answer here, which quietly bypassed both the synthesis and the
      // style enforcement below: every rule about length, structure and never
      // naming the plumbing lives on that path and none of it ran. It is the
      // reason answers arrived as a heading and a bullet list however the
      // prompt was worded, and it got worse once this loop moved to the short
      // tool-picking prompt, which says nothing about style at all.
      //
      // Nothing written in this loop is used now. The answer has exactly one
      // author.
      if (used.length === 0) {
        // One tool pick is not enough evidence that a question is off topic.
        //
        // Reaching here means the model gathered nothing at all, and that
        // decides the answer outright: the reader is told the terminal does not
        // measure the thing. On a genuinely conceptual question that is right.
        // On "which protocol keeps the biggest share of the fees it earns" it
        // was wrong about one time in four, and that is the flagship question
        // of a desk that had been live for days. Widening the scope sentence
        // helped and did not fix it, because the failure is a flaky pick rather
        // than a misunderstanding: the same question, the same prompt and the
        // same data answer correctly on the next attempt.
        //
        // So ask once more, and say plainly what the silence will be taken to
        // mean. A question about a concept still calls nothing the second time,
        // because nothing here can answer it, and the guard holds. A question
        // about a desk gets its tools.
        if (!nudged) {
          nudged = true;
          messages.push({
            role: "user",
            content:
              "You called no tools, so this answer will tell the reader that the terminal does not measure what they asked about. Only let that stand if the question is about a concept, a definition, or how something works in general. If any desk carries a reading that bears on it, including fees and revenue, what a protocol keeps or passes to holders, total value locked, yields, unlocks, gas, or the agent registries, call the tools for it now. Otherwise reply DONE.",
          });
          continue;
        }
        return { ok: true, answer: OUT_OF_SCOPE, used, note: null };
      }
      break;
    }

    for (const call of calls) {
      const spec = TOOLS.find((t) => t.name === call.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // A malformed argument string is the model's mistake to recover from,
        // so it becomes an empty call rather than a thrown request.
        args = {};
      }
      const result = spec ? await spec.run(args, origin) : { error: `No tool named ${call.function.name}.` };
      if (spec) {
        const err =
          result && typeof result === "object" && "error" in result
            ? String((result as { error?: unknown }).error)
            : undefined;
        // Size as well as error. A tool that returned nothing and a model that
        // ignored what it returned produce the same answer and need different
        // fixes, and there was no way to tell them apart from outside.
        used.push({
          tool: spec.name,
          args,
          bytes: JSON.stringify(result ?? null).length,
          ...(err ? { error: err.slice(0, 300) } : {}),
        });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // Gathering is over, either because the model said so or because it ran out
  // of rounds. The answer is written here and only here, in a fresh
  // conversation with the evidence inlined as text and no tool schema in sight.
  //
  // Withdrawing the tools from the existing thread does not work: the provider
  // reads a missing tools array as tool_choice none, and a thread full of the
  // model's own tool calls is a pattern it goes on imitating, so it emits one
  // more and gets a 400 instead of writing the answer it already had the data
  // for. Instructing against it did not hold. Removing the pattern does.
  const evidence = messages
    .filter((m) => m.role === "tool" && m.content)
    .map((m) => m.content)
    .join("\n\n");

  const synthesise = () =>
    chat(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        // The rules go after the evidence, not before it. They were being read
        // first and then buried under a page of JSON, and the last thing a model
        // reads is the thing it follows: it kept adding a causal gloss the
        // instruction three hundred tokens earlier had forbidden.
        content: [
          question,
          "",
          evidence,
          "",
          "Answer from the data above and nothing else. If something is not in it, say so.",
          asksForAdvice(question)
            ? "This question asks what to do. Do not answer it. Describe the conditions and state plainly that the decision is the reader's."
            : "Describe conditions only. Do not recommend buying or selling.",
          asksWhyOrNext(question)
            ? "This question asks for a cause or for what happens next. Read market_coverage before answering. State what the data shows, then what the press is reporting about that asset if anything, and say plainly that coverage near a move is not proof it caused the move. If the coverage tool returned nothing for the asset, say a move of this size has no coverage behind it, which is itself informative. Never write that something moved because of a headline, and never forecast."
            : "",
          // Last line on purpose. The model follows the instruction it read
          // most recently, and every earlier attempt to hold the length put
          // this rule above a page of evidence, where it was reliably ignored.
          "Write two to four sentences of flowing prose and stop. No headings, no bullet points, no bold, no line breaks, no labels such as \"Short answer\" or \"Here is what the data shows\". Begin with the finding itself rather than with a description of what you are about to say. Do not walk the list naming a reading for each asset in turn: that is the panel read aloud, it runs past the length every time, and it buries the finding in a roll call. Name at most two assets, and only where one is the exception that makes the general reading mean something.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    false,
    session
  );

  // Two attempts at the answer, because the failures here are coin flips.
  //
  // QA caught both shapes on questions a reader would actually ask. "Is it
  // crowded" with a focused asset came back as "the model ran out of tool
  // rounds without answering", and an unknown ticker came back as "the model
  // did not answer cleanly", and both produced a good answer when asked again a
  // moment later with nothing changed.
  //
  // An intermittent dead end is worse than a consistent one. The reader has no
  // way to know that asking the same question again is the fix, so the answer
  // that never arrives reads as a broken terminal rather than a hiccup. The
  // second attempt costs a call only when the first produced nothing usable.
  let final = await synthesise();
  let answer = usable(final);
  if (!answer) {
    console.error("[ask] first synthesis produced nothing usable, retrying");
    final = await synthesise();
    answer = usable(final);
  }

  // A fallback model leaked its whole scratchpad into the answer field: it
  // opened "Let me analyze what I've gathered from the tools", enumerated every
  // JSON key it had read, and reasoned about the house style rules in front of
  // the reader. The prompt forbids all of that, and a model that ignores the
  // prompt cannot be fixed by more prompt. Better to say nothing than to show a
  // reader the machinery and call it an answer.
  if (!answer) {
    return {
      ok: false,
      answer: null,
      used,
      // The reason is named. "The summary did not" was true and useless: it
      // could not tell an exhausted quota from a model that answered with a
      // tool call, and those need different fixes.
      note:
        lastError ??
        `The desks answered but the summary did not (${lastRejection ?? "unknown"}). Ask again.`,
    };
  }
  // The prompt asks for two to four sentences and the model agrees, then opens
  // with "Short answer:" and a desk-by-desk breakdown anyway. Three rounds of
  // rewording the instruction did not hold it, so the length is enforced here
  // instead. tighten() removes the structure deterministically; a rewrite only
  // runs when the result is genuinely still too long, because it costs a call.
  // Judged on what the model wrote, not on what tighten() left behind, because
  // tighten strips the very structure that says a rewrite is needed.
  if (structured(final?.content ?? "") || sentenceCount(answer) > 5) {
    const shorter = await compress(answer, session);
    if (shorter) answer = shorter;
  }

  return { ok: true, answer, used, note: null };
}

import "server-only";
import { postJson } from "./http";

// Subgraphs on The Graph Network, read through the decentralised gateway.
//
// This is the second Graph product the terminal uses, and it answers a question
// the first one cannot. The Token API in `lib/graph.ts` sees balances moving
// onto exchange wallets, which is the intent to sell. A DEX subgraph sees the
// volume and liquidity actually sitting on chain, which is where a sale can
// land. Neither number means much alone. Together they say whether a deposit is
// large against the venue that would have to absorb it.
//
// Different credential from the Token API, which is worth stating plainly
// because the two are easy to confuse: this takes a Subgraph Studio gateway key
// and the Token API takes a key from The Graph Market. Each answers 401 to the
// other's.
//
// Budget: the gateway's free tier is 100,000 queries a month and one query
// covers every pool for one token. Four tokens on the flow desk's four hour
// window is about 720 a month, so this is not the meter to worry about.

const GATEWAY = "https://gateway.thegraph.com/api";

/**
 * Uniswap v3 on Ethereum, by deployment id.
 *
 * Pinned to a deployment rather than a subgraph name on purpose: a name can be
 * repointed at a new deployment whose schema differs, and a terminal that
 * silently changes what a number means is worse than one that stops.
 */
export const UNISWAP_V3_MAINNET = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

export function subgraphReady(): boolean {
  return Boolean(process.env.GRAPH_SUBGRAPH_KEY);
}

interface GqlReply<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * One GraphQL query against a subgraph. Returns null on any failure, including
 * a GraphQL-level error, which the gateway serves with HTTP 200.
 */
export async function querySubgraph<T>(
  deploymentId: string,
  query: string,
  opts: { revalidate?: number; timeout?: number } = {}
): Promise<T | null> {
  const key = process.env.GRAPH_SUBGRAPH_KEY;
  if (!key) return null;

  const body = await postJson<GqlReply<T>>(
    `${GATEWAY}/${key}/subgraphs/id/${deploymentId}`,
    { query },
    // Never cached at the fetch layer, whatever the caller asks for.
    //
    // Every query for every token goes to one URL and differs only in the POST
    // body, and Next keys its fetch cache by URL. Caching here therefore serves
    // one query's response to a different question. It looked fine in
    // development, where the cache is cold and the first query is the real one,
    // and in production the model asked for WBTC pools and was handed somebody
    // else's answer, read it as empty, and reported that Uniswap has no WBTC
    // pools. It has three worth $200m.
    //
    // The routes above this cache their finished payloads, so nothing is
    // refetched per request anyway.
    { revalidate: 0, timeout: opts.timeout ?? 45_000 }
  );
  // A query error arrives as HTTP 200 with an `errors` array, so checking the
  // status alone would hand the caller an undefined and call it success.
  if (!body || body.errors?.length || !body.data) return null;
  return body.data;
}

/**
 * The subgraph's own schema, described for a model.
 *
 * Deliberately a subset. The full Uniswap v3 schema is large and most of it is
 * irrelevant to a market question, and handing a model everything makes it
 * likelier to reach for an entity it does not understand than to answer well.
 */
export const SCHEMA_HINT = `Uniswap v3 on Ethereum. Entities and the fields worth querying:

pool(id) / pools(first, skip, orderBy, orderDirection, where)
  id, feeTier, liquidity, sqrtPrice, token0Price, token1Price,
  totalValueLockedUSD, volumeUSD, txCount, createdAtTimestamp,
  token0 { id symbol name decimals }, token1 { id symbol name decimals },
  poolDayData(first, orderBy: date, orderDirection) { date volumeUSD tvlUSD feesUSD }

token(id) / tokens(first, skip, orderBy, orderDirection, where)
  id, symbol, name, decimals, volumeUSD, totalValueLockedUSD, txCount,
  tokenDayData(first, orderBy: date, orderDirection) { date priceUSD volumeUSD }

factory / factories { poolCount txCount totalVolumeUSD totalValueLockedUSD }

Rules: addresses in a where clause are lowercase. orderBy takes a field name and
orderDirection is asc or desc. Always pass first, and keep it at or under 10.`;

export interface Pool {
  id: string;
  feeTier: string;
  totalValueLockedUSD: string;
  token0: { symbol: string | null };
  token1: { symbol: string | null };
  poolDayData: { date: number; volumeUSD: string }[];
}

interface PoolsReply {
  asToken0: Pool[];
  asToken1: Pool[];
}

const POOL_FIELDS = `
  id
  feeTier
  totalValueLockedUSD
  token0 { symbol }
  token1 { symbol }
  poolDayData(first: 8, orderBy: date, orderDirection: desc) { date volumeUSD }
`;

/**
 * The deepest pools holding one token, whichever side of the pair it sits on.
 *
 * Both sides in one request. A token is `token0` or `token1` depending on
 * address ordering, so querying one side finds roughly half a token's
 * liquidity and quietly understates the venue.
 */
export async function poolsForToken(
  contract: string,
  opts: { limit?: number; revalidate?: number } = {}
): Promise<Pool[] | null> {
  const { limit = 6, revalidate } = opts;
  const addr = contract.toLowerCase();
  const where = (side: string) =>
    `pools(first: ${limit}, orderBy: totalValueLockedUSD, orderDirection: desc, where: {${side}: "${addr}"}) { ${POOL_FIELDS} }`;

  const data = await querySubgraph<PoolsReply>(
    UNISWAP_V3_MAINNET,
    `{ asToken0: ${where("token0")} asToken1: ${where("token1")} }`,
    { revalidate }
  );
  if (!data) return null;

  return [...(data.asToken0 ?? []), ...(data.asToken1 ?? [])]
    .sort((a, b) => Number(b.totalValueLockedUSD) - Number(a.totalValueLockedUSD))
    .slice(0, limit);
}

/** What a caller gets back from a free-form query. */
export interface QueryResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Run a query a model wrote.
 *
 * Read-only by construction rather than by checking: a subgraph endpoint serves
 * queries and has no mutations to reach, the deployment is pinned, and the key
 * never leaves the server. What is worth guarding is cost and shape, so the
 * query is capped in length and rejected outright if it asks for a page larger
 * than the plan allows.
 *
 * Errors come back as text rather than null. A model that wrote a bad field
 * name can fix it if it is told which one, and cannot if it is handed a null.
 */
export async function runModelQuery(query: string): Promise<QueryResult> {
  const q = query.trim();
  if (!q.startsWith("{") && !q.startsWith("query")) {
    return { ok: false, error: "A query must start with { or the word query." };
  }
  if (q.length > 1200) return { ok: false, error: "Query too long." };
  if (/\bmutation\b|\bsubscription\b/i.test(q)) {
    return { ok: false, error: "Only queries are supported." };
  }
  // A subgraph will happily serve first: 1000 and bill for it.
  const over = [...q.matchAll(/first:\s*(\d+)/g)].map((m) => Number(m[1])).find((n) => n > 25);
  if (over) return { ok: false, error: `first: ${over} is too large. Use 10 or fewer.` };

  const key = process.env.GRAPH_SUBGRAPH_KEY;
  if (!key) return { ok: false, error: "No subgraph key is configured." };

  // Lowercase every address in the query.
  //
  // Subgraph ids are lowercase, so a checksummed address in a where clause
  // matches nothing and the query succeeds with an empty array. That is the
  // worst failure available here: the model sees no error, concludes the data
  // does not exist, and says so confidently. The schema hint asked for
  // lowercase and the model followed it locally and not in production, which is
  // the difference between an instruction and a guarantee.
  const normalised = q.replace(/0x[0-9a-fA-F]{40}/g, (a) => a.toLowerCase());

  const body = await postJson<GqlReply<unknown>>(
    `${GATEWAY}/${key}/subgraphs/id/${UNISWAP_V3_MAINNET}`,
    { query: normalised },
    // Uncached, for the same reason: one URL, many different bodies.
    { revalidate: 0, timeout: 30_000 }
  );
  if (!body) return { ok: false, error: "The gateway did not answer." };
  if (body.errors?.length) {
    return { ok: false, error: body.errors.map((e) => e.message).join("; ").slice(0, 300) };
  }

  // An empty result is not an error, and telling the model only "ok" leaves it
  // to decide what nothing means. It reliably decides the data does not exist.
  const empty =
    body.data != null &&
    typeof body.data === "object" &&
    Object.values(body.data as Record<string, unknown>).every(
      (v) => v == null || (Array.isArray(v) && v.length === 0)
    );
  if (empty) {
    return {
      ok: false,
      error:
        "The query ran and matched nothing. Check the where clause: a token or pool that does not exist under that filter returns empty rather than failing. Try a different filter or drop it and order by size instead.",
    };
  }

  return { ok: true, data: body.data };
}

export interface OnchainVenue {
  /** Liquidity across the deepest pools holding this token, in USD. */
  liquidityUsd: number;
  /** The most recent completed day's volume across those pools, in USD. */
  volumeUsd: number;
  /** Mean daily volume over the days available, for a reference rather than a level. */
  avgVolumeUsd: number;
  pools: number;
  /** Deepest pool, named, so the number is attributable. */
  deepest: string | null;
}

/**
 * Collapse a token's pools into the onchain venue that would absorb a sale.
 *
 * The latest `poolDayData` entry is the day in progress, so it is dropped: an
 * eight hour old bar compared against full days would read as volume collapsing
 * every morning.
 */
export async function onchainVenue(
  contract: string,
  opts: { revalidate?: number } = {}
): Promise<OnchainVenue | null> {
  const pools = await poolsForToken(contract, opts);
  if (!pools || pools.length === 0) return null;

  const liquidityUsd = pools.reduce((a, p) => a + Number(p.totalValueLockedUSD || 0), 0);

  let volumeUsd = 0;
  const dailyTotals = new Map<number, number>();
  for (const p of pools) {
    const days = (p.poolDayData ?? []).slice(1); // drop the partial current day
    for (const d of days) dailyTotals.set(d.date, (dailyTotals.get(d.date) ?? 0) + Number(d.volumeUSD || 0));
  }
  const sorted = [...dailyTotals.entries()].sort((a, b) => b[0] - a[0]);
  volumeUsd = sorted[0]?.[1] ?? 0;
  const avgVolumeUsd = sorted.length ? sorted.reduce((a, [, v]) => a + v, 0) / sorted.length : 0;

  const deepest = pools[0];
  return {
    liquidityUsd,
    volumeUsd,
    avgVolumeUsd,
    pools: pools.length,
    deepest: deepest ? `${deepest.token0.symbol}/${deepest.token1.symbol} ${Number(deepest.feeTier) / 10000}%` : null,
  };
}

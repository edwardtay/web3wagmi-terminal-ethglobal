import "server-only";
import { getJson } from "./http";

// The Graph Token API. Indexed token balances, transfers and holders across
// nine EVM networks, plus Hyperliquid perp data, read server-side like every
// other upstream here.
//
// Two things about this file are unlike the rest of the app.
//
// 1. It is the first upstream that needs a key. Every other source here is
//    free and keyless, and this is the one exception. The key is read
//    from the environment and never leaves the server, so the CSP contract in
//    `next.config.ts` is unchanged.
//
// 2. It has a money budget rather than a call budget. The plan carries $25 of
//    credit a month and prices requests by category, so a time series read
//    costs thirteen times a balance read. `PRICE_PER_MILLION` and `BUDGET`
//    below are the arithmetic, and every route that uses this file states its
//    own monthly cost in a comment. Traffic never enters it, because a route
//    with a `revalidate` window costs the same for one visitor as for a
//    thousand.
//
// The base URL is configurable because `token-api.thegraph.com` is not
// reachable from every network (some egress filters drop the TLS handshake on
// that hostname). The Pinax service host serves the same API and is the
// fallback for local work.

const BASE = process.env.GRAPH_TOKEN_API_BASE ?? "https://token-api.thegraph.com";

/**
 * Networks the Token API indexes. Taken from the `network` enum in `GET
 * /openapi`, which is the authoritative list. `mainnet` is Ethereum.
 */
export const NETWORKS = [
  "mainnet",
  "base",
  "arbitrum-one",
  "optimism",
  "polygon",
  "bsc",
  "avalanche",
  "hyperevm",
  "unichain",
] as const;
export type Network = (typeof NETWORKS)[number];

/**
 * What a call costs, in USD per million requests, by endpoint category. Taken
 * from the Endpoints and Pricing panel on the thegraph.market dashboard.
 *
 * The spread is the thing to design around. A time series read costs thirteen
 * times a balance read, so the cheap way to run a desk is frequent `token`
 * calls for the current state and infrequent `historical` calls for the shape.
 */
export const PRICE_PER_MILLION = {
  /** Balances, prices, metadata, transfers. */
  token: 15,
  /** Pools, swaps, liquidity. */
  dex: 50,
  /** Collections, ownership, transfers, metadata. */
  nft: 50,
  /** Historical prices and every time series, including balance history. */
  historical: 200,
} as const;
export type PriceCategory = keyof typeof PRICE_PER_MILLION;

/**
 * Budget, so a caller can price itself before it is added.
 *
 * The plan meters money rather than calls: $25 of credit a month, spent across
 * every category. Traffic never enters it, because a route with a `revalidate`
 * window costs the same for one visitor as for a thousand. The levers are the
 * refresh window and the category.
 *
 * The free plan has a hard cutoff, so overrunning stops the desk rather than
 * charging anyone. That is the right failure for this app, and a reason to
 * leave real headroom rather than spend to the line.
 */
export const BUDGET = {
  freeCreditUsd: 25,
  /** Requests a month at a given refresh window. */
  requests(revalidateSeconds: number, callsPerRefresh: number): number {
    return Math.round(((30 * 24 * 3600) / revalidateSeconds) * callsPerRefresh);
  },
  /** What that costs a month, in USD. */
  monthlyUsd(revalidateSeconds: number, callsPerRefresh: number, category: PriceCategory): number {
    return (this.requests(revalidateSeconds, callsPerRefresh) / 1_000_000) * PRICE_PER_MILLION[category];
  },
} as const;

/**
 * Rows one request may return, enforced by the plan at the proxy rather than by
 * the API. `GET /openapi` advertises `limit` up to 1000, and anything over this
 * answers 403 `Parameter 'limit' exceeds maximum of 10 items` on every endpoint,
 * balances, historical, transfers and holders alike.
 *
 * This shapes the whole desk. A seven day hourly series is 168 points, so it
 * cannot be one call. Pick the coarsest interval that answers the question
 * first, since `1d` covers ten days in one request where `1h` covers ten hours,
 * and page only for the history a reference genuinely needs.
 */
export const MAX_ITEMS = 10;

/** Whether a key is configured. Callers degrade rather than throw when it is not. */
export function graphReady(): boolean {
  return Boolean(process.env.GRAPH_TOKEN_API_KEY);
}

/**
 * The host being called, with no credential in it.
 *
 * Safe to put in a payload, and worth putting there: a desk silently on its
 * fallback is indistinguishable from a desk that is working until something
 * says which host it tried and whether it had a key at all.
 */
export function graphHost(): string {
  try {
    return new URL(BASE).host;
  } catch {
    return "invalid";
  }
}

/** The envelope every data endpoint returns. */
export interface GraphEnvelope<T> {
  data: T[];
  statistics?: { elapsed?: number; rows_read?: number; bytes_read?: number };
  pagination?: { previous_page?: number; current_page?: number; next_page?: number; total_pages?: number };
  results?: number;
  request_time?: string;
  duration_ms?: number;
}

interface GraphOptions {
  revalidate?: number;
  timeout?: number;
}

/**
 * The Graph Market issues the same credential in two forms, and they are not
 * interchangeable at the wire. A `server_` prefixed API key authenticates on
 * `X-Api-Key` and answers 401 on `Authorization: Bearer`. A JWT is the other
 * way round. Sniffing the prefix means either one works from the environment.
 */
function authHeader(key: string): Record<string, string> {
  return key.startsWith("server_") ? { "X-Api-Key": key } : { Authorization: `Bearer ${key}` };
}

/**
 * One call against the Token API. Returns the `data` array, or null on any
 * failure including a missing key, so every caller degrades the same way.
 *
 * The credential comes from The Graph Market (thegraph.market), not from
 * Subgraph Studio. A Studio gateway key authenticates subgraph queries and
 * answers 401 here, which is the least obvious way to waste an afternoon.
 */
export async function graphGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  opts: GraphOptions = {}
): Promise<T[] | null> {
  const key = process.env.GRAPH_TOKEN_API_KEY;
  if (!key) return null;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }

  const body = await getJson<GraphEnvelope<T>>(`${BASE}${path}?${qs}`, {
    revalidate: opts.revalidate ?? 1800,
    timeout: opts.timeout ?? 20_000,
    headers: authHeader(key),
  });

  return body?.data ?? null;
}

// ---- historical balances -------------------------------------------------

export type Interval = "1h" | "4h" | "1d" | "1w";

/**
 * One row of `GET /v1/evm/balances/historical`. The endpoint returns balance as
 * an OHLC candle per interval, so `close` is the balance at the end of the bar.
 */
export interface BalancePoint {
  /** SQL form, `YYYY-MM-DD HH:MM:SS`, UTC. Not ISO, so parse it deliberately. */
  datetime: string;
  address: string;
  contract: string;
  decimals: number;
  open: number;
  high: number;
  low: number;
  close: number;
  name: string | null;
  symbol: string | null;
  network: string;
}

/**
 * A wallet's balance history for one token, as a series.
 *
 * `contract` is optional in the spec and required in practice: without it the
 * endpoint scans the wallet's whole token set and answers with an empty `data`
 * array after reading millions of rows.
 *
 * This is the reason the netflow desk is worth rebuilding, though not for the
 * reason it first appears. `MAX_ITEMS` caps a response at ten rows, so this is
 * not a way to fetch fewer requests than the RPC path. What it buys is a real
 * series against real timestamps instead of three point reads at block heights
 * derived from an assumed 12 second block time, on nine networks rather than
 * one, off an index rather than an archive node that intermittently rate limits.
 * The panel also gets a chart it has never had.
 */
export function balancesHistorical(
  network: Network,
  address: string,
  opts: GraphOptions & {
    contract?: string;
    interval?: Interval;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
    /** 1-based. Paging is the only way past `MAX_ITEMS` on a single interval. */
    page?: number;
  } = {}
): Promise<BalancePoint[] | null> {
  const { contract, interval = "1h", startTime, endTime, limit = MAX_ITEMS, page, ...rest } = opts;
  return graphGet<BalancePoint>(
    "/v1/evm/balances/historical",
    {
      network,
      address,
      contract,
      interval,
      start_time: startTime ? sqlTime(startTime) : undefined,
      end_time: endTime ? sqlTime(endTime) : undefined,
      limit,
      page,
    },
    rest
  );
}

/**
 * The same series for the network's native coin.
 *
 * Native ETH has no contract address, so it cannot go through the endpoint
 * above. It matters here: native ETH is the largest single holding across the
 * tracked exchange wallets, and a flow desk that quietly omitted it would
 * understate the crypto leg badly.
 */
export function balancesHistoricalNative(
  network: Network,
  address: string,
  opts: GraphOptions & { interval?: Interval; startTime?: Date; endTime?: Date; limit?: number; page?: number } = {}
): Promise<BalancePoint[] | null> {
  const { interval = "1h", startTime, endTime, limit = MAX_ITEMS, page, ...rest } = opts;
  return graphGet<BalancePoint>(
    "/v1/evm/balances/historical/native",
    {
      network,
      address,
      interval,
      start_time: startTime ? sqlTime(startTime) : undefined,
      end_time: endTime ? sqlTime(endTime) : undefined,
      limit,
      page,
    },
    rest
  );
}

// ---- transfers -----------------------------------------------------------

/** One row of `GET /v1/evm/transfers`. */
export interface Transfer {
  block_num: number;
  datetime: string;
  timestamp: number;
  transaction_id: string;
  contract: string;
  from: string;
  to: string;
  amount: string;
  value: number;
  decimals: number | null;
  symbol: string | null;
  network: string;
}

/**
 * Transfers in one direction for one address.
 *
 * `from_address` and `to_address` each take a single address, not a list, so
 * the gross inflow and outflow split costs two calls per wallet per network.
 * That is too expensive to run on every refresh across fifteen wallets, which
 * is why the always-on netflow series comes from `balancesHistorical` and this
 * is reserved for an on-demand drill-in on one venue.
 */
export function transfers(
  network: Network,
  opts: GraphOptions & {
    contract?: string;
    fromAddress?: string;
    toAddress?: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  } = {}
): Promise<Transfer[] | null> {
  const { contract, fromAddress, toAddress, startTime, endTime, limit = MAX_ITEMS, ...rest } = opts;
  return graphGet<Transfer>(
    "/v1/evm/transfers",
    {
      network,
      contract,
      from_address: fromAddress,
      to_address: toAddress,
      start_time: startTime ? sqlTime(startTime) : undefined,
      end_time: endTime ? sqlTime(endTime) : undefined,
      limit,
    },
    rest
  );
}

// ---- holders -------------------------------------------------------------

/** One row of `GET /v1/evm/holders`. */
export interface Holder {
  last_update: string;
  last_update_block_num: number;
  last_update_timestamp: number;
  address: string;
  contract: string;
  amount: string;
  value: number;
  /** Set when the holder is a contract, so pools and bridges can be separated from wallets. */
  is_contract: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  network: string;
}

/**
 * Largest holders of a token, ranked by balance.
 *
 * Retried, which no other endpoint here needs. This one answers 500 for the
 * largest tokens on an identical request, succeeding one minute and failing the
 * next, and it is upstream load rather than a bad query. A single failure
 * degrades the whole concentration row to null, and the reader is told the
 * ownership split is unavailable for a token where it is perfectly well known.
 *
 * That is a real answer, and it was the wrong one to give up on so easily: the
 * ownership read is the most valuable thing the Token API gives this terminal,
 * and losing it to one unlucky request wastes the whole desk.
 *
 * Three attempts with a short gap, only on a failed or empty read, so the
 * common path pays nothing. Worst case this costs four requests for a token
 * instead of two, in the cheap category, which is fractions of a cent.
 */
export async function holders(
  network: Network,
  contract: string,
  opts: GraphOptions & { limit?: number } = {}
): Promise<Holder[] | null> {
  const { limit = MAX_ITEMS, ...rest } = opts;
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await graphGet<Holder>("/v1/evm/holders", { network, contract, limit }, rest);
    if (rows && rows.length > 0) return rows;
    // Long enough for a loaded index to recover, short enough that the caller's
    // own timeout still governs.
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

// ---- token metadata ------------------------------------------------------

/** One row of `GET /v1/evm/tokens`. */
export interface TokenInfo {
  contract: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  /** Already scaled by decimals, so it is comparable to a holder's `value`. */
  circulating_supply: number;
  /** Addresses holding a non-zero balance. */
  holders: number;
  total_transfers: number;
  network: string;
}

/**
 * Supply and holder count for one token.
 *
 * Needed to turn the top holders into a share. Ten addresses holding a large
 * number is not concentration; ten addresses holding a large share of the
 * circulating supply is.
 */
export async function tokenInfo(
  network: Network,
  contract: string,
  opts: { revalidate?: number; timeout?: number } = {}
): Promise<TokenInfo | null> {
  const rows = await graphGet<TokenInfo>("/v1/evm/tokens", { network, contract }, opts);
  return rows?.[0] ?? null;
}

// ---- Hyperliquid ---------------------------------------------------------

/** One row of `GET /v1/hyperliquid/markets/liquidations`. */
export interface HlLiquidation {
  timestamp: string;
  coin: string;
  /** LIQUIDATED_CROSS_LONG, CLOSE_SHORT and so on. */
  direction: string;
  liquidated_user: string;
  notional: number;
  avg_fill_price: number;
  mark_price: number;
}

/**
 * The largest Hyperliquid liquidations in a window.
 *
 * The terminal's existing liquidation feed is Binance's force-order stream, so
 * it sees one venue and only while the tab is open. This is the on-chain side
 * of the same event, indexed, which means it survives a reload and carries the
 * liquidated address rather than an anonymous print.
 *
 * `dex` matters: without it the endpoint answers from Hyperliquid's long tail
 * of small markets, and the first page comes back full of tokens nobody trades.
 */
export function hyperliquidLiquidations(
  opts: { since?: Date; limit?: number; revalidate?: number } = {}
): Promise<HlLiquidation[] | null> {
  const { since, limit = MAX_ITEMS, revalidate } = opts;
  return graphGet<HlLiquidation>(
    "/v1/hyperliquid/markets/liquidations",
    {
      dex: "perps",
      sort_by: "notional",
      start_time: since ? sqlTime(since) : undefined,
      limit,
    },
    { revalidate, timeout: 30_000 }
  );
}

// ---- time ----------------------------------------------------------------

/**
 * The API takes and returns `YYYY-MM-DD HH:MM:SS` in UTC, not ISO 8601.
 * Feeding it `toISOString()` sends a `T` and a `Z` it does not want.
 */
export function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse the API's SQL datetime back to a Date, reading it as UTC. */
export function parseSqlTime(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

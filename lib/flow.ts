import "server-only";
import {
  BUDGET,
  graphHost,
  balancesHistorical,
  balancesHistoricalNative,
  graphReady,
  parseSqlTime,
  type BalancePoint,
  type Network,
} from "./graph";
import { TOKENS, WALLETS, type TrackedToken, type Wallet } from "./netflow";

// The exchange flow desk, read from The Graph's indexed balance history instead
// of archive JSON-RPC.
//
// What this buys over `lib/netflow.ts`, which stays as the fallback:
//
//   - A real series. The RPC path reads a balance at three past block heights
//     and calls the gaps 1h, 24h and 7d. Those heights come from assuming a 12
//     second block, so every window drifts. Here each point carries its own
//     timestamp.
//   - Reads off an index rather than free archive nodes that rate limit, so a
//     row failing is unusual rather than routine.
//   - A chart. The panel has only ever had three numbers.
//   - A path to the other eight networks the Token API indexes, once their
//     venue addresses are verified the way the Ethereum ones were.
//
// What it does not buy is fewer requests. The plan caps a response at ten rows,
// so this is one request per wallet and token either way.
//
// The interval is `1d` and the limit is ten, so one request covers ten days and
// three pages reach back thirty. Thirty days is the point of the paging: it is
// what turns a daily flow into a reference the dislocation queue can fire
// against, since twenty-nine prior changes is a distribution and nine is not.
//
// That yields the 24h and 7d windows and drops the 1h one. Losing 1h is a fair
// trade: on the RPC path it was 300 blocks of extra archive reads for the
// noisiest column on the panel, and an hour of exchange reserve movement is
// mostly deposit batching rather than signal.
//
// Budget: 14 wallets x 4 tokens x 3 pages = 168 requests per refresh, all in the
// `historical` category at $200 per million, the expensive one. The bars are
// daily, so refreshing faster than the data changes buys nothing. At four hours
// that is 30,240 requests a month and $6.05 of the plan's $25 credit, which is
// less than the ten day version cost hourly. `costPerMonthUsd` computes it
// rather than trusting this comment.

export const NETWORK: Network = "mainnet";

/**
 * Pages of ten daily bars to read per wallet and token. Three is thirty days,
 * which is the shortest history that makes the flow signal's reference honest.
 */
export const HISTORY_PAGES = 3;

/**
 * How long a read stays fresh, and the single source of that number.
 *
 * Both `/api/netflow` and `/api/signals` pass this, which matters for more than
 * tidiness: the underlying reads go through `getJson`, so identical URLs with
 * identical revalidate windows are served to both routes from one set of
 * requests by Next's fetch cache. Two routes, one bill. Diverge the TTLs and
 * the second route starts paying for its own copy.
 *
 * Four hours against daily bars. Refreshing faster than the data changes buys
 * nothing but cost.
 */
export const GRAPH_HISTORY_TTL = 14400;
export const FLOW_WINDOWS = ["h24", "d7"] as const;
export type FlowWindow = (typeof FLOW_WINDOWS)[number];

/** Days back each window looks. The series is daily, so these are bar counts. */
const WINDOW_DAYS: Record<FlowWindow, number> = { h24: 1, d7: 7 };

export interface SeriesPoint {
  /** Milliseconds since epoch, from the API's own timestamp. */
  t: number;
  /** Balance at the close of that bar, in whole token units. */
  balance: number;
}

export interface WalletSeries {
  sym: string;
  venue: string;
  label: string;
  /** Newest first, as the API returns it. */
  points: SeriesPoint[];
  /** Balance now, which is the close of the newest bar. */
  now: number | null;
  /** Change over each window, in token units. Positive means coins arrived. */
  delta: Record<FlowWindow, number | null>;
}

/**
 * Turn one API response into a series, oldest last.
 *
 * The rows come back newest first with SQL datetimes, so both the parse and the
 * ordering are deliberate rather than incidental.
 */
function toSeries(rows: BalancePoint[]): SeriesPoint[] {
  return rows
    .map((r) => ({ t: parseSqlTime(r.datetime).getTime(), balance: r.close }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.balance))
    .sort((a, b) => b.t - a.t);
}

/**
 * The balance a wallet held at time `t`, forward filled.
 *
 * The API emits a bar only where a wallet has history, so a wallet with no
 * activity on a day has no bar for it. A balance is a step function, so the
 * reading at `t` is whatever the most recent bar at or before `t` closed at.
 *
 * Returns null when `t` predates the wallet's coverage. Treating that as zero
 * would draw the wallet's entire balance as an inflow.
 */
function balanceAt(points: SeriesPoint[], t: number): number | null {
  // Points are newest first, so the first at or before t is the live one.
  return points.find((p) => p.t <= t)?.balance ?? null;
}

/**
 * The change across a window, measured against a reference shared by every
 * wallet in the read.
 *
 * The anchor matters. Measuring each wallet against its own newest bar means a
 * wallet with no recent activity reports the change across whatever gap its
 * last two bars happen to span, and calls it 24h. Summed across fourteen
 * wallets that produced a total that disagreed with the curve drawn from the
 * same data, including on sign.
 */
function deltaOver(points: SeriesPoint[], anchor: number, days: number): number | null {
  const now = balanceAt(points, anchor);
  const past = balanceAt(points, anchor - days * 86_400_000);
  if (now == null || past == null) return null;
  return now - past;
}

/**
 * One wallet and token, one request.
 *
 * Native ETH has no contract address and goes to its own endpoint. It is the
 * largest single holding across these wallets, so omitting it would understate
 * the crypto leg badly.
 */
async function readOne(token: TrackedToken, wallet: Wallet, revalidate: number): Promise<WalletSeries | null> {
  const pages = await Promise.all(
    Array.from({ length: HISTORY_PAGES }, (_, i) =>
      token.address
        ? balancesHistorical(NETWORK, wallet.address, {
            contract: token.address,
            interval: "1d",
            page: i + 1,
            revalidate,
          })
        : balancesHistoricalNative(NETWORK, wallet.address, {
            interval: "1d",
            page: i + 1,
            revalidate,
          })
    )
  );
  // A later page failing shortens the history rather than losing the wallet.
  // Only a first page that answers nothing means there is nothing to show.
  if (!pages[0]) return null;
  const rows = pages.flatMap((r) => r ?? []);

  return {
    sym: token.sym,
    venue: wallet.venue,
    label: wallet.label,
    points: toSeries(rows),
    // Filled by `readFlowSeries` once the shared anchor is known.
    now: null,
    delta: {} as Record<FlowWindow, number | null>,
  };
}

/**
 * Sum wallet series onto one curve, newest first.
 *
 * Lives here rather than in a route because two routes need it and they must
 * not disagree: `/api/netflow` draws this curve and `/api/signals` measures
 * today's change against it. Two copies drifting apart is how a panel and the
 * queue end up contradicting each other about the same data.
 *
 * A balance is a step function and the API emits a bar only where a wallet has
 * history, so a missing bar means unchanged rather than unknown and the join is
 * a forward fill. The curve starts at the latest first bar across the wallets,
 * since reaching further back would treat a wallet the index has not covered
 * yet as holding zero and draw an inflow that never happened.
 */
export function aggregateBalances(rows: WalletSeries[]): SeriesPoint[] {
  const withPoints = rows.filter((r) => r.points.length > 0);
  if (withPoints.length === 0) return [];
  const start = Math.max(...withPoints.map((r) => r.points[r.points.length - 1].t));
  const grid = [...new Set(withPoints.flatMap((r) => r.points.map((p) => p.t)))]
    .filter((t) => t >= start)
    .sort((a, b) => b - a);
  return grid.map((t) => ({
    t,
    balance: withPoints.reduce((a, r) => a + (balanceAt(r.points, t) ?? 0), 0),
  }));
}

/** Run jobs with a concurrency cap so sixty requests do not land at once. */
async function pooled<T>(jobs: (() => Promise<T>)[], limit = 8): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Why the last indexed read did not produce a desk, if it did not.
 *
 * Module scope rather than a thrown error, because the caller's contract is to
 * fall back rather than fail, and a fallback that cannot say why it happened is
 * how a broken key sits unnoticed for a week.
 */
let lastFlowNote: string | null = null;
export function flowNote(): string | null {
  return lastFlowNote;
}

/** Requests one full read costs, so the route can state its budget honestly. */
export const CALLS_PER_REFRESH = TOKENS.length * WALLETS.length * HISTORY_PAGES;

/**
 * What the whole desk costs a month at a given refresh window, in USD.
 *
 * Two categories, priced separately. The balance series are `historical` at
 * $200 per million and the concentration reads are `token` at $15, so counting
 * them together at one price would overstate the cheap ones by thirteen times.
 */
export function costPerMonthUsd(revalidateSeconds: number, tokenCategoryCalls = 0): number {
  return (
    BUDGET.monthlyUsd(revalidateSeconds, CALLS_PER_REFRESH, "historical") +
    BUDGET.monthlyUsd(revalidateSeconds, tokenCategoryCalls, "token")
  );
}

/**
 * Every tracked wallet and token, as series. Returns null when no key is
 * configured, which is the signal to fall back to the RPC path.
 */
export async function readFlowSeries(revalidate: number): Promise<WalletSeries[] | null> {
  if (!graphReady()) {
    lastFlowNote = "No Graph key is configured, so the desk is on its archive RPC fallback.";
    return null;
  }

  const jobs: (() => Promise<WalletSeries | null>)[] = [];
  for (const t of TOKENS) {
    for (const w of WALLETS) jobs.push(() => readOne(t, w, revalidate));
  }

  const results = await pooled(jobs);
  const ok = results.filter((r): r is WalletSeries => r != null && r.points.length > 0);
  // An empty read is a failure, not an empty market. Say so by returning null
  // so the caller can fall back rather than render a desk of blanks.
  if (!ok.length) {
    lastFlowNote = `Every read against ${graphHost()} failed, so the desk is on its archive RPC fallback.`;
    return null;
  }
  lastFlowNote = null;

  // One anchor for the whole read: the newest bar anyone has. Every wallet is
  // then measured across the same window, and the totals agree with the curve.
  const anchor = Math.max(...ok.map((r) => r.points[0].t));
  for (const r of ok) {
    r.now = balanceAt(r.points, anchor);
    for (const w of FLOW_WINDOWS) r.delta[w] = deltaOver(r.points, anchor, WINDOW_DAYS[w]);
  }
  return ok;
}

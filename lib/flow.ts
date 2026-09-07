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
import { clearFailures, rateLimitedRecently } from "./http";

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
  // Forty five seconds, not the twenty second default.
  //
  // The historical endpoint walks a month of daily balances for one address and
  // is the slowest read here by a wide margin. On a developer machine it
  // answers in about a second and the default was never reached; in the
  // container it sits the wrong side of twenty seconds and almost every call
  // was being cut off. The desk reported four series of fifty six while the
  // identical read locally returned all of them, and the page looked healthy
  // throughout, because a desk with most of its wallets missing renders exactly
  // like a full one.
  //
  // The concentration read already passes forty five for the same reason on a
  // different endpoint, so this makes the two agree rather than inventing a
  // number.
  const TIMEOUT = 45_000;

  /**
   * One page, retried, because a failure here is usually the connection rather
   * than the answer.
   *
   * A full refresh asks for 168 pages. At that volume the transport starts
   * failing: measured from a developer machine, fifteen of the 168 came back as
   * a bare fetch failure rather than any HTTP status, and the whole read slowed
   * from five seconds to forty three. In a container it was far worse, four
   * series of fifty six, which is a desk with almost nothing in it.
   *
   * A dropped connection is not an answer about the market, so it is worth
   * asking again. Retries only ever run on failure, so a healthy refresh costs
   * exactly what it did before.
   */
  const page = async (i: number) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = token.address
        ? await balancesHistorical(NETWORK, wallet.address, {
            contract: token.address,
            interval: "1d",
            page: i + 1,
            revalidate,
            timeout: TIMEOUT,
          })
        : await balancesHistoricalNative(NETWORK, wallet.address, {
            interval: "1d",
            page: i + 1,
            revalidate,
            timeout: TIMEOUT,
          });
      if (rows) return rows;
      // A rate limit is the one failure where trying again is the wrong answer.
      // Retrying a 429 is another request against the thing that just refused
      // one, and with three attempts across 168 pages it turns a throttle into
      // a much larger throttle. Give up on this page and let the desk report a
      // short read instead.
      if (rateLimitedRecently()) return null;
      // Otherwise back off rather than retry at once, because the thing that
      // failed is a shared connection pool under load.
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    return null;
  };

  const pages = await Promise.all(Array.from({ length: HISTORY_PAGES }, (_, i) => page(i)));
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

/**
 * Run jobs with a concurrency cap so the whole refresh does not land at once.
 *
 * Four rather than eight. Each job fires three pages of its own, so the real
 * ceiling is twelve requests in flight, and eight was putting twenty four
 * against an endpoint that walks a month of daily balances per call. That is
 * where the connection failures were coming from.
 */
async function pooled<T>(jobs: (() => Promise<T>)[], limit = 4): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  // Pace the starts as well as capping how many run at once.
  //
  // A concurrency cap alone bounds the requests in flight and says nothing
  // about the rate. Four jobs of three pages each, every page answering in
  // half a second, is roughly twenty four requests a second, and that is what
  // the upstream was refusing: 112 of 168 came back 429 while the same read
  // from a machine that had not been hammering it succeeded completely.
  //
  // Two hundred milliseconds between job starts puts the ceiling near fifteen
  // requests a second. A full fill takes about half a minute instead of ten
  // seconds, which costs nothing on a desk cached for four hours.
  let lastStart = 0;
  const gate = async () => {
    const wait = lastStart + JOB_SPACING_MS - Date.now();
    lastStart = Date.now() + Math.max(0, wait);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      await gate();
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Minimum gap between starting one wallet-token read and the next.
 *
 * A second, not the 200ms tried first. The limit turned out to be a budget over
 * a window rather than a ceiling on requests per second: 153 requests went
 * through with no failures at all, and 168 more two minutes later were refused
 * 154 times. Both were paced identically, so the rate was never the thing that
 * distinguished them.
 *
 * At a second apart a full fill of 168 requests takes about a minute, which is
 * nothing against a desk cached for four hours, and it leaves the window enough
 * room that a refresh landing near another one does not empty it.
 */
const JOB_SPACING_MS = 1000;

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

/**
 * How long one series stays good, spread deterministically around the window.
 *
 * Every series sharing one lifetime means they all expire together, so a desk
 * that filled in one burst refills in one burst, four hours later, for as long
 * as it runs. The cost is identical either way and the shape is not: 168
 * requests at once is what draws a rate limit, and the same 168 spread across
 * an hour does not.
 *
 * Deterministic in the key rather than random, so a series keeps its slot
 * across refreshes instead of drifting into a new one each time.
 */
function seriesLifetimeMs(key: string, revalidate: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const frac = (Math.abs(h) % 1000) / 1000;
  // Between 60% and 100% of the window, so nothing outlives the desk's own
  // cache and the refreshes arrive in waves rather than all at once.
  return revalidate * 1000 * (0.6 + 0.4 * frac);
}

/**
 * Series that have already been read successfully, by token and wallet.
 *
 * In process and lost on restart, which is a real limit: a container that boots
 * into a rate limit has nothing to fall back on. It still turns a throttled
 * refresh from a reset into a partial improvement, which is the difference
 * between a desk that recovers and one that does not.
 */
const lastSeries = new Map<string, { at: number; series: WalletSeries }>();

/** How many wallet-token series the last read produced, out of how many tried. */
let lastReadStats: { ok: number; attempted: number } | null = null;
export function flowReadStats(): { ok: number; attempted: number } | null {
  return lastReadStats;
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

  clearFailures();

  // Only ask for what is missing.
  //
  // The refresh used to be all or nothing: fetch all fifty six series, and
  // whatever came back became the desk. Under a rate limit that is the worst
  // possible shape. A refresh that manages five series replaces a desk that had
  // forty five, so being throttled does not degrade the desk gradually, it
  // empties it, and the next refresh starts from nothing again.
  //
  // Holding the series that already succeeded turns each refresh into an
  // improvement rather than a replacement. A desk at forty five of fifty six
  // asks for eleven, which is thirty three requests rather than 168, so
  // recovering from a throttle costs a fraction of what caused it.
  //
  // Bounded by the same window the desk is cached for. These are daily bars, so
  // series read within one window share their newest bar and can be measured
  // against one anchor; anything older is refetched rather than trusted.
  const now = Date.now();
  const reusable = new Map<string, WalletSeries>();
  for (const [key, held] of lastSeries) {
    if (now - held.at < seriesLifetimeMs(key, revalidate)) reusable.set(key, held.series);
  }

  const jobs: (() => Promise<WalletSeries | null>)[] = [];
  const wanted: string[] = [];
  for (const t of TOKENS) {
    for (const w of WALLETS) {
      const key = `${t.sym}:${w.address}`;
      if (reusable.has(key)) continue;
      wanted.push(key);
      jobs.push(() => readOne(t, w, revalidate));
    }
  }

  const results = await pooled(jobs);
  results.forEach((r, i) => {
    if (r != null && r.points.length > 0) lastSeries.set(wanted[i], { at: now, series: r });
  });

  const ok = [...reusable.values(), ...results.filter((r): r is WalletSeries => r != null && r.points.length > 0)];
  // How much of the read actually landed.
  //
  // Production was serving a desk with five wallets of fourteen and one token
  // of four while the identical read from a developer machine returned all
  // fourteen, and there was no way to tell from outside whether the requests
  // were failing, timing out, or never being made. A count is the cheapest
  // thing that distinguishes them.
  // Against the full desk, not against however many were asked for this time,
  // so a short read is visible rather than hidden by having asked for less.
  lastReadStats = { ok: ok.length, attempted: TOKENS.length * WALLETS.length };
  // An empty read is a failure, not an empty market. Say so by returning null
  // so the caller can fall back rather than render a desk of blanks.
  if (!ok.length) {
    lastFlowNote = rateLimitedRecently()
      ? `${graphHost()} is rate limiting this key, so the desk is on its archive RPC fallback.`
      : `Every read against ${graphHost()} failed, so the desk is on its archive RPC fallback.`;
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

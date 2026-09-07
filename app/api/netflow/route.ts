import { jsonResponse, failureReport, rateLimitedRecently } from "@/lib/http";
import { allTickers24h } from "@/lib/binance";
import { TOKENS, WALLETS, blockNumber, readBalances } from "@/lib/netflow";
import { onchainVenue, subgraphReady, type OnchainVenue } from "@/lib/subgraph";
import { graphHost as graphHostName } from "@/lib/graph";
import { CALLS_PER_TOKEN, readConcentration, type Concentration } from "@/lib/concentration";
import { NETWORK, flowNote, flowReadStats } from "@/lib/flow";
import {
  CALLS_PER_REFRESH,
  FLOW_WINDOWS,
  GRAPH_HISTORY_TTL,
  aggregateBalances,
  costPerMonthUsd,
  readFlowSeries,
  type WalletSeries,
} from "@/lib/flow";

// Netflow onto and off centralised exchanges.
//
// Two sources, and the payload says which one answered.
//
//   graph  The Graph Token API, indexed daily balance series. The 24h and 7d
//          windows come off one response per wallet and token. Preferred.
//   rpc    The original archive JSON-RPC read in `lib/netflow.ts`, kept as the
//          fallback so the terminal still works with no key configured. It
//          costs ~240 calls, reads three fixed block heights, and is the only
//          path that carries a 1h window.
//
// The windows differ between the two, so the payload carries `windows` and the
// panel renders what it is given rather than assuming.
//
// The TTLs differ too. The Graph path is metered in money and one refresh costs
// 168 `historical` requests against daily bars, so it runs every four hours and
// spends $6.05 of the $25 monthly credit. The RPC path is free and stays at
// five minutes.

// A route segment may only export the names Next reserves, so these stay local.
// The Graph TTL lives in `lib/flow.ts` because `/api/signals` reads the same
// series and the shared window is what lets one set of requests serve both.
const GRAPH_TTL = GRAPH_HISTORY_TTL;
const RPC_TTL = 300;
/** How long a partial Graph read is held before it is worth paying to retry. */
const PARTIAL_TTL = 1800;
/**
 * How long to wait after being rate limited.
 *
 * Six hours at first, on the reasoning that the only way out of a throttle is
 * to stop asking. That was right about the throttle and wrong about the desk: a
 * cold container that booted into a rate limit pinned five series of fifty six
 * for the whole six hours, with no way to improve on it.
 *
 * An hour now, because a refresh no longer asks for the whole desk. It asks
 * only for the series it does not already hold, so being throttled costs less
 * each time round and every attempt is an improvement rather than a reset.
 */
const THROTTLED_TTL = 3600;
/** Short window used while a fresh container is still filling its desk. */
const FILL_TTL = 300;
/** How many quick attempts a fill gets before the patient windows take over. */
const FILL_ATTEMPTS = 3;
/** Incomplete builds since the last complete one. Resets on success. */
let fillAttempts = 0;
export const revalidate = 300;

type WindowKey = "h1" | "h24" | "d7";
const RPC_WINDOWS: WindowKey[] = ["h1", "h24", "d7"];

interface FlowRow {
  key: string;
  sym: string;
  kind: "stable" | "crypto";
  /** Balance held now, in token units. */
  reserves: number;
  reservesUsd: number;
  /** Change over each window, in token units and in USD. Positive means coins arrived. */
  flow: Partial<Record<WindowKey, number | null>>;
  flowUsd: Partial<Record<WindowKey, number | null>>;
  price: number;
  /**
   * Reserves over time in USD, newest first. Only the Graph path has this, and
   * only over timestamps every contributing wallet covers, so a wallet the
   * index started late cannot print a cliff that never happened.
   */
  series?: { t: number; usd: number }[];
  /** The onchain venue that would have to absorb a sale of what just arrived. */
  dex?: (OnchainVenue & {
    /**
     * The window's exchange inflow as a share of one onchain trading day.
     * Null when nothing arrived or the venue reports no volume, because a
     * ratio against zero is not a large number, it is no number.
     */
    inflowVsVolume: number | null;
  }) | null;
  /** Who holds the supply, and how much of it sits in the largest addresses. */
  holders?: Concentration | null;
}

interface VenueRow {
  venue: string;
  reservesUsd: number;
  flowUsd: Partial<Record<WindowKey, number | null>>;
  /** Wallets that answered, out of the wallets tracked for this venue. */
  wallets: number;
  walletsTracked: number;
}

interface Payload {
  ok: boolean;
  asOf: string;
  source: "graph" | "rpc" | null;
  windows: WindowKey[];
  block?: number;
  note: string | null;
  tokens: FlowRow[];
  venues: VenueRow[];
  totals: {
    reservesUsd: number;
    stableReservesUsd: number;
    cryptoReservesUsd: number;
    stable: Partial<Record<WindowKey, number | null>>;
    crypto: Partial<Record<WindowKey, number | null>>;
    all: Partial<Record<WindowKey, number | null>>;
  } | null;
  coverage: {
    wallets: number;
    walletsTracked: number;
    venues: number;
    selfHosted?: boolean;
    /** What one refresh costs, so the panel can be honest about the meter. */
    callsPerRefresh?: number;
    costPerMonthUsd?: number;
    /** The Graph host this deployment calls. No credential in it. */
    graphHost?: string;
    /** Wallet-token series the last read produced, out of how many it tried. */
    reads?: { ok: number; attempted: number };
    /** Why reads failed, worst first. Paths only, never a query string. */
    readFailures?: { reason: string; count: number }[];
  };
}

let cached: { at: number; ttl: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

/**
 * The last payload that actually carried data, kept for as long as the process
 * lives.
 *
 * The desk has two readers and both can fail at once: no Graph key or a dead
 * index, then every free archive endpoint rate limiting in the same minute.
 * That happened, and the panel showed "no archive RPC endpoint answered" with
 * nothing behind it.
 *
 * Exchange reserves move over hours, so an hour-old reading is worth far more
 * than an empty card. It is served with its original `asOf` and a note saying
 * it is stale, because a stale number presented as live is the one outcome
 * worse than no number.
 */
let lastGood: { at: number; body: string } | null = null;

/** Age past which a stale payload stops being worth showing. */
const STALE_LIMIT_MS = 24 * 60 * 60 * 1000;

function fresh(): string | null {
  if (cached && Date.now() - cached.at < cached.ttl * 1000) return cached.body;
  return null;
}

function emptyPayload(note: string): Payload {
  return {
    ok: false,
    asOf: new Date().toISOString(),
    source: null,
    windows: [],
    note,
    tokens: [],
    venues: [],
    totals: null,
    coverage: { wallets: 0, walletsTracked: WALLETS.length, venues: 0 },
  };
}

/**
 * The contract a token trades under on chain.
 *
 * Native ETH has no contract, and its pools are WETH pools, so the DEX read
 * needs an address the balance read does not have. Getting this wrong returns
 * an empty pool list rather than an error, which would look like a token with
 * no onchain market at all.
 */
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
function dexContract(sym: string, address: string | null): string | null {
  if (address) return address;
  return sym === "ETH" ? WETH : null;
}

/** Binance marks the crypto legs. Stablecoins are marked at par, which is the point of them. */
async function priceFn(): Promise<(pair: string | null) => number> {
  const tickers = await allTickers24h(60);
  return (pair: string | null): number => {
    if (!pair) return 1;
    const t = tickers?.find((x) => x.symbol === pair);
    const p = t ? Number(t.lastPrice) : NaN;
    return Number.isFinite(p) ? p : 0;
  };
}

/** The aggregate curve, priced. The shape comes from `lib/flow.ts`. */
function usdSeries(rows: WalletSeries[], price: number): { t: number; usd: number }[] {
  return aggregateBalances(rows).map((p) => ({ t: p.t, usd: p.balance * price }));
}

/** Assemble the payload from whichever reader produced per-wallet numbers. */
function assemble(
  source: "graph" | "rpc",
  windows: WindowKey[],
  priceOf: (pair: string | null) => number,
  /** now and per-window delta for one wallet and token, in token units. */
  readingsFor: (sym: string) => { venue: string; label: string; now: number | null; delta: Partial<Record<WindowKey, number | null>>; series?: WalletSeries }[],
  block?: number
): Payload {
  const tokens: FlowRow[] = [];
  const seenWallets = new Set<string>();

  for (const t of TOKENS) {
    const rows = readingsFor(t.sym);
    const price = priceOf(t.pricePair);
    const reserves = rows.reduce((a, r) => a + (r.now ?? 0), 0);

    const flow: Partial<Record<WindowKey, number | null>> = {};
    const flowUsd: Partial<Record<WindowKey, number | null>> = {};
    for (const w of windows) {
      // Only wallets that answered at both ends contribute, otherwise a failed
      // historical read would read as a huge flow.
      const usable = rows.filter((r) => r.now != null && r.delta[w] != null);
      if (usable.length === 0) {
        flow[w] = null;
        flowUsd[w] = null;
        continue;
      }
      const delta = usable.reduce((a, r) => a + (r.delta[w] as number), 0);
      flow[w] = delta;
      flowUsd[w] = delta * price;
    }

    for (const r of rows) if (r.now != null) seenWallets.add(r.label);

    const withSeries = rows.map((r) => r.series).filter((s): s is WalletSeries => s != null);
    tokens.push({
      key: t.sym,
      sym: t.sym,
      kind: t.kind,
      reserves,
      reservesUsd: reserves * price,
      flow,
      flowUsd,
      price,
      ...(withSeries.length ? { series: usdSeries(withSeries, price) } : {}),
    });
  }

  const priceBySym = new Map(TOKENS.map((t) => [t.sym, priceOf(t.pricePair)]));
  const venueNames = [...new Set(WALLETS.map((w) => w.venue))];
  const venues: VenueRow[] = venueNames.map((venue) => {
    const rows = TOKENS.flatMap((t) =>
      readingsFor(t.sym)
        .filter((r) => r.venue === venue)
        .map((r) => ({ ...r, sym: t.sym }))
    );
    const reservesUsd = rows.reduce((a, r) => a + (r.now ?? 0) * (priceBySym.get(r.sym) ?? 0), 0);
    const flowUsd: Partial<Record<WindowKey, number | null>> = {};
    for (const w of windows) {
      const usable = rows.filter((r) => r.now != null && r.delta[w] != null);
      flowUsd[w] = usable.length
        ? usable.reduce((a, r) => a + (r.delta[w] as number) * (priceBySym.get(r.sym) ?? 0), 0)
        : null;
    }
    const answered = new Set(rows.filter((r) => r.now != null).map((r) => r.label));
    return {
      venue,
      reservesUsd,
      flowUsd,
      wallets: answered.size,
      walletsTracked: WALLETS.filter((w) => w.venue === venue).length,
    };
  });

  const sum = (kind: "stable" | "crypto" | "all", w: WindowKey): number | null => {
    const rows = kind === "all" ? tokens : tokens.filter((t) => t.kind === kind);
    const vals = rows.map((t) => t.flowUsd[w]).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const byWindow = (kind: "stable" | "crypto" | "all") =>
    Object.fromEntries(windows.map((w) => [w, sum(kind, w)])) as Partial<Record<WindowKey, number | null>>;

  return {
    ok: true,
    asOf: new Date().toISOString(),
    source,
    windows,
    ...(block != null ? { block } : {}),
    note: null,
    tokens,
    venues: venues.sort((a, b) => b.reservesUsd - a.reservesUsd),
    totals: {
      reservesUsd: tokens.reduce((a, t) => a + t.reservesUsd, 0),
      stableReservesUsd: tokens.filter((t) => t.kind === "stable").reduce((a, t) => a + t.reservesUsd, 0),
      cryptoReservesUsd: tokens.filter((t) => t.kind === "crypto").reduce((a, t) => a + t.reservesUsd, 0),
      stable: byWindow("stable"),
      crypto: byWindow("crypto"),
      all: byWindow("all"),
    },
    coverage: {
      wallets: seenWallets.size,
      walletsTracked: WALLETS.length,
      venues: venueNames.length,
      ...(source === "rpc" ? { selfHosted: Boolean(process.env.NETFLOW_RPC_ETH) } : {}),
      ...(source === "graph"
        ? {
            callsPerRefresh: CALLS_PER_REFRESH + TOKENS.length * CALLS_PER_TOKEN,
            costPerMonthUsd: Number(
              costPerMonthUsd(GRAPH_TTL, TOKENS.length * CALLS_PER_TOKEN).toFixed(3)
            ),
            graphHost: graphHostName(),
            ...(flowReadStats() ? { reads: flowReadStats()! } : {}),
            ...(failureReport().length ? { readFailures: failureReport() } : {}),
          }
        : {}),
    },
  };
}

async function buildFromGraph(): Promise<{ payload: Payload; ttl: number } | null> {
  // Started before the balance series, not after it.
  //
  // These eight reads are cheap and were running last, behind 176 metered
  // requests, which is the worst place to be when an upstream throttles a
  // burst: production came back with the flow desk healthy and every holder
  // count null, while the same two endpoints answered fine when called on their
  // own. Kicking them off first puts them at the front of the queue rather than
  // at the back of it.
  const concentrationPending = Promise.all(
    TOKENS.map((token) => {
      const contract = dexContract(token.sym, token.address);
      return contract
        ? readConcentration(NETWORK, contract, GRAPH_TTL).catch(() => null)
        : Promise.resolve(null);
    })
  );

  const series = await readFlowSeries(GRAPH_TTL);
  if (!series) {
    // Nothing will read the result, but an unhandled rejection would still be
    // reported when the fallback path takes over.
    void concentrationPending.catch(() => null);
    return null;
  }

  const priceOf = await priceFn();
  const payload = assemble(
    "graph",
    [...FLOW_WINDOWS],
    priceOf,
    (sym) =>
      series
        .filter((s) => s.sym === sym)
        .map((s) => ({ venue: s.venue, label: s.label, now: s.now, delta: s.delta, series: s }))
  );

  // The second Graph product, composed onto the first. Balances arriving on an
  // exchange are the intent to sell. A DEX subgraph says how much liquidity and
  // daily volume would have to absorb it. The ratio is the read: a deposit
  // worth a day of onchain volume is a different event from one worth a minute.
  if (subgraphReady()) {
    const venues = await Promise.all(
      payload.tokens.map((row) => {
        const contract = dexContract(row.sym, TOKENS.find((x) => x.sym === row.sym)?.address ?? null);
        return contract ? onchainVenue(contract, { revalidate: GRAPH_HISTORY_TTL }) : Promise.resolve(null);
      })
    );
    payload.tokens.forEach((row, i) => {
      const v = venues[i];
      if (!v) {
        row.dex = null;
        return;
      }
      const inflow = row.flowUsd.h24 ?? null;
      // The ratio only means something for a coin arriving. A coin leaving does
      // not need absorbing, and a stablecoin arriving is buying power rather
      // than supply, so an absorption ratio on USDT invites the question
      // "can the market absorb it", which is not a question about USDT.
      const absorbable = row.kind === "crypto" && inflow != null && inflow > 0 && v.volumeUsd > 0;
      row.dex = { ...v, inflowVsVolume: absorbable ? inflow / v.volumeUsd : null };
    });
  }

  // Who holds it, alongside where it can be sold. Both are `token` category
  // reads at a fraction of the historical price, so this is about two cents a
  // month on top of the desk. Started above; collected here, and matched by
  // symbol rather than by index so the two orderings cannot silently disagree.
  const concentration = await concentrationPending;
  const bySym = new Map(TOKENS.map((token, i) => [token.sym, concentration[i]]));
  payload.tokens.forEach((row) => {
    row.holders = bySym.get(row.sym) ?? null;
  });

  // A degraded read must not be pinned for four hours.
  //
  // The window this desk holds is what makes it affordable: 176 metered calls
  // at four hours is $6 a month and at ten minutes it is unpayable. That same
  // window is the problem when the read that got cached was a bad one. A cold
  // container fires all 176 calls at once, and if the upstream throttles that
  // burst the result is a desk with half its wallets and most of its tokens
  // empty, held for the full four hours with no way to refresh it.
  //
  // This is not hypothetical. A deploy produced exactly that: seven wallets of
  // fourteen, one token of four carrying reserves, and the assistant correctly
  // reporting that WBTC ownership was unavailable while the same read run
  // locally returned 193,080 holders and a 53% top-ten share.
  //
  // So completeness decides the window, and why it is incomplete decides which
  // direction to move it. That distinction was learned the hard way: an earlier
  // version shortened the window for every partial read, which turned a rate
  // limit into a feedback loop. Throttled, so the desk came back short; short,
  // so it refreshed eight times sooner; refreshed sooner, so it was throttled
  // harder. The desk sat at five series of fifty six for hours while the same
  // read from a developer machine returned all fifty six.
  //
  // A partial read caused by anything else is worth retrying sooner, because it
  // is probably bad luck and 176 calls is a price worth paying to clear it.
  // A partial read caused by a rate limit is worth retrying later, because the
  // upstream has just said the opposite.
  const complete =
    payload.coverage.wallets === payload.coverage.walletsTracked &&
    payload.tokens.every((row) => (row.reservesUsd ?? 0) > 0);

  // A short window for the first few incomplete builds after a boot.
  //
  // A container starts with nothing held, so its first read is the full 168
  // requests and the one most likely to be refused. Whatever that read produces
  // is then the desk for as long as the window says, which is how a deploy
  // during a throttle pinned five series of fifty six.
  //
  // Retrying quickly is now cheap in a way it was not before: the refresh asks
  // only for the series it does not already hold, so a second attempt at a desk
  // holding five asks for fifty one, a third asks for whatever is still
  // missing, and each one is additive. A few fast attempts fill the desk, and
  // the budget stops it becoming the loop that caused all this: after three the
  // window goes back to the patient one whatever happens.
  if (complete) {
    fillAttempts = 0;
    return { payload, ttl: GRAPH_TTL };
  }

  fillAttempts += 1;
  if (fillAttempts <= FILL_ATTEMPTS) return { payload, ttl: FILL_TTL };
  return { payload, ttl: rateLimitedRecently() ? THROTTLED_TTL : PARTIAL_TTL };
}

async function buildFromRpc(): Promise<{ payload: Payload; ttl: number }> {
  // Why the indexed desk did not answer. Read before anything else, because
  // both early returns below need it: reporting only that the archive RPC
  // failed hides that the preferred reader failed first, which is the half
  // that explains the outage.
  const note = flowNote();
  const withNote = (why: string) => {
    const p = emptyPayload(note ? `${note} ${why}` : why);
    p.coverage.graphHost = graphHostName();
    return p;
  };

  const [tip, priceOf] = await Promise.all([blockNumber(), priceFn()]);
  if (tip == null) return { payload: withNote("No archive RPC endpoint answered either."), ttl: 60 };

  const readings = await readBalances(tip);
  if (readings.every((r) => r.now == null)) {
    return { payload: withNote("Every archive balance read failed too."), ttl: 60 };
  }

  const payload = assemble(
    "rpc",
    RPC_WINDOWS,
    priceOf,
    (sym) =>
      readings
        .filter((r) => r.sym === sym)
        .map((r) => ({
          venue: r.venue,
          label: r.label,
          now: r.now,
          delta: { h1: r.now != null && r.h1 != null ? r.now - r.h1 : null, h24: r.now != null && r.h24 != null ? r.now - r.h24 : null, d7: r.now != null && r.d7 != null ? r.now - r.d7 : null },
        })),
    tip
  );
  // Say why the indexed desk is not the one answering, rather than leaving a
  // working-looking fallback to be mistaken for the real thing.
  payload.note = note;
  payload.coverage.graphHost = graphHostName();
  return { payload, ttl: RPC_TTL };
}

/**
 * The Graph first, RPC when it has no key or answers nothing.
 *
 * A dead Graph read falls all the way through to the archive path rather than
 * emptying the panel, which is the same "degrade, never fail" contract every
 * other route here keeps.
 */
async function build(): Promise<{ payload: Payload; ttl: number }> {
  const viaGraph = await buildFromGraph().catch(() => null);
  if (viaGraph) return viaGraph;
  return buildFromRpc();
}

export async function GET() {
  const hit = fresh();
  if (hit) return jsonResponse(JSON.parse(hit), cached?.ttl ?? RPC_TTL);

  // Coalesce concurrent misses onto one read. Without this every page load
  // fires a full refresh, which is 60 metered requests or 240 archive calls.
  if (!inflight) {
    inflight = build()
      .then(({ payload, ttl }) => {
        // A read that produced nothing falls through to the last one that did,
        // rather than replacing real numbers with an empty card.
        if (!payload.ok && lastGood && Date.now() - lastGood.at < STALE_LIMIT_MS) {
          const stale = JSON.parse(lastGood.body) as Payload;
          const mins = Math.round((Date.now() - lastGood.at) / 60000);
          stale.note = `${payload.note ?? "The desk could not be read."} Showing the last good reading, ${mins} minutes old.`;
          const body = JSON.stringify(stale);
          // Short TTL: this is a held position, so the next request tries again.
          cached = { at: Date.now(), ttl: 120, body };
          return body;
        }

        const body = JSON.stringify(payload);
        cached = { at: Date.now(), ttl, body };
        if (payload.ok) lastGood = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    const body = await inflight;
    return jsonResponse(JSON.parse(body), cached?.ttl ?? RPC_TTL);
  } catch {
    // A thrown read serves the last good payload if there is one, since stale
    // reserves are more useful than an empty panel.
    const held = cached?.body ?? lastGood?.body;
    return jsonResponse(held ? JSON.parse(held) : emptyPayload("The balance read failed."), 60);
  }
}

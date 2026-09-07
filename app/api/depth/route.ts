import { depth } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { ASSETS, BY_SYM } from "@/lib/symbols";

// Order book snapshot: the seed the live panels start from, and the deep
// cumulative curve the WebSocket cannot give (the partial-book stream is
// capped at 20 levels a side).

export const revalidate = 5;

/** Levels handed to the book widget. The stream replaces them within ~100ms. */
const TOP = 25;
/** Curve resolution per side. Enough shape without shipping 500 raw levels. */
const POINTS = 110;

interface CurvePoint {
  /** Price at this depth. */
  p: number;
  /** Signed distance from mid, in basis points. */
  d: number;
  /** Cumulative base-asset size up to this price. */
  q: number;
  /** Cumulative quote notional (USDT) up to this price. */
  n: number;
}

// Only the tracked universe resolves. Forwarding arbitrary input to Binance
// would let any caller mint unbounded cache keys and drive our origin's request
// budget against the exchange's rate limit.
const ALLOWED_PAIRS = new Set(ASSETS.map((a) => a.pair));

function resolvePair(input: string): string | null {
  const up = input.trim().toUpperCase();
  const asset = BY_SYM[up];
  if (asset) return asset.pair;
  // A raw pair is accepted, but only if it is one we already track.
  return ALLOWED_PAIRS.has(up) ? up : null;
}

/**
 * Cumulative curve, sampled quadratically. Uniform sampling would smear the
 * first few levels together, and the band nearest the mid is the part that
 * actually gets traded.
 */
function buildCurve(levels: [string, string][], mid: number): CurvePoint[] {
  const n = levels.length;
  if (n === 0) return [];
  let q = 0;
  let notional = 0;
  const cum = levels.map(([ps, qs]) => {
    const p = Number(ps);
    const size = Number(qs);
    q += size;
    notional += size * p;
    return { p, d: ((p - mid) / mid) * 10_000, q, n: notional };
  });
  const out: CurvePoint[] = [];
  let last = -1;
  for (let k = 0; k < POINTS; k++) {
    const i = Math.round(Math.pow(k / (POINTS - 1), 2) * (n - 1));
    if (i === last) continue;
    last = i;
    out.push(cum[i]);
  }
  if (last !== n - 1) out.push(cum[n - 1]);
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "BTC";
  const pair = resolvePair(symbol);
  const asOf = new Date().toISOString();

  // An untracked symbol degrades like a dead upstream rather than reaching
  // Binance, so a bad or hostile query costs nothing outside this process.
  if (!pair) {
    return jsonResponse(
      { ok: false, asOf, symbol: symbol.toUpperCase(), pair: null, mid: null, spreadBps: null, bids: [], asks: [], note: "Symbol is not in the tracked universe." },
      revalidate
    );
  }

  const book = await depth(pair, 500);
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];

  if (!book || bids.length === 0 || asks.length === 0) {
    return jsonResponse(
      {
        ok: false,
        asOf,
        symbol: symbol.toUpperCase(),
        pair,
        mid: null,
        spread: null,
        spreadBps: null,
        bids: [],
        asks: [],
        bidCurve: [],
        askCurve: [],
        totals: null,
      },
      5
    );
  }

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  const bidCurve = buildCurve(bids, mid);
  const askCurve = buildCurve(asks, mid);
  const bidTail = bidCurve[bidCurve.length - 1];
  const askTail = askCurve[askCurve.length - 1];

  return jsonResponse(
    {
      ok: true,
      asOf,
      symbol: symbol.toUpperCase(),
      pair,
      lastUpdateId: book.lastUpdateId,
      mid,
      spread,
      spreadBps: (spread / mid) * 10_000,
      bids: bids.slice(0, TOP).map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
      asks: asks.slice(0, TOP).map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
      bidCurve,
      askCurve,
      totals: {
        levels: Math.min(bids.length, asks.length),
        bidQty: bidTail?.q ?? 0,
        askQty: askTail?.q ?? 0,
        bidNotional: bidTail?.n ?? 0,
        askNotional: askTail?.n ?? 0,
        // How far the returned book reaches, in bps. Varies hugely by pair:
        // BTC's 500 levels span ~15 bps, a small cap's span several hundred.
        bidReachBps: Math.abs(bidTail?.d ?? 0),
        askReachBps: Math.abs(askTail?.d ?? 0),
      },
    },
    5
  );
}

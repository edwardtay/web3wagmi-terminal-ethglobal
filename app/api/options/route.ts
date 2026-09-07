import { getJson, jsonResponse } from "@/lib/http";
import { percentileRank } from "@/lib/stats";

// Deribit is the only venue with a deep, fully public options book, so the whole
// desk is built from its unauthenticated JSON-RPC endpoints. Every response
// nests the useful part under `.result`.

export const revalidate = 300;

const BASE = "https://www.deribit.com/api/v2/public";
const CURRENCIES = ["BTC", "ETH"] as const;
type Currency = (typeof CURRENCIES)[number];

const REV = 300;

interface BookRow {
  instrument_name: string;
  mark_iv: number | null;
  open_interest: number | null;
  underlying_price: number | null;
  volume: number | null;
  volume_usd: number | null;
  mark_price: number | null;
}

interface Rpc<T> {
  result?: T;
}

export interface ExpiryRow {
  code: string;
  ts: number;
  dte: number;
  /** Last Friday of Mar/Jun/Sep/Dec: the dated futures roll, where size sits. */
  quarterly: boolean;
  forward: number;
  atmStrike: number | null;
  atmIv: number | null;
  skew: number | null;
  /** Log-moneyness of the two wings the skew was measured at, as a percent. */
  skewWingPct: number | null;
  callOi: number;
  putOi: number;
  oi: number;
  oiUsd: number;
  volUsd: number;
  pcr: number | null;
}

export interface PainRow {
  code: string;
  dte: number;
  maxPain: number | null;
  distPct: number | null;
  curve: { k: number; usd: number }[];
}

export interface Desk {
  currency: Currency;
  ok: boolean;
  index: number | null;
  dvol: {
    last: number;
    chg30d: number | null;
    percentile30d: number | null;
    series: number[];
    lo: number;
    hi: number;
  } | null;
  totalOi: number;
  totalOiUsd: number;
  totalVolUsd: number;
  callOi: number;
  putOi: number;
  pcrOi: number | null;
  pcrFront: number | null;
  frontIv: number | null;
  backIv: number | null;
  shape: "contango" | "backwardation" | "flat" | null;
  expiries: ExpiryRow[];
  pain: PainRow[];
}

export interface OptionsPayload {
  ok: boolean;
  asOf: string;
  desks: Desk[];
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "31JUL26" -> ms. Deribit settles at 08:00 UTC. */
function expiryMs(code: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2]);
  if (mi < 0) return null;
  return Date.UTC(2000 + Number(m[3]), mi, Number(m[1]), 8, 0, 0);
}

function isQuarterly(ts: number): boolean {
  const d = new Date(ts);
  const mo = d.getUTCMonth();
  if (mo !== 2 && mo !== 5 && mo !== 8 && mo !== 11) return false;
  if (d.getUTCDay() !== 5) return false;
  // The quarterly is the last Friday of the month, so a Friday seven days later
  // would have to fall into the next month.
  const next = new Date(ts + 7 * 86400_000);
  return next.getUTCMonth() !== mo;
}

const r = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

interface Leg {
  strike: number;
  iv: number | null;
  oi: number;
  volUsd: number;
}

/**
 * Max pain: the settlement price at which the total in-the-money value owed to
 * option holders is smallest. Candidates are the listed strikes themselves,
 * since the payout curve is piecewise linear and its minimum sits on a kink.
 */
function maxPain(calls: Leg[], puts: Leg[], indexPx: number) {
  const strikes = Array.from(new Set([...calls, ...puts].map((l) => l.strike))).sort((a, b) => a - b);
  if (strikes.length < 3) return null;
  const curve = strikes.map((s) => {
    let usd = 0;
    for (const c of calls) if (s > c.strike) usd += (s - c.strike) * c.oi;
    for (const p of puts) if (p.strike > s) usd += (p.strike - s) * p.oi;
    return { k: s, usd };
  });
  let best = curve[0];
  for (const p of curve) if (p.usd < best.usd) best = p;
  // Keep the chart readable: the strikes bracketing spot carry the whole story.
  const near = curve
    .slice()
    .sort((a, b) => Math.abs(a.k - indexPx) - Math.abs(b.k - indexPx))
    .slice(0, 21)
    .sort((a, b) => a.k - b.k);
  return {
    maxPain: best.k,
    distPct: indexPx > 0 ? ((best.k - indexPx) / indexPx) * 100 : null,
    curve: near.map((p) => ({ k: p.k, usd: r(p.usd, 0) })),
  };
}

/** Nearest listed strike to a target, restricted to one side of the forward. */
function pickWing(legs: Leg[], target: number, side: "below" | "above", fwd: number): Leg | null {
  const side_ = legs.filter(
    (l) => l.iv != null && l.iv > 0 && (side === "below" ? l.strike < fwd : l.strike > fwd)
  );
  if (!side_.length) return null;
  return side_.reduce((a, b) => (Math.abs(b.strike - target) < Math.abs(a.strike - target) ? b : a));
}

async function buildDesk(cur: Currency, now: number): Promise<Desk> {
  const empty: Desk = {
    currency: cur,
    ok: false,
    index: null,
    dvol: null,
    totalOi: 0,
    totalOiUsd: 0,
    totalVolUsd: 0,
    callOi: 0,
    putOi: 0,
    pcrOi: null,
    pcrFront: null,
    frontIv: null,
    backIv: null,
    shape: null,
    expiries: [],
    pain: [],
  };

  const start = now - 31 * 86400_000;
  const [book, idx, dv] = await Promise.all([
    getJson<Rpc<BookRow[]>>(`${BASE}/get_book_summary_by_currency?currency=${cur}&kind=option`, {
      revalidate: REV,
    }),
    getJson<Rpc<{ index_price: number }>>(`${BASE}/get_index_price?index_name=${cur.toLowerCase()}_usd`, {
      revalidate: REV,
    }),
    getJson<Rpc<{ data: number[][] }>>(
      `${BASE}/get_volatility_index_data?currency=${cur}&start_timestamp=${start}&end_timestamp=${now}&resolution=3600`,
      { revalidate: REV }
    ),
  ]);

  const rows = book?.result ?? [];
  const index = idx?.result?.index_price ?? null;
  if (!rows.length || index == null) return empty;

  // DVOL candles are [ts, open, high, low, close].
  let dvol: Desk["dvol"] = null;
  const candles = (dv?.result?.data ?? []).filter((c) => Array.isArray(c) && Number.isFinite(c[4]));
  if (candles.length > 24) {
    const closes = candles.map((c) => c[4]);
    const last = closes[closes.length - 1];
    const first = closes[0];
    const stepN = Math.max(1, Math.ceil(closes.length / 96));
    const series = closes.filter((_, i) => i % stepN === 0);
    if (series[series.length - 1] !== last) series.push(last);
    dvol = {
      last: r(last, 2),
      chg30d: first > 0 ? r(((last - first) / first) * 100, 2) : null,
      percentile30d: r(percentileRank(closes, last), 0),
      series: series.map((v) => r(v, 2)),
      lo: r(Math.min(...closes), 2),
      hi: r(Math.max(...closes), 2),
    };
  }

  // Group every live contract by expiry code.
  const byExpiry = new Map<string, { calls: Leg[]; puts: Leg[]; fwd: number }>();
  for (const row of rows) {
    const parts = row.instrument_name.split("-");
    if (parts.length !== 4) continue;
    const [, code, strikeStr, cp] = parts;
    const strike = Number(strikeStr);
    if (!Number.isFinite(strike)) continue;
    const g = byExpiry.get(code) ?? { calls: [], puts: [], fwd: row.underlying_price ?? index };
    // The per-expiry underlying_price is the forward, which is what moneyness
    // should be measured against rather than the spot index.
    if (row.underlying_price) g.fwd = row.underlying_price;
    const leg: Leg = {
      strike,
      iv: Number.isFinite(row.mark_iv as number) ? (row.mark_iv as number) : null,
      oi: Number.isFinite(row.open_interest as number) ? (row.open_interest as number) : 0,
      volUsd: Number.isFinite(row.volume_usd as number) ? (row.volume_usd as number) : 0,
    };
    (cp === "C" ? g.calls : g.puts).push(leg);
    byExpiry.set(code, g);
  }

  const expiries: ExpiryRow[] = [];
  for (const [code, g] of byExpiry) {
    const ts = expiryMs(code);
    if (ts == null) continue;
    const dte = Math.max(0, (ts - now) / 86400_000);
    const all = [...g.calls, ...g.puts];
    const callOi = g.calls.reduce((s, l) => s + l.oi, 0);
    const putOi = g.puts.reduce((s, l) => s + l.oi, 0);
    const oi = callOi + putOi;

    // ATM: the strike closest to the forward, averaging the call and put IV
    // there since both quote the same vol in a clean book.
    let atmStrike: number | null = null;
    let atmIv: number | null = null;
    const withIv = all.filter((l) => l.iv != null && l.iv > 0);
    if (withIv.length) {
      atmStrike = withIv.reduce((a, b) =>
        Math.abs(b.strike - g.fwd) < Math.abs(a.strike - g.fwd) ? b : a
      ).strike;
      const at = withIv.filter((l) => l.strike === atmStrike).map((l) => l.iv as number);
      atmIv = at.reduce((s, v) => s + v, 0) / at.length;
    }

    // 25-delta skew proxy, quoted the market way round as a risk reversal
    // (call vol minus put vol) so negative reads as puts bid. With no greeks in
    // the feed the wings are approximated at 0.674 standard deviations out (the
    // normal quantile for 25%), scaled by ATM vol and the square root of time.
    let skew: number | null = null;
    let skewWingPct: number | null = null;
    if (atmIv != null && dte > 0.5) {
      const shift = 0.674 * (atmIv / 100) * Math.sqrt(dte / 365);
      const putLeg = pickWing(g.puts, g.fwd * Math.exp(-shift), "below", g.fwd);
      const callLeg = pickWing(g.calls, g.fwd * Math.exp(shift), "above", g.fwd);
      if (putLeg && callLeg) {
        skew = (callLeg.iv as number) - (putLeg.iv as number);
        skewWingPct = r((Math.exp(shift) - 1) * 100, 1);
      }
    }

    expiries.push({
      code,
      ts,
      dte: r(dte, 2),
      quarterly: isQuarterly(ts),
      forward: r(g.fwd, 2),
      atmStrike,
      atmIv: atmIv == null ? null : r(atmIv, 2),
      skew: skew == null ? null : r(skew, 2),
      skewWingPct,
      callOi: r(callOi, 1),
      putOi: r(putOi, 1),
      oi: r(oi, 1),
      oiUsd: r(oi * index, 0),
      volUsd: r(all.reduce((s, l) => s + l.volUsd, 0), 0),
      pcr: callOi > 0 ? r(putOi / callOi, 3) : null,
    });
  }
  expiries.sort((a, b) => a.ts - b.ts);
  if (!expiries.length) return empty;

  const callOi = expiries.reduce((s, e) => s + e.callOi, 0);
  const putOi = expiries.reduce((s, e) => s + e.putOi, 0);
  const totalOi = callOi + putOi;

  // Term structure read: compare the shortest expiry that still has a real
  // curve against the longest listed one.
  const priced = expiries.filter((e) => e.atmIv != null);
  const frontIv = priced.length ? (priced[0].atmIv as number) : null;
  const backIv = priced.length ? (priced[priced.length - 1].atmIv as number) : null;
  let shape: Desk["shape"] = null;
  if (frontIv != null && backIv != null) {
    const d = frontIv - backIv;
    // Half a vol point either way is inside the noise of a mark, call it flat.
    shape = d > 0.5 ? "backwardation" : d < -0.5 ? "contango" : "flat";
  }

  const pain: PainRow[] = [];
  for (const e of expiries.slice(0, 2)) {
    const g = byExpiry.get(e.code);
    if (!g) continue;
    const mp = maxPain(g.calls, g.puts, index);
    pain.push({
      code: e.code,
      dte: e.dte,
      maxPain: mp?.maxPain ?? null,
      distPct: mp?.distPct == null ? null : r(mp.distPct, 2),
      curve: mp?.curve ?? [],
    });
  }

  return {
    currency: cur,
    ok: true,
    index: r(index, 2),
    dvol,
    totalOi: r(totalOi, 1),
    totalOiUsd: r(totalOi * index, 0),
    totalVolUsd: r(expiries.reduce((s, e) => s + e.volUsd, 0), 0),
    callOi: r(callOi, 1),
    putOi: r(putOi, 1),
    pcrOi: callOi > 0 ? r(putOi / callOi, 3) : null,
    pcrFront: expiries[0].pcr,
    frontIv,
    backIv,
    shape,
    expiries,
    pain,
  };
}

export async function GET() {
  const now = Date.now();
  let desks: Desk[] = [];
  try {
    desks = await Promise.all(CURRENCIES.map((c) => buildDesk(c, now)));
  } catch {
    desks = [];
  }
  const payload: OptionsPayload = {
    ok: desks.some((d) => d.ok),
    asOf: new Date().toISOString(),
    desks,
  };
  return jsonResponse(payload, 300);
}

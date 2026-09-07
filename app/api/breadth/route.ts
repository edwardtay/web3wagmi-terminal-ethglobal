import { allTickers24h, klines } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { sma } from "@/lib/stats";
import { ASSETS, Sector } from "@/lib/symbols";

export const revalidate = 900;

/** Pairs pulled as candidates before the lagged volume ranking narrows them. */
const CANDIDATES = 140;
/** Size of the breadth universe after ranking on settled volume. */
const UNIVERSE = 100;

// Breadth over the liquid USDT spot board plus sector rotation over the tracked
// universe. Both readings come from the same batch of daily candles, so the
// numbers on the two panels can never disagree.

/** Pegged units, so a breadth reading is not diluted by things that cannot move. */
const PEGGED = new Set([
  "USDC", "USDT", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "RLUSD", "XUSD", "USDE",
  "USDS", "PYUSD", "BUSD", "USDD", "FRAX", "LUSD", "SUSD", "USTC", "AEUR", "EURI",
  "EUR", "GBP", "TRY", "BRL", "ARS", "JPY", "RUB", "UAH", "ZAR", "PLN", "RON", "CZK", "MXN", "IDRT", "NGN", "COP",
  // Metal-backed tokens track bullion, not crypto risk appetite.
  "PAXG", "XAUT",
  // Wrapped or staked proxies would double-count the major they track.
  "WBTC", "WBETH", "BETH", "WETH", "STETH", "WSTETH", "SOLV", "BNSOL",
]);

/**
 * Binance leveraged tokens rebalance daily, so their returns are not comparable.
 * The suffix alone is not enough: SYRUP and PUMP end in UP. A leveraged token is
 * always its underlying plus the suffix, so the prefix has to be a listed base
 * for the name to count as one.
 */
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

function isLeveraged(base: string, listed: Set<string>): boolean {
  const m = LEVERAGED.exec(base);
  if (!m) return false;
  const under = base.slice(0, -m[1].length);
  return under.length >= 2 && listed.has(under);
}

/**
 * Binance lists tokenised equities and ETFs as the stock ticker with a "B"
 * suffix (NVDAB, QQQB, CRCLB, MUB). Nothing in exchangeInfo separates them from
 * coins, so the suffix is the only available signal, and it collides with real
 * tickers like ARB and SHIB. The collisions are a short, stable list, so a
 * B-ending base is treated as an equity unless it is one of these. The failure
 * mode is a newly listed coin ending in B sitting out until the list is
 * updated, which moves a hundred-name breadth reading by one.
 */
const COIN_ENDING_IN_B = new Set([
  "AMB", "ARB", "BB", "BNB", "CKB", "DGB", "MOB", "PHB", "SHIB", "TRB", "VIB", "YB", "COMB", "SUB",
]);

function eligible(base: string, listed: Set<string>): boolean {
  if (!/^[A-Z0-9]+$/.test(base)) return false; // non-ASCII novelty listings
  if (PEGGED.has(base)) return false;
  if (isLeveraged(base, listed)) return false;
  if (base.endsWith("B") && !COIN_ENDING_IN_B.has(base)) return false;
  return true;
}

/** JSON has no NaN, so every optional number leaves as null and the client formats it as a dash. */
function fin(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function median(xs: number[]): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Percent change between two closes n bars apart, counted back from the last bar. */
function back(c: number[], n: number): number {
  const i = c.length - 1 - n;
  if (i < 0 || !(c[i] > 0)) return NaN;
  return (c[c.length - 1] / c[i] - 1) * 100;
}

/** Fetch in bounded batches: 100+ kline calls at once would trip Binance's rate limit. */
async function batched<T>(items: string[], size: number, job: (s: string) => Promise<T>): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const res = await Promise.all(slice.map((s) => job(s).catch(() => null as T)));
    slice.forEach((s, j) => out.set(s, res[j]));
  }
  return out;
}

interface Row {
  sym: string;
  r24: number;
  r7: number;
  r30: number;
  above50: boolean | null;
  above200: boolean | null;
  newHigh: boolean;
  newLow: boolean;
}

interface SectorPoint {
  x: number;
  y: number;
}

interface SectorRow {
  sector: Sector;
  n: number;
  m24: number | null;
  m7: number | null;
  m30: number | null;
  /** Latest relative-strength coordinate; trail runs oldest to newest. */
  x: number | null;
  y: number | null;
  trail: SectorPoint[];
}

interface BreadthPayload {
  ok: boolean;
  asOf: string;
  universe: number;
  quoteVolUsd: number;
  above50: { n: number; total: number };
  above200: { n: number; total: number };
  ad24: { up: number; down: number };
  ad7: { up: number; down: number };
  highs30: number;
  lows30: number;
  outperf7: { n: number; total: number };
  outperf30: { n: number; total: number };
  btc: { r24: number | null; r7: number | null; r30: number | null };
  altIndex: number | null;
  sectors: SectorRow[];
}

const EMPTY: Omit<BreadthPayload, "ok" | "asOf"> = {
  universe: 0,
  quoteVolUsd: 0,
  above50: { n: 0, total: 0 },
  above200: { n: 0, total: 0 },
  ad24: { up: 0, down: 0 },
  ad7: { up: 0, down: 0 },
  highs30: 0,
  lows30: 0,
  outperf7: { n: 0, total: 0 },
  outperf30: { n: 0, total: 0 },
  btc: { r24: null, r7: null, r30: null },
  altIndex: null,
  sectors: [],
};

export async function GET() {
  const asOf = new Date().toISOString();
  const tickers = await allTickers24h(900);
  if (!tickers) return jsonResponse({ ok: false, asOf, ...EMPTY }, revalidate);

  const usdt = tickers.filter(
    (t) => t.symbol.endsWith("USDT") && Number(t.lastPrice) > 0 && Number(t.quoteVolume) > 0
  );
  const listed = new Set(usdt.map((t) => t.symbol.slice(0, -4)));

  // Universe selection deliberately lags. Ranking on the current rolling 24h
  // volume lets whatever is pumping right now buy its way into the sample while
  // quiet losers drop out, which flatters breadth during exactly the frothy
  // rotations you want it to measure honestly. So take a wider candidate list on
  // current volume, then rank those candidates on the LAST COMPLETED day's
  // volume from their candles, and keep the top 100.
  const candidates = usdt
    .filter((t) => eligible(t.symbol.slice(0, -4), listed))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, CANDIDATES);

  const chg24 = new Map(tickers.map((t) => [t.symbol, Number(t.priceChangePercent)]));

  // The rotation panel needs the tracked universe too, and BTC anchors both.
  const pairs = Array.from(new Set([...candidates.map((t) => t.symbol), ...ASSETS.map((a) => a.pair), "BTCUSDT"]));
  const bars = await batched(pairs, 8, (p) => klines(p, "1d", 250));

  const series = new Map<string, number[]>();
  const priorVol = new Map<string, number>();
  for (const [pair, ks] of bars) {
    if (!ks) continue;
    series.set(pair, ks.map((k) => k.close).filter(Number.isFinite));
    // The final bar is today and still forming, so the one before it is the last
    // completed session.
    const settled = ks.length >= 2 ? ks[ks.length - 2] : null;
    if (settled && Number.isFinite(settled.quoteVolume)) priorVol.set(pair, settled.quoteVolume);
  }

  const ranked = candidates
    .filter((t) => priorVol.has(t.symbol))
    .sort((a, b) => (priorVol.get(b.symbol) ?? 0) - (priorVol.get(a.symbol) ?? 0))
    .slice(0, UNIVERSE);

  const quoteVolUsd = ranked.reduce((s, t) => s + (priorVol.get(t.symbol) ?? 0), 0);

  const btc = series.get("BTCUSDT");
  if (!btc || btc.length < 60) return jsonResponse({ ok: false, asOf, ...EMPTY }, revalidate);
  const btcR = { r24: chg24.get("BTCUSDT") ?? NaN, r7: back(btc, 7), r30: back(btc, 30) };

  const rows: Row[] = [];
  for (const t of ranked) {
    const c = series.get(t.symbol);
    if (!c || c.length < 35) continue; // too new to have a 30d window
    const last = c[c.length - 1];
    const prior30 = c.slice(-31, -1);
    rows.push({
      sym: t.symbol.slice(0, -4),
      r24: chg24.get(t.symbol) ?? NaN,
      r7: back(c, 7),
      r30: back(c, 30),
      above50: c.length >= 50 ? last > sma(c, 50) : null,
      above200: c.length >= 200 ? last > sma(c, 200) : null,
      newHigh: last > Math.max(...prior30),
      newLow: last < Math.min(...prior30),
    });
  }

  const w50 = rows.filter((r) => r.above50 !== null);
  const w200 = rows.filter((r) => r.above200 !== null);
  const v7 = rows.filter((r) => Number.isFinite(r.r7));
  const v30 = rows.filter((r) => Number.isFinite(r.r30));
  const alts7 = v7.filter((r) => r.sym !== "BTC");
  const alts30 = v30.filter((r) => r.sym !== "BTC");

  const above50 = { n: w50.filter((r) => r.above50).length, total: w50.length };
  const above200 = { n: w200.filter((r) => r.above200).length, total: w200.length };
  const ad24 = {
    up: rows.filter((r) => r.r24 > 0).length,
    down: rows.filter((r) => r.r24 < 0).length,
  };
  const ad7 = { up: v7.filter((r) => r.r7 > 0).length, down: v7.filter((r) => r.r7 < 0).length };
  const outperf7 = { n: alts7.filter((r) => r.r7 > btcR.r7).length, total: alts7.length };
  const outperf30 = { n: alts30.filter((r) => r.r30 > btcR.r30).length, total: alts30.length };

  const share = (p: { n: number; total: number }) => (p.total ? (p.n / p.total) * 100 : NaN);
  // Recipe kept in one place so the InfoHint on the panel can restate it exactly.
  const parts: [number, number][] = [
    [45, share(outperf30)],
    [25, share(outperf7)],
    [20, share(above200)],
    [10, ad7.up + ad7.down ? (ad7.up / (ad7.up + ad7.down)) * 100 : NaN],
  ];
  const used = parts.filter(([, v]) => Number.isFinite(v));
  const wsum = used.reduce((s, [w]) => s + w, 0);
  const altIndex = wsum ? used.reduce((s, [w, v]) => s + w * v, 0) / wsum : NaN;

  /* ---------------------------------------------------------- rotation -- */

  // Relative return versus BTC over 30d, measured k days ago. The rotation
  // quadrant plots that against how much it has moved in the last 7 days.
  const relX = (c: number[], k: number): number => {
    const i = c.length - 1 - k;
    const j = i - 30;
    const bi = btc.length - 1 - k;
    const bj = bi - 30;
    if (j < 0 || bj < 0) return NaN;
    const a = c[i] / c[j];
    const b = btc[bi] / btc[bj];
    return b > 0 ? (a / b - 1) * 100 : NaN;
  };

  const OFFSETS = [28, 21, 14, 7, 0];
  const bySector = new Map<Sector, typeof ASSETS>();
  for (const a of ASSETS) {
    const list = bySector.get(a.sector) ?? [];
    list.push(a);
    bySector.set(a.sector, list);
  }

  const sectors: SectorRow[] = [];
  for (const [sector, members] of bySector) {
    const live = members.map((a) => ({ a, c: series.get(a.pair) })).filter((m) => m.c && m.c.length >= 35);
    if (!live.length) continue;
    // BTC is the benchmark, so leaving it inside Majors would drag that sector
    // toward the origin by construction. It stays in the return medians below.
    const vsBtc = live.filter((m) => m.a.pair !== "BTCUSDT");
    const trail: SectorPoint[] = [];
    for (const k of vsBtc.length ? OFFSETS : []) {
      const xs = vsBtc.map((m) => relX(m.c!, k));
      const prev = vsBtc.map((m) => relX(m.c!, k + 7));
      const x = median(xs);
      const y = median(xs.map((v, i) => v - prev[i]));
      if (Number.isFinite(x) && Number.isFinite(y)) trail.push({ x, y });
    }
    const head = trail[trail.length - 1];
    sectors.push({
      sector,
      n: live.length,
      m24: fin(median(live.map((m) => chg24.get(m.a.pair) ?? NaN))),
      m7: fin(median(live.map((m) => back(m.c!, 7)))),
      m30: fin(median(live.map((m) => back(m.c!, 30)))),
      x: head ? head.x : null,
      y: head ? head.y : null,
      trail,
    });
  }
  sectors.sort((a, b) => (b.m7 ?? -Infinity) - (a.m7 ?? -Infinity));

  return jsonResponse(
    {
      ok: rows.length > 20,
      asOf,
      universe: rows.length,
      quoteVolUsd,
      above50,
      above200,
      ad24,
      ad7,
      highs30: rows.filter((r) => r.newHigh).length,
      lows30: rows.filter((r) => r.newLow).length,
      outperf7,
      outperf30,
      btc: { r24: fin(btcR.r24), r7: fin(btcR.r7), r30: fin(btcR.r30) },
      altIndex: fin(altIndex),
      sectors,
    } satisfies BreadthPayload,
    revalidate
  );
}

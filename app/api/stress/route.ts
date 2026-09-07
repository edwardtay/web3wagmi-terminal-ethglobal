import { getJson, jsonResponse } from "@/lib/http";
import { FAPI, klines, allPremiumIndex } from "@/lib/binance";
import { ASSETS, MATRIX, BY_SYM } from "@/lib/symbols";
import {
  CSI_SPECS,
  CSI_BY_ID,
  CSI_HISTORY_DAYS,
  CSI_SPARK_DAYS,
  buildCsi,
  csiBand,
  dayKey,
  median,
  rollingAvgCorrelation,
  rollingDrawdown,
  rollingPercentile,
  rollingVol,
  toDaily,
  type CsiId,
  type Pt,
  type StressPayload,
} from "@/lib/csi";

export const revalidate = 900;

const DAY = 86_400_000;
const CACHE = 900;

// Every component needs its trailing percentile window PLUS the composite
// history horizon, otherwise the index would only exist for the last few weeks.
const KLINE_DAYS = 1000; // covers 30d vol window + 365d rank + 365d history
const DVOL_DAYS = 700; // 180d rank + 365d history, with slack
const FUNDING_DAYS = 560; // 180d rank + 365d history

/**
 * The perp universe the funding median is taken over. Today's value comes from
 * the live premiumIndex board and the back history from each contract's funding
 * prints, so both ends of the series cover the same contracts: alt perps fund
 * systematically richer than the majors, and ranking a broad-universe median
 * against a majors-only history would read as permanent stress.
 */
const FUNDING_UNIVERSE = [...new Set(ASSETS.map((a) => a.perp).filter(Boolean) as string[])];

/**
 * Binance settles funding every 8 hours by default, but a handful of contracts
 * (POL, RENDER, TAO, WIF among the ones tracked here) settle every 4. Annualising
 * all of them at 3 prints a day would halve the alt rates, so the interval is
 * read per contract from fapi and only falls back to 8 hours when absent.
 */
const DEFAULT_FUNDING_HOURS = 8;

interface FundingInfoRow {
  symbol: string;
  fundingIntervalHours?: number;
}

async function fundingIntervals(): Promise<Map<string, number>> {
  const rows = await getJson<FundingInfoRow[]>(`${FAPI}/fapi/v1/fundingInfo`, { revalidate: CACHE });
  const m = new Map<string, number>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const h = Number(r.fundingIntervalHours);
      if (r.symbol && Number.isFinite(h) && h > 0) m.set(r.symbol, h);
    }
  }
  return m;
}

/** Prints per year for a contract settling every `hours` hours. */
function printsPerYear(hours: number): number {
  return (24 / hours) * 365;
}

/**
 * Dollar stablecoins that are meant to trade at exactly $1.00. Tokenised
 * treasuries (USYC, USDY, BUIDL, YLDS) are deliberately excluded: they accrue
 * yield into the token price and sit permanently above $1, which would read as
 * a permanent 1300 bps depeg.
 */
const PEG_UNIVERSE = new Set([
  "USDT", "USDC", "USDS", "DAI", "USDE", "PYUSD", "FDUSD", "TUSD", "USDD",
  "GHO", "RLUSD", "USD1", "USDG", "LUSD", "CRVUSD", "FRAX", "USD0", "SUSD",
  "USDF", "USDP", "USDX", "BUSD", "USDGO",
]);

/* ------------------------------------------------------------- upstream io -- */

async function dailyCloses(pair: string): Promise<Pt[]> {
  const ks = await klines(pair, "1d", KLINE_DAYS, CACHE);
  if (!ks) return [];
  return toDaily(ks.map((k) => ({ t: k.openTime, v: k.close })));
}

interface DvolResponse {
  result?: { data?: [number, number, number, number, number][] };
}

/** Deribit DVOL, daily candles. Rows are [ts, open, high, low, close]. */
async function dvolSeries(): Promise<Pt[]> {
  const end = Date.now();
  const start = end - DVOL_DAYS * DAY;
  const r = await getJson<DvolResponse>(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=86400&start_timestamp=${start}&end_timestamp=${end}`,
    { revalidate: CACHE, timeout: 15000 }
  );
  const rows = r?.result?.data;
  if (!Array.isArray(rows)) return [];
  return toDaily(rows.map((row) => ({ t: row[0], v: Number(row[4]) })));
}

interface FundingRow {
  fundingTime: number;
  fundingRate: string;
}

/**
 * Daily annualised funding, in percent, for one contract over FUNDING_DAYS.
 * One call returns at most 1000 rows from its startTime, which is about 333 days
 * at the 8h cadence but only 166 at 4h, so the window count is derived from the
 * contract's own interval. Without a startTime the endpoint returns just the most
 * recent 500 prints, which would leave a hole between the windows.
 */
async function fundingDaily(symbol: string, hours: number): Promise<Map<number, number>> {
  const now = Date.now();
  const spanDays = Math.floor((1000 * hours) / 24) - 5; // rows per call, with slack
  const starts: number[] = [];
  for (let s = now - FUNDING_DAYS * DAY; s < now; s += spanDays * DAY) starts.push(Math.round(s));

  const pages = await Promise.all(
    starts.map((s) =>
      getJson<FundingRow[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${s}&limit=1000`, {
        revalidate: CACHE,
      })
    )
  );
  const byDay = new Map<number, number[]>();
  for (const page of pages) {
    for (const row of page ?? []) {
      const rate = Number(row.fundingRate);
      if (!Number.isFinite(rate)) continue;
      const d = dayKey(row.fundingTime);
      const arr = byDay.get(d);
      if (arr) arr.push(rate);
      else byDay.set(d, [rate]);
    }
  }
  // Mean of the day's prints annualised at this contract's own cadence, so a
  // contract with a missing print is not skewed and 4h contracts are not halved.
  const perYear = printsPerYear(hours);
  return new Map(
    [...byDay].map(([d, rates]) => [
      d,
      (rates.reduce((a, b) => a + b, 0) / rates.length) * perYear * 100,
    ])
  );
}

interface PeggedAsset {
  symbol: string;
  gecko_id: string | null;
  pegType: string;
  circulating?: { peggedUSD?: number };
}
interface StablecoinsResponse {
  peggedAssets?: PeggedAsset[];
}
type PriceRow = { date: number; prices: Record<string, number> };

/**
 * Supply-weighted absolute peg deviation, in basis points, per day.
 * Weights come from today's circulating supply and are held fixed across the
 * history: DefiLlama serves prices and supply from different endpoints, and a
 * fixed weight keeps the series measuring price rather than supply rotation.
 */
async function pegSeries(): Promise<Pt[]> {
  const [meta, prices] = await Promise.all([
    getJson<StablecoinsResponse>("https://stablecoins.llama.fi/stablecoins?includePrices=true", {
      revalidate: CACHE,
      timeout: 20000,
    }),
    getJson<PriceRow[]>("https://stablecoins.llama.fi/stablecoinprices", {
      revalidate: CACHE,
      timeout: 25000,
    }),
  ]);
  const assets = meta?.peggedAssets;
  if (!Array.isArray(assets) || !Array.isArray(prices)) return [];

  const weights = new Map<string, number>();
  for (const a of assets) {
    if (a.pegType !== "peggedUSD" || !a.gecko_id) continue;
    if (!PEG_UNIVERSE.has(String(a.symbol ?? "").toUpperCase())) continue;
    const supply = a.circulating?.peggedUSD;
    if (!Number.isFinite(supply) || (supply as number) < 5e7) continue;
    weights.set(a.gecko_id, supply as number);
  }
  if (!weights.size) return [];

  const cutoff = Date.now() - (CSI_HISTORY_DAYS + CSI_BY_ID.peg.window + 10) * DAY;
  const out: Pt[] = [];
  for (const row of prices) {
    const ts = row.date * 1000;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    let num = 0;
    let den = 0;
    for (const [gid, w] of weights) {
      const p = row.prices?.[gid];
      if (!Number.isFinite(p) || p <= 0) continue;
      num += Math.abs(p - 1) * w;
      den += w;
    }
    // Require most of the basket to be priced, otherwise a thin day would look
    // artificially calm.
    if (den > 0.6 * [...weights.values()].reduce((a, b) => a + b, 0)) {
      out.push({ t: ts, v: (num / den) * 10_000 });
    }
  }
  return toDaily(out);
}

/* ----------------------------------------------------------------- handler -- */

export async function GET() {
  const asOf = new Date().toISOString();
  const today = dayKey(Date.now());

  const matrixPairs = MATRIX.map((s) => BY_SYM[s]?.pair).filter(Boolean) as string[];

  const intervals = await fundingIntervals();
  const fundingHours = (s: string) => intervals.get(s) ?? DEFAULT_FUNDING_HOURS;

  const [closeLists, dvol, peg, premium, fundingMaps] = await Promise.all([
    Promise.all(matrixPairs.map(dailyCloses)),
    dvolSeries(),
    pegSeries(),
    allPremiumIndex(CACHE),
    Promise.all(FUNDING_UNIVERSE.map((s) => fundingDaily(s, fundingHours(s)))),
  ]);

  const closesByPair: Record<string, Pt[]> = {};
  matrixPairs.forEach((p, i) => {
    if (closeLists[i].length > 100) closesByPair[p] = closeLists[i];
  });

  const raw: Partial<Record<CsiId, Pt[]>> = {};

  // 1. Realised vol: mean of BTC and ETH 30d annualised vol on shared dates.
  const btc = closesByPair["BTCUSDT"] ?? [];
  const eth = closesByPair["ETHUSDT"] ?? [];
  if (btc.length && eth.length) {
    const bv = new Map(rollingVol(btc, 30).map((p) => [p.t, p.v]));
    const ev = new Map(rollingVol(eth, 30).map((p) => [p.t, p.v]));
    const rv: Pt[] = [];
    for (const [t, v] of bv) {
      const e = ev.get(t);
      if (e != null) rv.push({ t, v: (v + e) / 2 });
    }
    if (rv.length) raw.rvol = rv.sort((a, b) => a.t - b.t);
  }

  // 2. Implied vol.
  if (dvol.length) raw.ivol = dvol;

  // 3. Funding: median ABSOLUTE annualised rate across the proxy contracts per day.
  {
    const days = new Set<number>();
    for (const m of fundingMaps) for (const d of m.keys()) days.add(d);
    const f: Pt[] = [];
    for (const d of [...days].sort((a, b) => a - b)) {
      const rates = fundingMaps.map((m) => m.get(d)).filter((v): v is number => v != null);
      if (rates.length < 10) continue;
      // Each entry is already annualised in percent at its own contract's cadence.
      // Median of the absolutes, not the absolute of the median. Taking the
      // median first cancels a split market: half the universe crowded long
      // against half crowded short would read as calm at peak crowding.
      f.push({ t: d, v: median(rates.map(Math.abs)) });
    }
    // Today's point comes from the live board rather than the settled prints,
    // so the index reacts within the hour. Contracts reporting exactly zero are
    // dropped: on premiumIndex that means the field is unpopulated, not that
    // funding is genuinely flat.
    if (Array.isArray(premium)) {
      const wanted = new Set(FUNDING_UNIVERSE);
      const live = premium
        .filter((p) => wanted.has(p.symbol))
        .map((p) => Number(p.lastFundingRate) * printsPerYear(fundingHours(p.symbol)) * 100)
        .filter((v) => Number.isFinite(v) && v !== 0);
      if (live.length >= 10) {
        // Same construction as the historical points: median of the absolutes.
        const v = median(live.map(Math.abs));
        const i = f.findIndex((p) => p.t === today);
        if (i >= 0) f[i] = { t: today, v };
        else f.push({ t: today, v });
      }
    }
    if (f.length) raw.funding = f;
  }

  // 4. Peg deviation.
  if (peg.length) raw.peg = peg;

  // 5. Average pairwise 30d correlation across the matrix.
  if (Object.keys(closesByPair).length >= 5) {
    const c = rollingAvgCorrelation(closesByPair, 30);
    if (c.length) raw.corr = c;
  }

  // 6. BTC distance below its trailing 365d high.
  if (btc.length > 200) {
    const dd = rollingDrawdown(btc, 365);
    if (dd.length) raw.dd = dd;
  }

  // Normalise every component the same way: percentile rank against its own
  // trailing window, so a "70" means the same thing in each column.
  const scores: Partial<Record<CsiId, Pt[]>> = {};
  for (const spec of CSI_SPECS) {
    const series = raw[spec.id];
    if (!series || series.length < spec.window + 5) continue;
    const ranked = rollingPercentile(series, spec.window);
    if (ranked.length) scores[spec.id] = ranked;
  }

  const result = buildCsi(scores);

  // Attach the latest raw reading in native units next to each score.
  for (const c of result.components) {
    const series = raw[c.id];
    if (series && series.length) {
      const last = series[series.length - 1];
      if (c.at == null || last.t >= c.at) c.raw = last.v;
      else c.raw = series.find((p) => p.t === c.at)?.v ?? last.v;
    }
    if (!c.live && series && series.length && series.length < CSI_BY_ID[c.id].window + 5) {
      c.dropReason = `only ${series.length}d of history, ${CSI_BY_ID[c.id].window}d needed to rank it`;
    }
  }

  const hist = result.history;
  const at = (backDays: number): number | null => {
    const target = today - backDays * DAY;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= target) return hist[i].v;
    return null;
  };

  const payload: StressPayload = {
    ok: result.score != null,
    asOf,
    score: result.score,
    band: csiBand(result.score ?? NaN),
    percentile: result.percentile,
    prev1d: at(1),
    prev7d: at(7),
    spark: hist.slice(-CSI_SPARK_DAYS).map((p) => p.v),
    components: result.components,
    liveIds: result.liveIds,
    droppedIds: result.droppedIds,
    coverage: result.coverage,
    historyDays: CSI_HISTORY_DAYS,
  };

  return jsonResponse(payload, CACHE);
}

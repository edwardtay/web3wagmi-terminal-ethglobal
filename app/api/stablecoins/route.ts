import { getJson, jsonResponse } from "@/lib/http";

// Stablecoin supply is the dry powder sitting on-chain. DefiLlama ships the
// whole pegged-asset universe in one ~500KB document and the aggregate series
// in another ~1.2MB, so both get filtered and sliced here: the browser only
// ever sees the few dozen rows the panel draws.

export const revalidate = 900;

const ASSETS = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
const CHART = "https://stablecoins.llama.fi/stablecoincharts/all";

/** Below this a stablecoin is a rounding error against a $300B aggregate. */
const MIN_CIRCULATING = 100_000_000;
/** Days of aggregate history kept for the headline sparkline. */
const SPARK_POINTS = 90;
/** Chains listed per asset. Enough to show where it actually lives. */
const TOP_CHAINS = 4;
const DAY = 86_400;

interface Pegged {
  peggedUSD?: number | null;
}

interface ChainSlice {
  current?: Pegged | null;
}

interface LlamaAsset {
  id: string;
  name: string;
  symbol: string;
  pegType: string;
  pegMechanism: string | null;
  yieldBearing?: boolean | null;
  price?: number | null;
  circulating?: Pegged | null;
  circulatingPrevDay?: Pegged | null;
  circulatingPrevWeek?: Pegged | null;
  circulatingPrevMonth?: Pegged | null;
  chainCirculating?: Record<string, ChainSlice | null> | null;
}

interface LlamaChartPoint {
  /** Unix seconds, delivered as a string. */
  date: string | number;
  totalCirculatingUSD?: Pegged | null;
}

export interface StableChain {
  name: string;
  /** Percent of this asset's supply sitting on the chain. */
  share: number;
}

export interface StableRow {
  id: string;
  name: string;
  symbol: string;
  /** fiat-backed, crypto-backed, algorithmic. Null when DefiLlama omits it. */
  mechanism: string | null;
  /** Tokens that accrue interest trade above $1 by design. */
  yieldBearing: boolean;
  price: number | null;
  /** Deviation from the $1.00 peg in basis points. Null without a price. */
  devBps: number | null;
  circulating: number;
  /** Percent of all USD-pegged supply. */
  share: number;
  /** Supply change in dollars, null when the prior snapshot is missing. */
  d1: number | null;
  d7: number | null;
  d30: number | null;
  /** The same changes in percent. */
  d1Pct: number | null;
  d7Pct: number | null;
  d30Pct: number | null;
  chains: StableChain[];
}

export interface StablecoinsPayload {
  ok: boolean;
  asOf: string;
  /** Aggregate USD-pegged supply, in dollars. */
  total: number;
  /**
   * Summed circulating supply of every USD-pegged asset in this snapshot. The
   * denominator behind `share`. It runs a percent or so off `total` because
   * the aggregate series marks each coin at its own price.
   */
  universe: number;
  d7: number | null;
  d7Pct: number | null;
  d30: number | null;
  d30Pct: number | null;
  /** Up to 90 daily aggregate supply points, oldest first. */
  spark: number[];
  /** How many USD-pegged assets DefiLlama tracks, before the size filter. */
  scanned: number;
  rows: StableRow[];
}

const EMPTY: Omit<StablecoinsPayload, "asOf"> = {
  ok: false,
  total: 0,
  universe: 0,
  d7: null,
  d7Pct: null,
  d30: null,
  d30Pct: null,
  spark: [],
  scanned: 0,
  rows: [],
};

function amount(p: Pegged | null | undefined): number | null {
  const v = p?.peggedUSD;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pctOf(now: number, then: number | null): number | null {
  if (then == null || then <= 0) return null;
  return ((now - then) / then) * 100;
}

function deltaOf(now: number, then: number | null): number | null {
  return then == null ? null : now - then;
}

function pointValue(p: LlamaChartPoint): number | null {
  return amount(p.totalCirculatingUSD);
}

/**
 * Value on the day closest to `days` back. Matching on the timestamp rather
 * than an index offset keeps the comparison honest if DefiLlama ever skips a
 * day, and a gap over two days is dropped instead of being passed off as a
 * 7d change.
 */
function atDaysAgo(series: LlamaChartPoint[], days: number): number | null {
  if (series.length < 2) return null;
  const anchor = Number(series[series.length - 1].date);
  if (!Number.isFinite(anchor)) return null;
  const target = anchor - days * DAY;
  let best: number | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < series.length - 1; i++) {
    const t = Number(series[i].date);
    const v = pointValue(series[i]);
    if (!Number.isFinite(t) || v == null || v <= 0) continue;
    const gap = Math.abs(t - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = v;
    }
  }
  return bestGap > 2 * DAY ? null : best;
}

function topChains(asset: LlamaAsset, circulating: number): StableChain[] {
  const raw = asset.chainCirculating;
  if (!raw || circulating <= 0) return [];
  const out: { name: string; value: number }[] = [];
  for (const [name, slice] of Object.entries(raw)) {
    const v = amount(slice?.current);
    if (v != null && v > 0) out.push({ name, value: v });
  }
  return out
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_CHAINS)
    .map((c) => ({ name: c.name, share: (c.value / circulating) * 100 }));
}

export async function GET() {
  const asOf = new Date().toISOString();

  // 20s: both documents are large enough that the 9s default times out cold.
  const [assets, chart] = await Promise.all([
    getJson<{ peggedAssets?: LlamaAsset[] }>(ASSETS, { revalidate, timeout: 20_000 }),
    getJson<LlamaChartPoint[]>(CHART, { revalidate, timeout: 20_000 }),
  ]);

  const all = Array.isArray(assets?.peggedAssets) ? assets.peggedAssets : [];
  if (all.length === 0) {
    return jsonResponse({ ...EMPTY, asOf } satisfies StablecoinsPayload, revalidate);
  }

  const usdPegged = all.filter(
    (a) => a && a.pegType === "peggedUSD" && (amount(a.circulating) ?? 0) > 0
  );
  // Share is measured against every USD-pegged asset, not only the ones large
  // enough to earn a row, so the long tail lands in "other" rather than
  // inflating the leaders.
  const universe = usdPegged.reduce((s, a) => s + (amount(a.circulating) ?? 0), 0);

  const rows: StableRow[] = usdPegged
    .filter((a) => (amount(a.circulating) ?? 0) >= MIN_CIRCULATING)
    .map((a) => {
      const circulating = amount(a.circulating) as number;
      const prevDay = amount(a.circulatingPrevDay);
      const prevWeek = amount(a.circulatingPrevWeek);
      const prevMonth = amount(a.circulatingPrevMonth);
      const price = typeof a.price === "number" && Number.isFinite(a.price) ? a.price : null;
      return {
        id: a.id,
        name: a.name,
        symbol: a.symbol,
        mechanism: a.pegMechanism ?? null,
        yieldBearing: a.yieldBearing === true,
        price,
        devBps: price == null ? null : (price - 1) * 10_000,
        circulating,
        share: universe > 0 ? (circulating / universe) * 100 : 0,
        d1: deltaOf(circulating, prevDay),
        d7: deltaOf(circulating, prevWeek),
        d30: deltaOf(circulating, prevMonth),
        d1Pct: pctOf(circulating, prevDay),
        d7Pct: pctOf(circulating, prevWeek),
        d30Pct: pctOf(circulating, prevMonth),
        chains: topChains(a, circulating),
      };
    })
    .sort((a, b) => b.circulating - a.circulating);

  const series = Array.isArray(chart) ? chart.filter((p) => p && pointValue(p) != null) : [];
  const latest = series.length ? pointValue(series[series.length - 1]) : null;
  // The aggregate series is the better headline because it counts the tail
  // too. Summing the visible rows is the fallback when the chart is down.
  const total = latest ?? universe;
  const week = atDaysAgo(series, 7);
  const month = atDaysAgo(series, 30);

  const payload: StablecoinsPayload = {
    ok: true,
    asOf,
    total,
    universe,
    d7: deltaOf(total, week),
    d7Pct: pctOf(total, week),
    d30: deltaOf(total, month),
    d30Pct: pctOf(total, month),
    // Whole dollars: a 90-point sparkline gains nothing from the cents.
    spark: series.slice(-SPARK_POINTS).map((p) => Math.round(pointValue(p) as number)),
    scanned: usdPegged.length,
    rows,
  };

  return jsonResponse(payload, revalidate);
}

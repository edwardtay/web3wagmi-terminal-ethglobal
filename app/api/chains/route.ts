import { getJson, jsonResponse } from "@/lib/http";

// Where on-chain capital actually sits. One DefiLlama snapshot of every chain's
// TVL, plus a trimmed daily history for the leaders so the table can show a
// trend rather than a single stale number.

export const revalidate = 600;

/** How many chains get a history fetch and a row in the board. */
const TOP = 20;
/** DefiLlama is generous but unmetered politeness matters: 8 in flight. */
const CONCURRENCY = 8;
/** Points kept per chain. 90 daily points is a quarter of context at ~1KB. */
const SPARK_POINTS = 90;
const DAY = 86_400;

interface LlamaChain {
  gecko_id: string | null;
  tvl: number | null;
  tokenSymbol: string | null;
  cmcId: string | null;
  name: string;
  chainId: number | null;
}

interface LlamaPoint {
  date: number;
  tvl: number;
}

export interface ChainRow {
  rank: number;
  name: string;
  symbol: string | null;
  tvl: number;
  /** Share of the summed TVL of every chain, percent. */
  share: number;
  /** Percent changes. Null when the history does not reach back that far. */
  c24: number | null;
  c7: number | null;
  c30: number | null;
  /** Up to 90 daily TVL points, oldest first. */
  spark: number[];
}

export interface ChainsPayload {
  ok: boolean;
  asOf: string;
  /** Summed TVL across every chain DefiLlama tracks. */
  total: number;
  total7d: number | null;
  total30d: number | null;
  /** Aggregate DeFi TVL history, 90 daily points, oldest first. */
  totalSpark: number[];
  /** Ethereum's percent share of total chain TVL. */
  ethDominance: number | null;
  chainCount: number;
  rows: ChainRow[];
  /** Best and worst 7d movers among the ranked rows. */
  riser: { name: string; c7: number } | null;
  faller: { name: string; c7: number } | null;
}

const EMPTY: Omit<ChainsPayload, "asOf"> = {
  ok: false,
  total: 0,
  total7d: null,
  total30d: null,
  totalSpark: [],
  ethDominance: null,
  chainCount: 0,
  rows: [],
  riser: null,
  faller: null,
};

/**
 * Value on the day closest to `days` ago. Newer chains have gaps in their
 * series (DefiLlama skips days with no data), so an index offset would compare
 * the wrong dates. Anything further than two days off the target is discarded
 * rather than passed off as a 7d change.
 */
function atDaysAgo(series: LlamaPoint[], days: number): number | null {
  if (series.length < 2) return null;
  const target = series[series.length - 1].date - days * DAY;
  let best: LlamaPoint | null = null;
  let bestGap = Infinity;
  // The final point is the anchor itself. On a gappy series it can sit within
  // tolerance of the target and would score a flat 0%, so it never competes.
  for (let i = 0; i < series.length - 1; i++) {
    const p = series[i];
    const gap = Math.abs(p.date - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  if (!best || bestGap > 2 * DAY) return null;
  return best.tvl > 0 ? best.tvl : null;
}

function changeFrom(now: number, then: number | null): number | null {
  if (then == null || then <= 0 || !Number.isFinite(now)) return null;
  return ((now - then) / then) * 100;
}

function history(name: string) {
  return getJson<LlamaPoint[]>(
    `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(name)}`,
    { revalidate, timeout: 12_000 }
  );
}

/** Round to whole dollars: a sparkline gains nothing from the cents. */
function trim(series: LlamaPoint[]): number[] {
  return series.slice(-SPARK_POINTS).map((p) => Math.round(p.tvl));
}

export async function GET() {
  const asOf = new Date().toISOString();

  const [chains, global] = await Promise.all([
    getJson<LlamaChain[]>("https://api.llama.fi/v2/chains", { revalidate, timeout: 12_000 }),
    getJson<LlamaPoint[]>("https://api.llama.fi/v2/historicalChainTvl", { revalidate, timeout: 12_000 }),
  ]);

  if (!Array.isArray(chains) || chains.length === 0) {
    return jsonResponse({ ...EMPTY, asOf }, revalidate);
  }

  const live = chains.filter((c) => c && typeof c.name === "string" && (c.tvl ?? 0) > 0);
  const total = live.reduce((s, c) => s + (c.tvl ?? 0), 0);
  const ranked = [...live].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0)).slice(0, TOP);

  // Histories in fixed-size waves rather than one 20-wide burst.
  const hist = new Map<string, LlamaPoint[]>();
  for (let i = 0; i < ranked.length; i += CONCURRENCY) {
    const wave = ranked.slice(i, i + CONCURRENCY);
    const res = await Promise.all(wave.map((c) => history(c.name)));
    res.forEach((series, j) => {
      if (Array.isArray(series) && series.length > 1) hist.set(wave[j].name, series);
    });
  }

  const rows: ChainRow[] = ranked.map((c, i) => {
    const tvl = c.tvl ?? 0;
    const series = hist.get(c.name) ?? [];
    return {
      rank: i + 1,
      name: c.name,
      symbol: c.tokenSymbol,
      tvl,
      share: total > 0 ? (tvl / total) * 100 : 0,
      c24: changeFrom(tvl, atDaysAgo(series, 1)),
      c7: changeFrom(tvl, atDaysAgo(series, 7)),
      c30: changeFrom(tvl, atDaysAgo(series, 30)),
      spark: trim(series),
    };
  });

  const moved = rows.filter((r) => r.c7 != null) as (ChainRow & { c7: number })[];
  const byMove = [...moved].sort((a, b) => b.c7 - a.c7);

  const globalOk = Array.isArray(global) && global.length > 1;
  const globalNow = globalOk ? global[global.length - 1].tvl : total;

  const eth = live.find((c) => c.name === "Ethereum");

  const payload: ChainsPayload = {
    ok: true,
    asOf,
    total,
    total7d: globalOk ? changeFrom(globalNow, atDaysAgo(global, 7)) : null,
    total30d: globalOk ? changeFrom(globalNow, atDaysAgo(global, 30)) : null,
    totalSpark: globalOk ? trim(global) : [],
    ethDominance: eth && total > 0 ? ((eth.tvl ?? 0) / total) * 100 : null,
    chainCount: live.length,
    rows,
    riser: byMove.length ? { name: byMove[0].name, c7: byMove[0].c7 } : null,
    faller: byMove.length ? { name: byMove[byMove.length - 1].name, c7: byMove[byMove.length - 1].c7 } : null,
  };

  return jsonResponse(payload, revalidate);
}

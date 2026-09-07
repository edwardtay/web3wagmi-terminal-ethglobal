import { getJson, jsonResponse } from "@/lib/http";

// DefiLlama ships every tracked pool in one ~11MB document, so the filtering
// has to happen here: the browser must never see the raw list.
export const revalidate = 900;

const SRC = "https://yields.llama.fi/pools";

const MIN_TVL = 1_000_000;
const MAX_APY = 200; // above this the print is almost always a stale or bogus emission rate

// Two slices, because ranking purely by TVL yields 300 blue-chip pools whose
// smallest is still ~$40M, which would make the $1M and $10M filters inert.
const BY_TVL = 220;
const BY_APY = 180;

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  poolMeta: string | null;
  pool: string;
  tvlUsd: number | null;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  apyPct7D: number | null;
  stablecoin: boolean;
  ilRisk: string | null;
  exposure: string | null;
  sigma: number | null;
  count: number | null;
  outlier: boolean;
  predictions: {
    predictedClass: string | null;
    predictedProbability: number | null;
    binnedConfidence: number | null;
  } | null;
}

export interface YieldPool {
  id: string;
  symbol: string;
  meta: string | null;
  project: string;
  chain: string;
  tvl: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  apyPct7D: number | null;
  stable: boolean;
  il: boolean;
  single: boolean;
  sigma: number | null;
  days: number | null;
  outlier: boolean;
  outlook: string | null;
  outlookProb: number | null;
}

export interface YieldsPayload {
  ok: boolean;
  asOf: string;
  scanned: number;
  passed: number;
  kept: number;
  chains: string[];
  pools: YieldPool[];
}

function shape(p: LlamaPool): YieldPool {
  return {
    id: p.pool,
    symbol: p.symbol,
    meta: p.poolMeta,
    project: p.project,
    chain: p.chain,
    tvl: p.tvlUsd as number,
    apy: p.apy as number,
    apyBase: p.apyBase,
    apyReward: p.apyReward,
    apyMean30d: p.apyMean30d,
    apyPct7D: p.apyPct7D,
    stable: p.stablecoin === true,
    il: p.ilRisk === "yes",
    single: p.exposure === "single",
    sigma: p.sigma,
    days: p.count,
    outlier: p.outlier === true,
    outlook: p.predictions?.predictedClass ?? null,
    outlookProb: p.predictions?.predictedProbability ?? null,
  };
}

export async function GET() {
  const asOf = new Date().toISOString();
  // 20s: the payload is large enough that the default 9s times out on a cold edge.
  const raw = await getJson<{ status: string; data: LlamaPool[] }>(SRC, {
    revalidate,
    timeout: 20_000,
  });

  const all = Array.isArray(raw?.data) ? raw.data : [];
  if (all.length === 0) {
    return jsonResponse(
      { ok: false, asOf, scanned: 0, passed: 0, kept: 0, chains: [], pools: [] } satisfies YieldsPayload,
      revalidate
    );
  }

  const passed = all.filter(
    (p) =>
      typeof p.tvlUsd === "number" &&
      p.tvlUsd > MIN_TVL &&
      typeof p.apy === "number" &&
      p.apy >= 0 &&
      p.apy <= MAX_APY &&
      typeof p.symbol === "string"
  );

  const byTvl = [...passed].sort((a, b) => (b.tvlUsd as number) - (a.tvlUsd as number));
  const head = byTvl.slice(0, BY_TVL);
  const taken = new Set(head.map((p) => p.pool));
  const tail = byTvl
    .filter((p) => !taken.has(p.pool))
    .sort((a, b) => (b.apy as number) - (a.apy as number))
    .slice(0, BY_APY);

  const pools = [...head, ...tail].map(shape);

  // Chains ordered by how many pools they contribute, so the filter's first
  // entries are the ones worth looking at.
  const counts = new Map<string, number>();
  for (const p of pools) counts.set(p.chain, (counts.get(p.chain) ?? 0) + 1);
  const chains = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);

  return jsonResponse(
    {
      ok: true,
      asOf,
      scanned: all.length,
      passed: passed.length,
      kept: pools.length,
      chains,
      pools,
    } satisfies YieldsPayload,
    revalidate
  );
}

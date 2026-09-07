import { getJson, jsonResponse } from "@/lib/http";

// Three DefiLlama documents feed one panel: /protocols is ~8MB, the two
// dimension overviews are 1-4MB each. All of that is reduced here so the
// browser only receives the few dozen rows the panel actually draws.
export const revalidate = 900;

const PROTOCOLS = "https://api.llama.fi/protocols";
const DIM = "https://api.llama.fi/overview";
const DIM_Q = "excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

// Below $50M TVL a 7d move is usually one whale wallet or a re-index by
// DefiLlama, not a flow worth reading as a signal.
const MIN_TVL = 50_000_000;
const MOVERS = 15; // per side
const DEX_ROWS = 20;
const FEE_ROWS = 20;

interface LlamaProtocol {
  name: string;
  category: string | null;
  chains: string[] | null;
  tvl: number | null;
  change_1d: number | null;
  change_7d: number | null;
  mcap: number | null;
  slug: string | null;
}

interface DimProtocol {
  name: string;
  displayName: string | null;
  category: string | null;
  chains: string[] | null;
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  change_1d: number | null;
  change_7d: number | null;
  slug: string | null;
}

interface DimOverview {
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  change_1d: number | null;
  change_7d: number | null;
  change_7dover7d: number | null;
  protocols: DimProtocol[] | null;
}

export interface MoverRow {
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  change1d: number | null;
  change7d: number;
  mcap: number | null;
}

export interface DexRow {
  name: string;
  chains: string[];
  vol24h: number;
  vol7d: number | null;
  change1d: number | null;
  share: number; // percent of total tracked spot DEX 24h volume
}

export interface FeeRow {
  name: string;
  category: string;
  chains: string[];
  fees24h: number;
  fees7d: number | null;
  revenue24h: number | null;
  takeRate: number | null; // revenue as a percent of fees
}

export interface ProtocolsPayload {
  ok: boolean;
  asOf: string;
  gainers: MoverRow[];
  losers: MoverRow[];
  tvlCount: number;
  dex: {
    total24h: number | null;
    total7d: number | null;
    total30d: number | null;
    change1d: number | null;
    change7dover7d: number | null;
    rows: DexRow[];
  };
  fees: {
    total24h: number | null;
    total7d: number | null;
    revenue24h: number | null;
    change1d: number | null;
    rows: FeeRow[];
  };
}

const fin = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

function toMover(p: LlamaProtocol): MoverRow {
  return {
    name: p.name,
    category: p.category ?? "Other",
    chains: p.chains ?? [],
    tvl: p.tvl ?? 0,
    change1d: fin(p.change_1d),
    change7d: p.change_7d as number,
    mcap: fin(p.mcap),
  };
}

export async function GET() {
  const [protocols, dexs, fees, revenue] = await Promise.all([
    getJson<LlamaProtocol[]>(PROTOCOLS, { revalidate, timeout: 20_000 }),
    getJson<DimOverview>(`${DIM}/dexs?${DIM_Q}`, { revalidate, timeout: 20_000 }),
    getJson<DimOverview>(`${DIM}/fees?${DIM_Q}`, { revalidate, timeout: 20_000 }),
    // Revenue is a separate dataType on the same endpoint; the default payload
    // carries fees only, so conflating the two is a real risk without this call.
    getJson<DimOverview>(`${DIM}/fees?${DIM_Q}&dataType=dailyRevenue`, {
      revalidate,
      timeout: 20_000,
    }),
  ]);

  let gainers: MoverRow[] = [];
  let losers: MoverRow[] = [];
  let tvlCount = 0;
  if (Array.isArray(protocols)) {
    const big = protocols.filter(
      (p) => (p.tvl ?? 0) > MIN_TVL && typeof p.change_7d === "number" && Number.isFinite(p.change_7d)
    );
    tvlCount = big.length;
    const sorted = [...big].sort((a, b) => (b.change_7d as number) - (a.change_7d as number));
    // Split the universe in half before slicing, so a thin upstream day can
    // never list the same protocol as both a gainer and a loser.
    const half = Math.floor(sorted.length / 2);
    gainers = sorted.slice(0, Math.min(MOVERS, half)).map(toMover);
    losers = sorted.slice(Math.max(half, sorted.length - MOVERS)).reverse().map(toMover);
  }

  let dexRows: DexRow[] = [];
  const dexTotal = fin(dexs?.total24h);
  if (Array.isArray(dexs?.protocols)) {
    const top = [...dexs.protocols]
      .filter((p) => (p.total24h ?? 0) > 0)
      .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
      .slice(0, DEX_ROWS);
    dexRows = top.map((p) => ({
      name: p.displayName || p.name,
      chains: p.chains ?? [],
      vol24h: p.total24h ?? 0,
      vol7d: fin(p.total7d),
      change1d: fin(p.change_1d),
      share: dexTotal && dexTotal > 0 ? ((p.total24h ?? 0) / dexTotal) * 100 : 0,
    }));
  }

  // Match revenue to fees by protocol name: the two payloads are generated from
  // the same adapter list, so the names line up exactly.
  const revByName = new Map<string, number>();
  for (const p of revenue?.protocols ?? []) {
    const v = fin(p.total24h);
    if (v != null) revByName.set(p.name, v);
  }

  let feeRows: FeeRow[] = [];
  if (Array.isArray(fees?.protocols)) {
    feeRows = [...fees.protocols]
      .filter((p) => (p.total24h ?? 0) > 0)
      .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
      .slice(0, FEE_ROWS)
      .map((p) => {
        const f = p.total24h ?? 0;
        const r = revByName.get(p.name) ?? null;
        return {
          name: p.displayName || p.name,
          category: p.category ?? "Other",
          chains: p.chains ?? [],
          fees24h: f,
          fees7d: fin(p.total7d),
          revenue24h: r,
          // Some adapters report revenue above fees for a day (rebates, timing
          // differences), so the ratio is left uncapped and shown as reported.
          takeRate: r != null && f > 0 ? (r / f) * 100 : null,
        };
      });
  }

  const payload: ProtocolsPayload = {
    ok: gainers.length > 0 || dexRows.length > 0 || feeRows.length > 0,
    asOf: new Date().toISOString(),
    gainers,
    losers,
    tvlCount,
    dex: {
      total24h: dexTotal,
      total7d: fin(dexs?.total7d),
      total30d: fin(dexs?.total30d),
      change1d: fin(dexs?.change_1d),
      change7dover7d: fin(dexs?.change_7dover7d),
      rows: dexRows,
    },
    fees: {
      total24h: fin(fees?.total24h),
      total7d: fin(fees?.total7d),
      revenue24h: fin(revenue?.total24h),
      change1d: fin(fees?.change_1d),
      rows: feeRows,
    },
  };

  return jsonResponse(payload, revalidate);
}

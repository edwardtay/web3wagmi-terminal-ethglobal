import { getJson, jsonResponse } from "@/lib/http";

// Who the money actually reaches.
//
// Three readings of the same flow, which is the point: fees are what users
// paid, revenue is what the protocol kept out of that, and holders revenue is
// the part that reaches the token. A protocol can print enormous fees and keep
// almost none of them, because most of a DEX's fees are the liquidity
// providers' income rather than the protocol's, and a table showing only fees
// makes those two look like the same business.
//
// Profit is not here, and the absence is deliberate. Profit would be revenue
// minus token emissions, DefiLlama does not publish an earnings series through
// this endpoint, and subtracting an incentives number from a different adapter
// would produce a figure that looks precise and is not comparable across rows.
// The take rate is the honest version of the same question: of everything users
// paid, how much did this protocol keep.
//
// Chains and applications come from one payload, told apart by category, so
// comparing a chain's fees with an app's costs no extra request.
//
// Each of the three documents is about 4MB, so they are read server-side, held
// in process, and never shipped to the browser. Budget: three requests an hour,
// free and keyless.

export const revalidate = 3600;

const BASE = "https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

interface Row {
  defillamaId?: string;
  name?: string;
  displayName?: string;
  category?: string | null;
  chains?: string[];
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  total1y?: number | null;
  totalAllTime?: number | null;
}
interface Overview {
  protocols?: Row[];
}

export type Period = "d1" | "d7" | "d30" | "y1" | "all";

const FIELD: Record<Period, keyof Row> = {
  d1: "total24h",
  d7: "total7d",
  d30: "total30d",
  y1: "total1y",
  all: "totalAllTime",
};

export interface EarnerRow {
  name: string;
  category: string | null;
  chains: string[];
  fees: Partial<Record<Period, number | null>>;
  revenue: Partial<Record<Period, number | null>>;
  holders: Partial<Record<Period, number | null>>;
  /** Revenue as a share of fees over 30 days, 0 to 1. What the protocol keeps. */
  takeRate: number | null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

function index(rows: Row[] | undefined): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows ?? []) {
    const key = r.defillamaId ?? r.name;
    if (key) m.set(String(key), r);
  }
  return m;
}

function periods(r: Row | undefined): Partial<Record<Period, number | null>> {
  if (!r) return {};
  const out: Partial<Record<Period, number | null>> = {};
  for (const p of Object.keys(FIELD) as Period[]) out[p] = num(r[FIELD[p]]);
  return out;
}

export async function GET() {
  const [fees, rev, hold] = await Promise.all([
    getJson<Overview>(BASE, { revalidate, timeout: 45_000, memo: true }),
    getJson<Overview>(`${BASE}&dataType=dailyRevenue`, { revalidate, timeout: 45_000, memo: true }),
    getJson<Overview>(`${BASE}&dataType=dailyHoldersRevenue`, { revalidate, timeout: 45_000, memo: true }),
  ]);

  if (!fees?.protocols?.length) {
    return jsonResponse({ ok: false, apps: [], chains: [], asOf: null, note: "The DefiLlama fee feed is unavailable." }, 300);
  }

  const revById = index(rev?.protocols);
  const holdById = index(hold?.protocols);

  const build = (r: Row): EarnerRow => {
    const key = String(r.defillamaId ?? r.name ?? "");
    const f = periods(r);
    const v = periods(revById.get(key));
    const h = periods(holdById.get(key));
    const f30 = f.d30 ?? null;
    const v30 = v.d30 ?? null;
    return {
      name: r.displayName || r.name || "unknown",
      category: r.category ?? null,
      chains: (r.chains ?? []).slice(0, 4),
      fees: f,
      revenue: v,
      holders: h,
      // Over thirty days rather than a day, because a single day of fees on a
      // launchpad or a quiet DEX is noise and a ratio built on noise is worse
      // than no ratio.
      takeRate: f30 && v30 != null && f30 > 0 ? Math.min(1, v30 / f30) : null,
    };
  };

  const all = fees.protocols.map(build);
  const isChain = (r: EarnerRow) => (r.category ?? "") === "Chain";

  // Ranked on thirty days, which is the window that survives a quiet Sunday,
  // and the panel can re-sort on any other period from the same rows.
  const rank = (rows: EarnerRow[]) =>
    rows.sort((a, b) => (b.fees.d30 ?? 0) - (a.fees.d30 ?? 0)).slice(0, 25);

  return jsonResponse(
    {
      ok: true,
      asOf: new Date().toISOString(),
      apps: rank(all.filter((r) => !isChain(r))),
      chains: rank(all.filter(isChain)),
      note: null,
    },
    revalidate
  );
}

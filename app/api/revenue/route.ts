import { getJson, jsonResponse } from "@/lib/http";

// Who the money actually reaches.
//
// The whole path a dollar takes, which is the point. Users pay a fee. Part of
// it is the suppliers' income, the liquidity providers and depositors and
// stakers who put up the capital, and never touches the protocol. The rest the
// protocol keeps. Part of what it keeps reaches token holders, through a
// buyback or a distribution. Those four figures are four documents from the
// same endpoint, and they reconcile exactly: suppliers plus kept equals fees,
// to the cent, on every row checked.
//
// A table of fees alone makes a DEX and a stablecoin issuer look like the same
// business. Uniswap V4 took $107m in fees over thirty days and kept none of
// it; Tether took $480m and kept all of it. Only the split says so.
//
// Profit is not here, and the absence is deliberate. Profit would be revenue
// minus token emissions, DefiLlama does not publish an earnings series through
// this endpoint, and subtracting an incentives number from a different adapter
// would produce a figure that looks precise and is not comparable across rows.
// What reaches holders is the honest neighbour of that question: of everything
// users paid, how much came back to the people who own the thing.
//
// Chains and applications come from one payload, told apart by category, so
// comparing a chain's fees with an app's costs no extra request.
//
// WHAT IS SHIPPED, and why it is not simply the biggest rows. Ranking by fees
// and truncating would decide the reader's question for them: 21 of the top 25
// protocols by holder revenue are outside the top 25 by fees, so a board built
// that way cannot answer "who returns the most to holders" at all. Curve,
// Jupiter, Convex, Chainlink Staking and Aerodrome were all invisible. The
// union below keeps the leaders of every column on every window, so the sort
// the reader picks is a sort over rows that are actually there.
//
// Each document is about 4MB, so they are read server-side, held in process,
// and never shipped to the browser. Budget: four requests an hour, free and
// keyless.

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
  slug?: string;
  /** The window before the window, which is what makes growth measurable. */
  protocolType?: string;
  total48hto24h?: number | null;
  total14dto7d?: number | null;
  total60dto30d?: number | null;
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
  /**
   * DefiLlama's own slug, which is what the drill-down asks for. Carried here
   * so that route can check a requested slug against the board rather than
   * forwarding whatever it is handed, which would make it an open proxy onto
   * someone else's API.
   */
  slug: string | null;
  category: string | null;
  chains: string[];
  fees: Partial<Record<Period, number | null>>;
  revenue: Partial<Record<Period, number | null>>;
  /** True where the source calls this a chain rather than something built on one. */
  isChain: boolean;
  /** The suppliers' share: liquidity providers, depositors, stakers. */
  supply: Partial<Record<Period, number | null>>;
  holders: Partial<Record<Period, number | null>>;
  /** Revenue as a share of fees over 30 days, 0 to 1. What the protocol keeps. */
  takeRate: number | null;
  /**
   * Fees over the window before this one, so the panel can compare like with
   * like: yesterday against the day before, this week against last week, this
   * month against the month before. Only the three shortest windows have a
   * prior; a year and all time have nothing to sit beside.
   */
  prior: Partial<Record<Period, number | null>>;
}


// Zero means "not published" far more often than it means zero in these
// documents, so it is read as absent. That is right in general and wrong in one
// specific place, which `reconcile` below repairs.
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/**
 * Recover a genuine zero from the identity, where the source drops it.
 *
 * Uniswap V4 took $107m in fees over thirty days and kept none of it: the fee
 * switch is off, so every cent is the liquidity providers'. The revenue
 * document reports that as 0, which is read as absent, which made the third
 * largest fee generator in the market look untracked. Asked whether it was
 * profitable, the assistant said it had no data, which was worse than a wrong
 * number: the true answer is one of the more interesting facts on the board.
 *
 * Suppliers plus kept equals the fee, exactly, on 1,616 of the 1,697 protocols
 * where both series exist. So where the fee and the suppliers' share are both
 * known and the kept figure is not, it is the difference, and for Uniswap V4
 * that difference is a real and meaningful zero rather than a silence.
 *
 * Only where the suppliers' share does not exceed the fee. Where an adapter
 * reports otherwise it is inconsistent with itself and nothing here can fix
 * that, so the figure stays absent.
 */
function reconcile(
  fees: Partial<Record<Period, number | null>>,
  supply: Partial<Record<Period, number | null>>,
  revenue: Partial<Record<Period, number | null>>
): Partial<Record<Period, number | null>> {
  const out = { ...revenue };
  for (const period of Object.keys(FIELD) as Period[]) {
    if (out[period] != null) continue;
    const f = fees[period];
    const sup = supply[period];
    if (f == null || sup == null || sup > f) continue;
    out[period] = f - sup;
  }
  return out;
}

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
  const [fees, rev, hold, supply] = await Promise.all([
    getJson<Overview>(BASE, { revalidate, timeout: 45_000, memo: true }),
    getJson<Overview>(`${BASE}&dataType=dailyRevenue`, { revalidate, timeout: 45_000, memo: true }),
    getJson<Overview>(`${BASE}&dataType=dailyHoldersRevenue`, { revalidate, timeout: 45_000, memo: true }),
    getJson<Overview>(`${BASE}&dataType=dailySupplySideRevenue`, { revalidate, timeout: 45_000, memo: true }),
  ]);

  if (!fees?.protocols?.length) {
    return jsonResponse({ ok: false, apps: [], chains: [], asOf: null, note: "The DefiLlama fee feed is unavailable." }, 300);
  }

  const revById = index(rev?.protocols);
  const holdById = index(hold?.protocols);
  const supplyById = index(supply?.protocols);

  const build = (r: Row): EarnerRow => {
    const key = String(r.defillamaId ?? r.name ?? "");
    const f = periods(r);
    const sup = periods(supplyById.get(key));
    const v = reconcile(f, sup, periods(revById.get(key)));
    const h = periods(holdById.get(key));
    const f30 = f.d30 ?? null;
    const v30 = v.d30 ?? null;
    return {
      name: r.displayName || r.name || "unknown",
      slug: r.slug ?? null,
      // Either signal, because neither is complete on its own. The source
      // labels Everclear a cross chain bridge and Space and Time developer
      // tools while typing both of them as chains, so a category test alone
      // filed two chains under applications.
      //
      // What this deliberately does not do is guess from a name. "Arbitrum
      // Nitro" reads like the L2 and is not: it is the Foundation's earnings
      // from the Nitro stack running Robinhood Chain, typed a protocol and
      // categorised Foundation, and Arbitrum the chain is a separate row
      // earning a different amount. Opening the row says which chain the fees
      // came from, which is the honest way to resolve that rather than
      // rewriting the source's classification from a substring.
      isChain: (r.category ?? "") === "Chain" || r.protocolType === "chain",
      category: r.category ?? null,
      chains: (r.chains ?? []).slice(0, 4),
      fees: f,
      revenue: v,
      supply: sup,
      holders: h,
      // Over thirty days rather than a day, because a single day of fees on a
      // launchpad or a quiet DEX is noise and a ratio built on noise is worse
      // than no ratio.
      takeRate: f30 && v30 != null && f30 > 0 ? Math.min(1, v30 / f30) : null,
      prior: {
        d1: num(r.total48hto24h),
        d7: num(r.total14dto7d),
        d30: num(r.total60dto30d),
      },
    };
  };

  const all = fees.protocols.map(build);
  const isChain = (r: EarnerRow) => r.isChain;

  // The leaders of every column, on every window.
  //
  // Not the top N by fees. The panel lets a reader sort by revenue, by what
  // reaches holders, by growth, over any of five windows, and a sort can only
  // rank rows that were sent: truncating on one metric server-side would
  // silently answer a different question than the one the reader asked. So
  // take the top thirty by each of the three metrics on each of the five
  // windows and keep the union, which is about 110 applications out of 2,400
  // and 70 chains out of 240.
  //
  // Ordered by thirty-day fees on the way out, because the panel needs some
  // order to open with and that is the window that survives a quiet Sunday.
  const METRICS = ["fees", "revenue", "holders"] as const;
  const PER_METRIC = 30;

  const rank = (rows: EarnerRow[]) => {
    const keep = new Set<EarnerRow>();
    for (const metric of METRICS) {
      for (const period of Object.keys(FIELD) as Period[]) {
        [...rows]
          .sort((a, b) => (b[metric][period] ?? 0) - (a[metric][period] ?? 0))
          .slice(0, PER_METRIC)
          .forEach((r) => keep.add(r));
      }
    }
    return [...keep].sort((a, b) => (b.fees.d30 ?? 0) - (a.fees.d30 ?? 0));
  };

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

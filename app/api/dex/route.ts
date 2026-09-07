import { getJson, jsonResponse } from "@/lib/http";

// On-chain DEX pools from the GeckoTerminal public API (free, no key, 30 calls
// per minute). This is the long tail the rest of the terminal does not reach:
// the centralised universe in lib/symbols.ts is 27 names, while this covers
// every pool on every indexed network.
//
// Trending is GeckoTerminal's own ranking. New pools are ordered by creation
// time. We add the derived reads a trader needs before touching a fresh pool:
// turnover against liquidity, buy pressure, and the FDV to liquidity ratio.

export const revalidate = 60;

const GT = "https://api.geckoterminal.com/api/v2";

interface GtToken {
  id: string;
  type: string;
  attributes?: { symbol?: string; name?: string };
}

interface GtDex {
  id: string;
  type: string;
  attributes?: { name?: string };
}

interface GtPool {
  id: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string;
    price_change_percentage?: Record<string, string | null>;
    volume_usd?: Record<string, string | null>;
    transactions?: Record<string, { buys?: number; sells?: number; buyers?: number; sellers?: number }>;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    network?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

interface GtList {
  data?: GtPool[];
  included?: (GtToken | GtDex)[];
}

interface GtNetworks {
  data?: { id: string; attributes?: { name?: string } }[];
}

export interface DexPool {
  key: string;
  network: string;
  networkName: string;
  dex: string;
  pair: string;
  base: string;
  quote: string;
  address: string;
  priceUsd: number | null;
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
  vol1h: number | null;
  vol24h: number | null;
  liquidity: number | null;
  fdv: number | null;
  buys24: number;
  sells24: number;
  buyers24: number;
  sellers24: number;
  createdAt: string | null;
  /** 24h volume divided by pool liquidity. High turnover on thin liquidity is where slippage lives. */
  turnover: number | null;
  /** Fully diluted value divided by liquidity. A large ratio means very little of the supply can actually exit. */
  fdvToLiq: number | null;
  /** Buy share of 24h trade count, 0 to 100. */
  buyShare: number | null;
  url: string;
}

function n(v: string | null | undefined): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function mapPools(list: GtList, networkNames: Record<string, string>): DexPool[] {
  const tokens: Record<string, string> = {};
  const dexes: Record<string, string> = {};
  for (const inc of list.included ?? []) {
    if (inc.type === "token") tokens[inc.id] = (inc as GtToken).attributes?.symbol ?? "";
    if (inc.type === "dex") dexes[inc.id] = (inc as GtDex).attributes?.name ?? inc.id;
  }

  const out: DexPool[] = [];
  for (const p of list.data ?? []) {
    const a = p.attributes;
    if (!a?.address) continue;
    const net = p.relationships?.network?.data?.id ?? "";
    const baseId = p.relationships?.base_token?.data?.id ?? "";
    const quoteId = p.relationships?.quote_token?.data?.id ?? "";
    const dexId = p.relationships?.dex?.data?.id ?? "";
    const tx24 = a.transactions?.h24 ?? {};
    const buys = tx24.buys ?? 0;
    const sells = tx24.sells ?? 0;
    const liquidity = n(a.reserve_in_usd);
    const vol24h = n(a.volume_usd?.h24 ?? null);
    const fdv = n(a.fdv_usd ?? null);

    out.push({
      key: p.id,
      network: net,
      networkName: networkNames[net] ?? net,
      dex: dexes[dexId] ?? dexId,
      pair: a.name ?? "",
      // The pool name already carries both sides, so the token symbols are only
      // a fallback for pools GeckoTerminal returns without a name.
      base: tokens[baseId] || (a.name ?? "").split(" / ")[0] || "",
      quote: tokens[quoteId] || (a.name ?? "").split(" / ")[1] || "",
      address: a.address,
      priceUsd: n(a.base_token_price_usd),
      m5: n(a.price_change_percentage?.m5 ?? null),
      h1: n(a.price_change_percentage?.h1 ?? null),
      h6: n(a.price_change_percentage?.h6 ?? null),
      h24: n(a.price_change_percentage?.h24 ?? null),
      vol1h: n(a.volume_usd?.h1 ?? null),
      vol24h,
      liquidity,
      fdv,
      buys24: buys,
      sells24: sells,
      buyers24: tx24.buyers ?? 0,
      sellers24: tx24.sellers ?? 0,
      createdAt: a.pool_created_at ?? null,
      turnover: liquidity && liquidity > 0 && vol24h != null ? vol24h / liquidity : null,
      fdvToLiq: liquidity && liquidity > 0 && fdv != null ? fdv / liquidity : null,
      buyShare: buys + sells > 0 ? (buys / (buys + sells)) * 100 : null,
      url: `https://www.geckoterminal.com/${net}/pools/${a.address}`,
    });
  }
  return out;
}

function empty(): Response {
  return jsonResponse(
    { ok: false, asOf: new Date().toISOString(), trending: [], fresh: [], networks: [] },
    revalidate
  );
}

export async function GET() {
  const inc = "include=base_token,quote_token,dex";
  // Two pages of trending gives 40 pools, enough to filter by network and
  // liquidity and still leave a usable table. Networks are needed only for
  // display names, and they change rarely, so they cache for a day.
  const [net1, net2, t1, t2, fresh1] = await Promise.all([
    getJson<GtNetworks>(`${GT}/networks?page=1`, { revalidate: 86400, timeout: 15000 }),
    getJson<GtNetworks>(`${GT}/networks?page=2`, { revalidate: 86400, timeout: 15000 }),
    getJson<GtList>(`${GT}/networks/trending_pools?${inc}&page=1`, { revalidate, timeout: 15000 }),
    getJson<GtList>(`${GT}/networks/trending_pools?${inc}&page=2`, { revalidate, timeout: 15000 }),
    getJson<GtList>(`${GT}/networks/new_pools?${inc}&page=1`, { revalidate, timeout: 15000 }),
  ]);

  if (!t1 && !fresh1) return empty();

  const networkNames: Record<string, string> = {};
  for (const page of [net1, net2]) {
    for (const row of page?.data ?? []) networkNames[row.id] = row.attributes?.name ?? row.id;
  }

  const trending = [...mapPools(t1 ?? {}, networkNames), ...mapPools(t2 ?? {}, networkNames)];
  const freshPools = mapPools(fresh1 ?? {}, networkNames);

  const networks = [...new Set([...trending, ...freshPools].map((p) => p.networkName))]
    .filter(Boolean)
    .sort();

  return jsonResponse(
    {
      ok: trending.length > 0 || freshPools.length > 0,
      asOf: new Date().toISOString(),
      trending,
      fresh: freshPools,
      networks,
    },
    revalidate
  );
}

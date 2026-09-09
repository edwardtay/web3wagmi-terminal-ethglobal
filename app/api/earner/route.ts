import { getJson, jsonResponse } from "@/lib/http";
import { holders, tokenInfo, NETWORKS, type Network } from "@/lib/graph";
import type { EarnerRow } from "../revenue/route";

// One earner, in depth.
//
// The board answers who earns and how much. It cannot answer the next question
// a reader has, which is what this thing actually is and whether the number is
// a trend or a day. This route answers that for one row: the shape of its fees
// over the past quarter, which chains it earns on, and who owns its token.
//
// That last part is the one no fee aggregator gives. A protocol's earnings and
// its ownership are usually two different screens on two different sites, and
// the interesting question sits between them: this thing earns $71m a quarter,
// so who holds the token that the earnings accrue to, and is it ten addresses?
// The Graph's Token API answers it for any EVM token, so it is answered here.
//
// Only for slugs already on the board. The slug comes from the query string and
// is forwarded to another API, which without a check is an open proxy: anyone
// could point this at any DefiLlama path and have this server fetch it. The
// board is the allowlist.

export const revalidate = 3600;

/** How much history the sparkline needs. A quarter shows a trend, not a blip. */
const DAYS = 90;

interface Summary {
  displayName?: string;
  name?: string;
  category?: string | null;
  chains?: string[];
  url?: string | null;
  description?: string | null;
  symbol?: string | null;
  address?: string | null;
  github?: string[] | null;
  audits?: string | null;
  methodology?: Record<string, string> | null;
  totalDataChart?: [number, number][];
  /** Chain name to that chain's own set of windowed totals. */
  chainBreakdown?: Record<string, { total30d?: number | null }>;
}

/**
 * DefiLlama prefixes a token address with its chain, or omits the prefix when
 * it means Ethereum. Only the chains the Token API indexes can be answered, and
 * a Solana address is not a failure to report: it is a token this particular
 * index does not cover, which the panel says plainly rather than showing an
 * empty ownership row that looks like a fetch that went wrong.
 */
const CHAIN_TO_NETWORK: Record<string, Network> = {
  ethereum: "mainnet",
  base: "base",
  arbitrum: "arbitrum-one",
  optimism: "optimism",
  polygon: "polygon",
  bsc: "bsc",
  avax: "avalanche",
  avalanche: "avalanche",
  unichain: "unichain",
  hyperliquid: "hyperevm",
};

function locate(address: string | null | undefined): { network: Network; contract: string } | null {
  if (!address) return null;
  const [head, tail] = address.includes(":") ? address.split(":", 2) : ["ethereum", address];
  const contract = (tail ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return null;
  const network = CHAIN_TO_NETWORK[head.toLowerCase()];
  return network && (NETWORKS as readonly string[]).includes(network) ? { network, contract } : null;
}

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(slug)) {
    return jsonResponse({ ok: false, note: "No such earner." }, 60);
  }

  const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const board = await getJson<{ apps?: EarnerRow[]; chains?: EarnerRow[] }>(`${origin}/api/revenue`, {
    revalidate,
    timeout: 60_000,
  });
  const known = [...(board?.apps ?? []), ...(board?.chains ?? [])].some((r) => r.slug === slug);
  if (!known) {
    return jsonResponse({ ok: false, note: "That is not one of the earners on this board." }, 60);
  }

  const d = await getJson<Summary>(
    `https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyFees`,
    { revalidate, timeout: 30_000 }
  );
  if (!d) return jsonResponse({ ok: false, note: "The detail read is unavailable." }, 120);

  const chart = (d.totalDataChart ?? []).slice(-DAYS).map(([t, v]) => [t, Number(v) || 0] as [number, number]);

  // Which chains the fees actually came from over thirty days, rather than
  // which chains the protocol is deployed on. A protocol listed on eight chains
  // usually earns on one, and that is worth seeing.
  //
  // The outer key is the chain and the value is that chain's own set of
  // windowed totals, not a number: reading it as a number once put
  // "annualized1y" in this list as though it were a chain.
  const byChain = Object.entries(d.chainBreakdown ?? {})
    .map(([chain, windows]) => ({ chain, feesUsd: Number(windows?.total30d) || 0 }))
    .filter((r) => r.feesUsd > 0)
    .sort((a, b) => b.feesUsd - a.feesUsd)
    .slice(0, 6);

  const at = locate(d.address);
  let ownership: {
    network: string;
    contract: string;
    holders: number | null;
    topTenSharePct: number | null;
  } | null = null;

  if (at) {
    const [top, info] = await Promise.all([
      holders(at.network, at.contract, { revalidate, timeout: 20_000, limit: 10 }),
      tokenInfo(at.network, at.contract, { revalidate, timeout: 20_000 }),
    ]);
    const supply = info?.circulating_supply ?? 0;
    const held = (top ?? []).reduce((t, h) => t + (Number(h.value) || 0), 0);
    ownership = {
      network: at.network,
      contract: at.contract,
      holders: info?.holders ?? null,
      // Ten addresses holding a large number is not concentration. Ten
      // addresses holding a large share of the supply is.
      topTenSharePct: supply > 0 && held > 0 ? Math.min(100, (held / supply) * 100) : null,
    };
  }

  return jsonResponse(
    {
      ok: true,
      asOf: new Date().toISOString(),
      slug,
      name: d.displayName || d.name || slug,
      category: d.category ?? null,
      description: d.description ?? null,
      url: d.url ?? null,
      symbol: d.symbol ?? null,
      chart,
      byChain,
      ownership,
      ownershipNote: at
        ? null
        : d.address
          ? "Its token is not on a chain the Token API indexes, so ownership is not read here."
          : "No token is recorded for this protocol.",
      note: null,
    },
    revalidate
  );
}

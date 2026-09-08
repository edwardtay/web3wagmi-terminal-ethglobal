import "server-only";
import { postJson } from "./http";

// One query, many protocols, because they share a schema.
//
// This is the part of The Graph that the rest of the terminal does not show.
// Every other on-chain read here is bespoke: the Uniswap v3 subgraph has its
// own entity names, so a query written for it is worth nothing anywhere else,
// and adding a second venue means reading a second schema and writing a second
// query and a second mapping.
//
// A standardized subgraph removes that. Messari's schema gives lending markets,
// DEXes, liquid staking and CDPs the same entities, so the query below is sent
// unchanged to nine protocols across four categories and every one of them
// answers it. Adding a tenth is one line: an id.
//
// The failure is as informative as the success, and the panel shows it. Sent to
// Uniswap v3's own subgraph, this exact query returns "Type `Query` has no
// field `protocols`", which is the cost of a bespoke schema stated by the
// gateway itself.

const GATEWAY = "https://gateway.thegraph.com/api";

/**
 * The one query. Not per protocol, not templated: this literal string is what
 * every subgraph below receives.
 */
export const STANDARD_QUERY = `{
  protocols {
    name
    type
    totalValueLockedUSD
    cumulativeSupplySideRevenueUSD
    cumulativeUniqueUsers
  }
}`;

/**
 * Messari standardized subgraphs on the decentralised network.
 *
 * Ids rather than names, because a name is not addressable. Four categories on
 * purpose: the point is not that nine lending markets answer one query, it is
 * that a lending market, a DEX, a liquid staking protocol and a CDP all do.
 */
const SUBGRAPHS: { label: string; id: string }[] = [
  { label: "Aave v3", id: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk" },
  { label: "Aave v2", id: "C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j" },
  { label: "Compound III", id: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9" },
  { label: "Compound v2", id: "4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a" },
  { label: "Curve", id: "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF" },
  { label: "Lido", id: "F7qb71hWab6SuRL5sf6LQLTpNahmqMsBnnweYHzLGUyG" },
  { label: "MakerDAO", id: "8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1" },
  { label: "Euler", id: "95nyAWFFaiz6gykko3HtBCyhRuP5vZzuKYsZiLxHxLhr" },
  { label: "Liquity", id: "2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY" },
];

/** A bespoke subgraph, sent the same query, so the contrast is measured. */
const BESPOKE = { label: "Uniswap v3", id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV" };

export interface StandardRow {
  label: string;
  /** The protocol's own name, from the shared schema rather than from us. */
  name: string | null;
  /** Messari's category: LENDING, EXCHANGE, YIELD and so on. */
  type: string | null;
  tvlUsd: number | null;
  revenueUsd: number | null;
  users: number | null;
  /** Why this one did not answer, when it did not. */
  error?: string;
}

export interface Standards {
  query: string;
  rows: StandardRow[];
  /** The same query against a subgraph that does not share the schema. */
  bespoke: { label: string; error: string | null };
  /** Requests one refresh costs, so the panel can state it. */
  queries: number;
}

interface Reply {
  data?: { protocols?: { name?: string; type?: string; totalValueLockedUSD?: string; cumulativeSupplySideRevenueUSD?: string; cumulativeUniqueUsers?: number }[] };
  errors?: { message?: string }[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function one(id: string, revalidate: number): Promise<Reply | null> {
  return postJson<Reply>(
    `${GATEWAY}/${process.env.GRAPH_SUBGRAPH_KEY}/subgraphs/id/${id}`,
    { query: STANDARD_QUERY },
    // Next keys its fetch cache by URL and a POST body is invisible to it. Each
    // subgraph has its own URL here so that is safe, unlike the single-endpoint
    // case in lib/subgraph.ts, but the route caches its finished payload anyway.
    { revalidate, timeout: 30_000 }
  );
}

export async function readStandards(revalidate: number): Promise<Standards | null> {
  if (!process.env.GRAPH_SUBGRAPH_KEY) return null;

  const replies = await Promise.all(SUBGRAPHS.map((s) => one(s.id, revalidate)));
  const rows: StandardRow[] = SUBGRAPHS.map((s, i) => {
    const r = replies[i];
    if (!r) return { label: s.label, name: null, type: null, tvlUsd: null, revenueUsd: null, users: null, error: "No answer from the gateway." };
    if (r.errors?.length) return { label: s.label, name: null, type: null, tvlUsd: null, revenueUsd: null, users: null, error: String(r.errors[0]?.message ?? "Query rejected.").slice(0, 140) };
    const p = r.data?.protocols?.[0];
    if (!p) return { label: s.label, name: null, type: null, tvlUsd: null, revenueUsd: null, users: null, error: "The schema answered but held no protocol row." };
    return {
      label: s.label,
      name: p.name ?? null,
      type: p.type ?? null,
      tvlUsd: num(p.totalValueLockedUSD),
      revenueUsd: num(p.cumulativeSupplySideRevenueUSD),
      users: num(p.cumulativeUniqueUsers),
    };
  });

  const bespokeReply = await one(BESPOKE.id, revalidate);
  const bespoke = {
    label: BESPOKE.label,
    error: bespokeReply?.errors?.length
      ? String(bespokeReply.errors[0]?.message ?? "").slice(0, 140)
      : bespokeReply?.data?.protocols
        ? null
        : "No answer.",
  };

  return { query: STANDARD_QUERY, rows, bespoke, queries: SUBGRAPHS.length + 1 };
}

import "server-only";
import { postJsonWithHeaders } from "./http";

// One query, many protocols, because they share a schema.
//
// This is the part of The Graph that the rest of the terminal does not show.
// Every other on-chain read here is bespoke: the Uniswap v3 subgraph has its
// own entity names, so a query written for it is worth nothing anywhere else,
// and adding a second venue means reading a second schema and writing a second
// query and a second mapping.
//
// A standardized subgraph removes that. Messari's schema gives lending markets,
// DEXes and staking protocols the same entities, so the query below is sent
// unchanged to nine of them and every one answers it. Adding a tenth is one
// line: an id.
//
// The schema's own categories come back as LENDING, EXCHANGE and GENERIC, which
// is not how every protocol would describe itself. That is the point rather
// than a flaw: a shared vocabulary is only shared if it overrides the local
// one.
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
  financialsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
    timestamp
    dailyTotalRevenueUSD
    dailyProtocolSideRevenueUSD
  }
}`;

/**
 * Messari standardized subgraphs on the decentralised network.
 *
 * Ids rather than names, because a name is not addressable. Deliberately not all
 * of one kind: the point is not that nine lending markets answer one query, it
 * is that a lending market, a DEX and a staking protocol all do.
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

/**
 * What the gateway's `graph-attestation` header carries.
 *
 * An ECDSA signature by the indexer that served the query, over the hash of the
 * request and the hash of the response. It is the one thing on this page that
 * cannot be authored by us: a reader who doubts the numbers came from The Graph
 * can check that the signature covers the response they were shown.
 */
export interface Attestation {
  /** Hash of the query that was sent. */
  requestCID: string;
  /** Hash of the answer that came back. */
  responseCID: string;
  /** Which deployment answered. */
  subgraphDeploymentID: string;
  /** The signature itself. */
  r: string;
  s: string;
  v: number;
}

export interface StandardRow {
  label: string;
  /** The protocol's own name, from the shared schema rather than from us. */
  name: string | null;
  /** Messari's category: LENDING, EXCHANGE, YIELD and so on. */
  type: string | null;
  tvlUsd: number | null;
  revenueUsd: number | null;
  users: number | null;
  /** Seven days of fees, summed from the shared daily snapshot entity. */
  revenue7dUsd: number | null;
  /** The share of those fees the protocol kept rather than paid out. */
  protocolSide7dUsd: number | null;
  /** Unix seconds of the newest snapshot, so a stale subgraph is visible. */
  asOf: number | null;
  /**
   * The share of the week's fees the protocol kept, as a percentage, or null
   * where the ratio would not mean anything. Decided here rather than at each
   * reader, so the panel and the assistant can never disagree about it.
   */
  takePct: number | null;
  /** How long this subgraph's indexer has been stopped, or null while current. */
  staleDays: number | null;
  /**
   * The indexer's signature over this exact answer, when the gateway supplies
   * one. Proof the row came off the network rather than out of a file here.
   */
  attestation: Attestation | null;
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
  data?: {
    protocols?: { name?: string; type?: string; totalValueLockedUSD?: string; cumulativeSupplySideRevenueUSD?: string; cumulativeUniqueUsers?: number }[];
    financialsDailySnapshots?: { timestamp?: string; dailyTotalRevenueUSD?: string; dailyProtocolSideRevenueUSD?: string }[];
  };
  errors?: { message?: string }[];
}

/** A row that answered nothing, so every failure shape stays one shape. */
const blank = (label: string): StandardRow => ({
  label, name: null, type: null, tvlUsd: null, revenueUsd: null, users: null,
  revenue7dUsd: null, protocolSide7dUsd: null, asOf: null, takePct: null, staleDays: null,
  attestation: null,
});

/**
 * A subgraph is stale when its newest snapshot is older than this. Three days
 * of slack, because a healthy indexer is hours behind and an abandoned one is
 * years behind; there is nothing in between to get wrong.
 */
const STALE_DAYS = 3;

/**
 * Below this much in weekly fees, the take rate is withheld rather than
 * reported.
 *
 * The ratio is only a statement about a business while there is a business.
 * Compound v2 earned about ten thousand dollars last week and kept all of it,
 * and left unguarded that renders as a 100% take rate standing above
 * MakerDAO's 88%, which invites exactly the wrong conclusion: asked which
 * protocol keeps the biggest share, the honest answer is the one with the
 * largest cut of real revenue, not the one with the smallest denominator.
 * Fifty thousand a week is roughly seven thousand a day, which is low enough
 * to keep every protocol here that is still operating and high enough to drop
 * the ones that have wound down.
 */
const MIN_WEEKLY_FEES_FOR_TAKE = 50_000;

/**
 * Above this, a cumulative figure is not a number about this world.
 *
 * Curve's subgraph reports cumulativeSupplySideRevenueUSD as 1.88e20, which is
 * 188 quintillion dollars: thirty-nine billion times its own TVL, and several
 * times the value of everything humans own. Aave v3's cumulativeTotalRevenueUSD
 * has the same shape at 2.8e14. Both are mapping bugs upstream rather than
 * readings, and neither is ours to correct, but printing one on a panel whose
 * whole argument is that these figures are comparable would undo the argument.
 *
 * A trillion dollars is the bound because the entire crypto market is a few
 * trillion, so no single protocol has earned a trillion in fees since
 * inception. Anything above it is a broken mapping, and the panel says the
 * figure is unavailable rather than repeating it.
 */
const MAX_PLAUSIBLE_CUMULATIVE_USD = 1e12;

/** A figure the schema reports that the world cannot support. */
function plausible(v: number | null): number | null {
  return v != null && Math.abs(v) < MAX_PLAUSIBLE_CUMULATIVE_USD ? v : null;
}

/** The signature the gateway attached, where it attached one. */
function readAttestation(headers: Record<string, string> | undefined): Attestation | null {
  const raw = headers?.["graph-attestation"];
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Partial<Attestation>;
    return a.requestCID && a.responseCID && a.subgraphDeploymentID && a.r && a.s
      ? {
          requestCID: a.requestCID,
          responseCID: a.responseCID,
          subgraphDeploymentID: a.subgraphDeploymentID,
          r: a.r,
          s: a.s,
          v: Number(a.v ?? 0),
        }
      : null;
  } catch {
    // A header we cannot parse is not worth failing a desk over.
    return null;
  }
}

/** The protocol's own cut, where the figures support saying one. */
function takePct(row: { revenue7dUsd: number | null; protocolSide7dUsd: number | null; asOf: number | null }): number | null {
  if (staleDays(row.asOf) !== null) return null;
  const { revenue7dUsd: total, protocolSide7dUsd: kept } = row;
  if (total == null || kept == null || total < MIN_WEEKLY_FEES_FOR_TAKE) return null;
  return (kept / total) * 100;
}

/**
 * How far behind a subgraph's last snapshot is, once that is far enough to
 * matter, and null while it is current.
 *
 * A standardized schema makes every row comparable. It does not promise every
 * indexer is still running, and an abandoned one still answers: Euler's
 * stopped in 2022 and its newest seven snapshots still sum into a
 * plausible-looking week.
 */
function staleDays(asOf: number | null): number | null {
  if (!asOf) return null;
  const days = Math.floor(Date.now() / 1000 / 86_400 - asOf / 86_400);
  return days > STALE_DAYS ? days : null;
}

const sum = (rows: { [k: string]: string | undefined }[], field: string): number | null => {
  if (!rows.length) return null;
  let t = 0;
  for (const r of rows) {
    const n = Number(r[field]);
    if (Number.isFinite(n)) t += n;
  }
  return t;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function one(id: string, revalidate: number): Promise<{ body: Reply; headers: Record<string, string> } | null> {
  return postJsonWithHeaders<Reply>(
    `${GATEWAY}/${process.env.GRAPH_SUBGRAPH_KEY}/subgraphs/id/${id}`,
    { query: STANDARD_QUERY },
    ["graph-attestation"],
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
    const reply = replies[i];
    if (!reply) return { ...blank(s.label), error: "No answer from the gateway." };
    const r = reply.body;
    // Kept even on a failed row: the signature says the gateway answered, which
    // is a different fact from whether the schema had what we asked for.
    const attestation = readAttestation(reply.headers);
    if (r.errors?.length)
      return { ...blank(s.label), attestation, error: String(r.errors[0]?.message ?? "Query rejected.").slice(0, 140) };
    const p = r.data?.protocols?.[0];
    if (!p) return { ...blank(s.label), attestation, error: "The schema answered but held no protocol row." };
    const snaps = r.data?.financialsDailySnapshots ?? [];
    const week = {
      revenue7dUsd: sum(snaps, "dailyTotalRevenueUSD"),
      protocolSide7dUsd: sum(snaps, "dailyProtocolSideRevenueUSD"),
      asOf: num(snaps[0]?.timestamp),
    };
    return {
      label: s.label,
      ...week,
      takePct: takePct(week),
      staleDays: staleDays(week.asOf),
      attestation,
      name: p.name ?? null,
      type: p.type ?? null,
      tvlUsd: plausible(num(p.totalValueLockedUSD)),
      revenueUsd: plausible(num(p.cumulativeSupplySideRevenueUSD)),
      users: num(p.cumulativeUniqueUsers),
    };
  });

  const bespokeReply = await one(BESPOKE.id, revalidate);
  const bespokeBody = bespokeReply?.body;
  const bespoke = {
    label: BESPOKE.label,
    error: bespokeBody?.errors?.length
      ? String(bespokeBody.errors[0]?.message ?? "").slice(0, 140)
      : bespokeBody?.data?.protocols
        ? null
        : "No answer.",
  };

  return { query: STANDARD_QUERY, rows, bespoke, queries: SUBGRAPHS.length + 1 };
}

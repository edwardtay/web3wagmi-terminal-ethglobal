import "server-only";

// One place for every upstream call. Server-side only: the browser never talks
// to an exchange or an aggregator directly (see the CSP in next.config.ts), so
// no key ever reaches the client and one cache policy covers the whole app.

export interface GetJsonOptions {
  /** Seconds of edge cache. Default 60. Use 0 to always hit the upstream. */
  revalidate?: number;
  /** Abort after this many ms. Default 9000. */
  timeout?: number;
  headers?: Record<string, string>;
  /**
   * Hold the parsed result in process for `revalidate` seconds.
   * Next's fetch cache silently refuses anything over 2MB, and several
   * upstreams here are far past that (the Binance 24h board is ~2.5MB and is
   * read by seven routes). Without this each route refetches and reparses it.
   */
  memo?: boolean;
}

const UA = "Web3WAGMI-Terminal/1.0 (+https://terminal.web3wagmi.com)";

// Small in-process cache for the oversized upstreams. Bounded, because these
// payloads are megabytes and the container is not.
const MEMO_MAX = 12;
const memoStore = new Map<string, { at: number; ttl: number; value: unknown }>();
/** Reads currently in flight, keyed by URL, so concurrent misses share one fetch. */
const inflightStore = new Map<string, Promise<unknown | null>>();

// `maxAgeSec` is the freshness the current caller asked for. The same upstream
// is read by routes with TTLs from 30s to 900s, so expiring only against the
// writer's TTL would serve a 30s route data frozen for 15 minutes.
function memoGet(key: string, maxAgeSec: number): unknown | undefined {
  const hit = memoStore.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > Math.min(hit.ttl, maxAgeSec) * 1000) {
    memoStore.delete(key);
    return undefined;
  }
  // Refresh insertion order so the eviction below is least-recently-used.
  memoStore.delete(key);
  memoStore.set(key, hit);
  return hit.value;
}

function memoSet(key: string, value: unknown, ttl: number): void {
  memoStore.set(key, { at: Date.now(), ttl, value });
  while (memoStore.size > MEMO_MAX) {
    const oldest = memoStore.keys().next().value;
    if (oldest === undefined) break;
    memoStore.delete(oldest);
  }
}

/**
 * Fetch JSON, returning null on any failure (non-2xx, timeout, bad JSON).
 * Callers degrade a panel rather than failing the page: a terminal with one
 * dead upstream should still render every other panel.
 */
export async function getJson<T>(url: string, opts: GetJsonOptions = {}): Promise<T | null> {
  const { revalidate = 60, timeout = 9000, headers, memo = false } = opts;

  if (memo) {
    const hit = memoGet(url, revalidate);
    if (hit !== undefined) return hit as T;
    // Join a read already in progress. Without this, several routes waking at
    // the same moment each fetch and parse the same multi-megabyte payload
    // before the first one gets to populate the memo.
    const running = inflightStore.get(url);
    if (running) return (await running) as T | null;
  }

  const work = (async (): Promise<T | null> => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeout),
        ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
      });
      if (!res.ok) return null;
      const parsed = (await res.json()) as T;
      if (memo && revalidate > 0) memoSet(url, parsed, revalidate);
      return parsed;
    } catch {
      return null;
    }
  })();

  if (!memo) return work;

  inflightStore.set(url, work as Promise<unknown | null>);
  try {
    return await work;
  } finally {
    inflightStore.delete(url);
  }
}

/** POST JSON (Hyperliquid's info endpoint and JSON-RPC nodes need it). */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: GetJsonOptions = {}
): Promise<T | null> {
  const { revalidate = 60, timeout = 9000, headers } = opts;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      ...(revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" as const }),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Settle every promise, dropping the failures. Order is not preserved. */
export async function allOk<T>(jobs: Promise<T | null>[]): Promise<T[]> {
  const settled = await Promise.allSettled(jobs);
  const out: T[] = [];
  for (const s of settled) if (s.status === "fulfilled" && s.value != null) out.push(s.value);
  return out;
}

/** Standard JSON response for an API route, with a matching CDN cache hint. */
export function jsonResponse(data: unknown, seconds = 60): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
    },
  });
}

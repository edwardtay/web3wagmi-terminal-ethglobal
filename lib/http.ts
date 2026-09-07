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
/**
 * Why the last reads failed, tallied by reason.
 *
 * Every failure here returns null, which is the right contract for a caller
 * that must degrade rather than throw, and it is also why a desk producing four
 * series of fifty six was impossible to diagnose from outside: null is the same
 * answer for a timeout, a 500, a refused connection and an empty result.
 *
 * A bounded tally rather than a log, so it costs nothing to leave on and cannot
 * grow. Keyed by reason and by the path that produced it, never the query
 * string, which is where the API key would be if it were ever in one.
 */
const failures = new Map<string, number>();

function noteFailure(url: string, reason: string) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // A malformed URL is itself worth seeing, so keep whatever was passed.
  }
  const key = `${path} ${reason}`.slice(0, 160);
  failures.set(key, (failures.get(key) ?? 0) + 1);
  // Bounded. The interesting failures are the repeated ones.
  if (failures.size > 40) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
}

/** The recorded failures, worst first. */
export function failureReport(limit = 6): { reason: string; count: number }[] {
  return [...failures.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Called before a read whose failures should be attributed to it alone. */
export function clearFailures() {
  failures.clear();
}

/**
 * When an upstream last said 429.
 *
 * Worth knowing separately from any other failure, because it is the one where
 * trying again is the wrong response. A timeout might be bad luck. A rate limit
 * is the upstream saying the caller is asking too fast, and a retry is another
 * request against the thing that just refused one.
 */
let lastRateLimitAt = 0;

export function rateLimitedRecently(withinMs = 60_000): boolean {
  return lastRateLimitAt > 0 && Date.now() - lastRateLimitAt < withinMs;
}

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
      if (!res.ok) {
        if (res.status === 429) lastRateLimitAt = Date.now();
        noteFailure(url, `HTTP ${res.status}`);
        return null;
      }
      const parsed = (await res.json()) as T;
      if (memo && revalidate > 0) memoSet(url, parsed, revalidate);
      return parsed;
    } catch (e) {
      // undici reports every transport failure as the same bare "fetch failed",
      // so the cause carries the only part that distinguishes a DNS miss from a
      // refused connection from a socket hung up mid-response.
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      noteFailure(url, e instanceof Error ? `${e.name}: ${e.message}${cause}` : "unknown");
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

"use client";

import useSWR, { mutate } from "swr";

// Every client panel polls its own /api route through this hook, so refresh
// cadence, error handling and the loading contract are identical everywhere.

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

// Refetch everything when the page comes back from the browser's back/forward
// cache.
//
// SWR revalidates on focus, which covers a tab being switched back to. It does
// not cover a bfcache restore: an iOS reader who leaves the terminal and comes
// back through the back gesture gets the whole page reinstated from memory,
// timers and all, and `visibilitychange` does not reliably fire. The panels
// then show whatever they held when the page was frozen, with the as-of stamps
// to prove it, until each one's own interval next comes round. On a desk with
// a fifteen minute cadence that is a long time to read stale numbers.
//
// `pageshow` with `persisted` is the one event that always fires on that path.
// Registered once at module scope rather than per hook, so twenty panels do not
// install twenty listeners.
if (typeof window !== "undefined") {
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) void mutate(() => true);
  });
}

export interface ApiState<T> {
  data: T | undefined;
  loading: boolean;
  failed: boolean;
}

/**
 * @param url        the /api route to poll
 * @param seconds    refresh interval; 0 disables polling
 */
export function useApi<T>(url: string | null, seconds = 60): ApiState<T> {
  const { data, error, isLoading } = useSWR<T>(url, fetcher, {
    refreshInterval: seconds * 1000,
    revalidateOnFocus: true,
    keepPreviousData: true,
    errorRetryCount: 2,
  });
  return { data, loading: isLoading && data === undefined, failed: Boolean(error) && data === undefined };
}

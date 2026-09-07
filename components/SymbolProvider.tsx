"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SymbolContext } from "@/lib/useSymbol";
import { SYMBOL_PARAM, normaliseSymbol } from "@/lib/symbolParam";

// Holds the selected instrument and mirrors it into the URL. The URL is written
// with replaceState rather than a router push: changing the selection is not a
// navigation, and pushing would fill the back button with symbol changes.

export function SymbolProvider({
  children,
  initial = "BTC",
}: {
  children: React.ReactNode;
  /**
   * Resolved on the server from the query string, so a shared ?s=SOL link paints
   * SOL on the first frame instead of rendering BTC and flipping after hydration.
   */
  initial?: string;
}) {
  const [symbol, setSymbolState] = useState(initial);

  // A client-side navigation can change the query without remounting, so the
  // server-resolved value is re-applied when it changes.
  useEffect(() => {
    const clean = normaliseSymbol(initial);
    if (clean) setSymbolState(clean);
  }, [initial]);

  // Keep the browser's back and forward buttons meaningful for pasted links.
  useEffect(() => {
    function onPop() {
      const fromUrl = normaliseSymbol(new URLSearchParams(window.location.search).get(SYMBOL_PARAM));
      if (fromUrl) setSymbolState(fromUrl);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setSymbol = useCallback((next: string) => {
    const clean = normaliseSymbol(next);
    if (!clean) return;
    setSymbolState(clean);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(SYMBOL_PARAM, clean);
      window.history.replaceState(null, "", url);
    } catch {
      /* a blocked history write should not stop the selection from applying */
    }
  }, []);

  const value = useMemo(() => ({ symbol, setSymbol }), [symbol, setSymbol]);

  return <SymbolContext.Provider value={value}>{children}</SymbolContext.Provider>;
}

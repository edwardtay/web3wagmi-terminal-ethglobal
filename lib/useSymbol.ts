"use client";

import { createContext, useContext } from "react";

// One selected instrument drives the chart, the order flow panels, the options
// desk and the row highlight in every ranked table. Without this, a trader
// picking SOL has to re-pick it in each panel, which is the fastest way to make
// a terminal feel like a set of unrelated widgets.
//
// The choice lives in the URL (?s=SOL) so a view can be pasted to someone else.

export interface SymbolState {
  symbol: string;
  setSymbol: (sym: string) => void;
}

export const SymbolContext = createContext<SymbolState>({
  symbol: "BTC",
  setSymbol: () => {},
});

export function useSymbol(): SymbolState {
  return useContext(SymbolContext);
}

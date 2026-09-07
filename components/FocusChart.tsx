"use client";

import { CandleChart } from "./CandleChart";
import { useSymbol } from "@/lib/useSymbol";

// Bridges the shared selection into the chart, which is otherwise reusable on
// the per-symbol pages where the selection does not apply.

export function FocusChart() {
  const { symbol, setSymbol } = useSymbol();
  return <CandleChart symbol={symbol} onSymbolChange={setSymbol} />;
}

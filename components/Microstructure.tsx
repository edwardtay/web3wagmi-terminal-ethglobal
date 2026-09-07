"use client";

import { OrderBook } from "./OrderBook";
import { DepthChart } from "./DepthChart";
import { TradeTape } from "./TradeTape";
import { Section } from "./ui";
import { useSymbol } from "@/lib/useSymbol";

// The three microstructure panels read one book, and that book follows the
// terminal's shared selection rather than a selector of its own, so picking an
// instrument once moves the chart and these three together.


export function Microstructure() {
  const { symbol } = useSymbol();

  return (
    <Section
      title="Order flow"
      id="microstructure"
      right={
        <span className="font-mono text-[11px] font-semibold text-[var(--text2)]">
          {symbol}/USDT
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <OrderBook symbol={symbol} />
        <DepthChart symbol={symbol} />
        <TradeTape symbol={symbol} />
      </div>
    </Section>
  );
}

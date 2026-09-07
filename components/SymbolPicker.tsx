"use client";

import { ASSETS } from "@/lib/symbols";
import { useSymbol } from "@/lib/useSymbol";

// The single instrument selector, in the header so it reads as global state
// rather than one panel's control.

export function SymbolPicker() {
  const { symbol, setSymbol } = useSymbol();

  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Selected instrument</span>
      <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text3)] lg:inline">
        focus
      </span>
      <select
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        aria-label="Selected instrument, drives the chart, order flow and options panels"
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs font-bold text-[var(--text)] hover:border-[var(--accent)]"
      >
        {ASSETS.map((a) => (
          <option key={a.sym} value={a.sym}>
            {a.sym}
          </option>
        ))}
      </select>
    </label>
  );
}

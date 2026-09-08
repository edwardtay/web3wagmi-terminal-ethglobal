"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ASSETS } from "@/lib/symbols";
import { useSymbol } from "@/lib/useSymbol";
import { TokenIcon } from "./ui";

// The single instrument selector, in the header so it reads as global state
// rather than one panel's control.
//
// Built rather than a native select, for one reason that only shows up on a
// phone. A select with twenty seven options opens as a full screen modal wheel
// on iOS and a full width sheet on Android, both of which hide the terminal
// entirely and show nothing but tickers: no mark, no name, no sector. Choosing
// an instrument is the one interaction that should keep the numbers it changes
// in view.
//
// So the list carries the mark and the full asset name as well as the ticker,
// and it groups by sector, which is the ordering a reader already has in their
// head. Twenty seven is past the point where scanning beats typing, so it
// filters too.
//
// Portaled to the body deliberately. The header carries backdrop-blur, and a
// backdrop-filter establishes a containing block for fixed position
// descendants, so a panel opened from inside it is trapped within the header.
// That is the same trap the alerts overlay hit.

export function SymbolPicker() {
  const { symbol, setSymbol } = useSymbol();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const matches = q
    ? ASSETS.filter((a) => a.sym.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : ASSETS;

  // Placed against the button, then pulled back inside the viewport. A phone is
  // narrow enough that a menu aligned to a control near the right edge would
  // otherwise open partly offscreen.
  const place = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setBox({ top: r.bottom + 6, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // Focus the filter rather than the list: typing is the fast path once the
    // list is longer than a screen, and arrow keys still work from here.
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  function choose(sym: string) {
    setSymbol(sym);
    setOpen(false);
    setQuery("");
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + matches.length) % Math.max(1, matches.length);
      });
      return;
    }
    if (e.key === "Enter" && matches[active]) {
      e.preventDefault();
      choose(matches[active].sym);
    }
  }

  const current = ASSETS.find((a) => a.sym === symbol);
  let lastSector: string | null = null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text3)] lg:inline">
        focus
      </span>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Focused instrument, ${current?.name ?? symbol}. Drives the chart, order flow and options panels.`}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs font-bold text-[var(--text)] hover:border-[var(--accent)]"
      >
        <TokenIcon sym={symbol} size={16} />
        <span>{symbol}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={popRef}
            role="listbox"
            aria-label="Instruments"
            onKeyDown={onKeyDown}
            style={{ position: "fixed", top: box.top, left: box.left, width: box.width }}
            className="z-[160] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
          >
            <div className="border-b border-[var(--border)] p-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by ticker or name"
                aria-label="Filter instruments"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text3)] focus:border-[var(--accent)]"
              />
            </div>

            <div className="thin-scroll max-h-[min(60vh,320px)] overflow-y-auto py-1">
              {matches.length === 0 && (
                <p className="px-3 py-3 font-mono text-[11px] text-[var(--text3)]">
                  Nothing matches {query}.
                </p>
              )}
              {matches.map((a, i) => {
                const header = !q && a.sector !== lastSector ? a.sector : null;
                lastSector = a.sector;
                const selected = a.sym === symbol;
                return (
                  <div key={a.sym}>
                    {header && (
                      <div className="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--text3)]">
                        {header}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(a.sym)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                        i === active ? "bg-[var(--surface2)]" : ""
                      }`}
                    >
                      <TokenIcon sym={a.sym} size={18} />
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-[12px] font-bold text-[var(--text)]">{a.sym}</span>{" "}
                        <span className="break-words text-[11px] text-[var(--text2)]">{a.name}</span>
                      </span>
                      {selected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" aria-hidden>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

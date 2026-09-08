"use client";

import { useEffect, useRef } from "react";

import { ThemeToggle } from "./ThemeToggle";
import { Alerts } from "./Alerts";
import { SECTION_GROUPS, useActiveSection } from "./SideNav";
import { SymbolPicker } from "./SymbolPicker";

// The terminal's own bar, below the two shared web3wagmi strips (44px each),
// hence top-[88px]. Holds the section wordmark and the three controls a
// terminal needs within reach: the focused instrument, search, alerts, theme.


export function TerminalHeader() {
  const active = useActiveSection();
  const stripRef = useRef<HTMLElement>(null);
  const activeChipRef = useRef<HTMLAnchorElement>(null);

  // Keep the marked chip in view, scrolling the strip and never the page. The
  // reader is already scrolling the page; taking that away from them to show a
  // chip would be the navigation fighting the thing it is describing.
  useEffect(() => {
    const chip = activeChipRef.current;
    const strip = stripRef.current;
    if (!chip || !strip) return;
    const left = chip.offsetLeft - strip.clientWidth / 2 + chip.clientWidth / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [active]);

  return (
    <header className="sticky top-[88px] z-40 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md">
      <div className="shell flex items-center gap-3 py-2">
        <a href="/" className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap font-display text-[22px] font-bold leading-none tracking-tight">
            <span className="accent-grad">Terminal</span>
          </span>
        </a>

        {/* The search takes the space between the brand and the controls, which
            was empty. It is the only element in this bar that wants width: a
            symbol picker and three links do not, and reading as a bar rather
            than a button also says it accepts a question, which it does. */}
        <button
          onClick={() =>
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))
          }
          aria-label="Open the command menu"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-left text-xs font-medium text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="min-w-0 flex-1">
            <span className="hidden sm:inline">Ask a question, or jump to a panel or symbol</span>
            <span className="sm:hidden">Search</span>
          </span>
          <kbd className="hidden shrink-0 rounded border border-[var(--border)] bg-[var(--bg2)] px-1 font-mono text-[10px] sm:inline">
            &#8984;K
          </kbd>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <SymbolPicker />
          <a
            href="/methodology"
            className="hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text2)] hover:border-[var(--accent)] hover:text-[var(--text)] lg:block"
          >
            Methodology
          </a>
          <a
            href="/status"
            className="hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text2)] hover:border-[var(--accent)] hover:text-[var(--text)] sm:block"
          >
            Status
          </a>
          <Alerts />
          <ThemeToggle />
        </div>
      </div>

      {/* Section strip. The left rail only exists from xl up, so below that this
          is the only way to move between thirty panels without scrolling past
          all of them. Scrolls horizontally rather than wrapping to three rows.
          It marks where the reader is, which it did not before: a strip of
          links tells you where you can go, and the highlight is the half that
          says where you already are. */}
      <nav
        ref={stripRef}
        className="thin-scroll flex items-center gap-1 overflow-x-auto border-t border-[var(--border2)] px-4 py-1.5 xl:hidden"
        aria-label="Sections"
      >
        {SECTION_GROUPS.flatMap((g) => g.items).map((i) => {
          const on = active === i.id;
          return (
            <a
              key={i.id}
              ref={on ? activeChipRef : undefined}
              href={`#${i.id}`}
              aria-current={on ? "true" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                on
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
              }`}
            >
              {i.label}
            </a>
          );
        })}
      </nav>
    </header>
  );
}

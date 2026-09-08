"use client";

import { useEffect, useRef } from "react";
import { SECTION_GROUPS, useActiveSection } from "./SideNav";

// The section rail, for screens too narrow to carry one down the side.
//
// The desktop rail is xl and up, so a phone had no section tracking at all:
// every panel scrolled past under one header that never said where you were,
// on the longest version of the page. Losing your place matters more on the
// small screen, not less.
//
// A horizontal strip rather than a menu, because it has two jobs and a menu
// only does one. Tapping a chip jumps to a section, and the chip that scrolls
// itself into view answers where you already are without being asked.

const ITEMS = SECTION_GROUPS.flatMap((g) => g.items);

export function SectionBar() {
  const active = useActiveSection();
  const barRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const chip = activeRef.current;
    const bar = barRef.current;
    if (!chip || !bar) return;
    // Only the strip scrolls. scrollIntoView would take the page with it and
    // fight the reader for the scroll position they are already using.
    const left = chip.offsetLeft - bar.clientWidth / 2 + chip.clientWidth / 2;
    bar.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [active]);

  return (
    <nav
      aria-label="Sections"
      // Pinned under the terminal header, which is itself pinned at 88px below
      // the network bar. A section rail that scrolls away is a table of
      // contents; one that stays is a position indicator, which is the job.
      className="sticky top-[140px] z-30 border-b border-[var(--border)] bg-[var(--bg)] xl:hidden"
    >
      <div
        ref={barRef}
        className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-2"
        style={{ scrollbarWidth: "none" }}
      >
        {ITEMS.map((i) => {
          const on = active === i.id;
          return (
            <a
              key={i.id}
              ref={on ? activeRef : undefined}
              href={`#${i.id}`}
              aria-current={on ? "true" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] ${
                on
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] font-bold text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text3)]"
              }`}
            >
              {i.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

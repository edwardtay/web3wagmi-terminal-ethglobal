"use client";

import { useEffect, useState } from "react";

// Desktop-only section rail. The page is long enough that a reader loses their
// place, so the rail tracks which section is on screen. Below xl it is hidden
// and the horizontal strip in TerminalHeader carries navigation instead, since
// a fixed side column would eat most of a 360px viewport.

// Exported so the mobile strip in TerminalHeader lists exactly the same
// sections. One source, so the two navigations cannot drift apart.
export const SECTION_GROUPS: { label: string; items: { id: string; label: string }[] }[] = [
  {
    label: "Glance",
    items: [
      { id: "signals", label: "What changed" },
      { id: "snapshot", label: "Snapshot" },
    ],
  },
  // The focused instrument gets its own group because it is the one part of
  // the page the focus control changes. Splitting these across Glance, Tape and
  // Derivatives is what made the control look inert: nothing in the nav said
  // which sections answered to it.
  {
    label: "Focused instrument",
    items: [
      { id: "focus", label: "Chart and context" },
      { id: "microstructure", label: "Order flow" },
      { id: "options", label: "Options" },
    ],
  },
  {
    label: "Market wide",
    items: [
      { id: "live", label: "Live board" },
      { id: "stress", label: "Stress index" },
    ],
  },
  {
    label: "Derivatives",
    items: [
      { id: "funding", label: "Funding" },
      { id: "oi", label: "Open interest" },
      { id: "liquidations", label: "Liquidations" },
    ],
  },
  {
    label: "On-chain",
    items: [
      { id: "netflow", label: "Exchange flow" },
      { id: "dex", label: "DEX pools" },
      { id: "chains", label: "Chains" },
      { id: "protocols", label: "Protocols" },
      { id: "stablecoins", label: "Stablecoins" },
      { id: "yields", label: "Yields" },
      { id: "gas", label: "Gas" },
      { id: "unlocks", label: "Unlocks" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { id: "returns", label: "Returns" },
      { id: "risk", label: "Risk" },
      { id: "correlation", label: "Correlation" },
      { id: "breadth", label: "Breadth" },
      { id: "rotation", label: "Rotation" },
      { id: "screener", label: "Screener" },
    ],
  },
];

const IDS = SECTION_GROUPS.flatMap((g) => g.items.map((i) => i.id));

export function SideNav() {
  const active = useActiveSection();
  return <DesktopRail active={active} />;
}

/** How much sticky furniture sits above the content, right now. */
function chromeHeight(): number {
  if (typeof document === "undefined") return 150;
  const header = document.querySelector("header");
  const bar = document.querySelector('nav[aria-label="Sections"]');
  const bottom = header?.getBoundingClientRect().bottom ?? 0;
  const barH = bar?.getBoundingClientRect().height ?? 0;
  // A floor, because at a scroll position where the header has been pushed up
  // the measurement understates what will cover the content once it settles.
  return Math.max(150, Math.round(bottom + barH));
}

/**
 * Which section is on screen.
 *
 * Extracted so the mobile bar and the desktop rail cannot disagree about it.
 * They did not disagree before only because the mobile bar did not exist: the
 * rail is xl and up, so a phone had no section tracking at all, which is the
 * screen where losing your place in a page this long matters most.
 */
export function useActiveSection(): string {
  const [active, setActive] = useState<string>("snapshot");

  useEffect(() => {
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        // The section occupying the most of the viewport wins, which keeps the
        // highlight stable while a tall panel scrolls past.
        let best = "";
        let bestRatio = 0;
        for (const id of IDS) {
          const r = seen.get(id) ?? 0;
          if (r > bestRatio) {
            bestRatio = r;
            best = id;
          }
        }
        if (best && bestRatio > 0) setActive(best);
      },
      // The top margin matches the stacked sticky chrome so a section counts as
      // on screen only once it clears it. Measured rather than hardcoded: the
      // chrome is a different height on a phone, which now carries a pinned
      // section bar the desktop does not, and a fixed 150px there marked a
      // section active while it was still behind the bar naming it.
      { rootMargin: `-${chromeHeight()}px 0px -40% 0px`, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );
    for (const id of IDS) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  return active;
}

function DesktopRail({ active }: { active: string }) {
  return (
    <nav
      aria-label="Terminal sections"
      className="thin-scroll sticky top-[140px] hidden max-h-[calc(100vh-160px)] w-44 shrink-0 overflow-y-auto pb-6 xl:block"
    >
      {SECTION_GROUPS.map((g) => (
        <div key={g.label} className="mb-4">
          <div className="mb-1 px-2 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--text3)]">
            {g.label}
          </div>
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const on = active === i.id;
              return (
                <li key={i.id}>
                  <a
                    href={`#${i.id}`}
                    aria-current={on ? "true" : undefined}
                    className={`block rounded-md border-l-2 px-2 py-1 text-[12px] font-semibold transition-colors ${
                      on
                        ? "border-[var(--accent2)] bg-[var(--accent-soft)] text-[var(--text)]"
                        : "border-transparent text-[var(--text3)] hover:bg-[var(--surface2)] hover:text-[var(--text2)]"
                    }`}
                  >
                    {i.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

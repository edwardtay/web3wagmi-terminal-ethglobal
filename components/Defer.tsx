"use client";

import { useEffect, useRef, useState } from "react";

// Hold a panel back until the reader is near it.
//
// Every panel fetches its own route on mount, and the home page carries about
// two dozen of them, so a first load fired seventeen requests at once and
// downloaded ~120KB of JSON before the reader had scrolled anywhere. Most of it
// is for panels far below the fold, and the single largest, the yield scanner,
// is a quarter of the total on its own. A desktop absorbs that. A phone on a
// mobile connection spends it all competing with the JavaScript it still has to
// parse, which is what makes the terminal feel slow there and nowhere else.
//
// The panel is deferred, never the section around it. The heading and its
// anchor id stay in the markup, so the side navigation still jumps correctly
// and nothing in the page outline depends on having scrolled past it.
//
// The margin is deliberately generous: the work should already be done by the
// time the panel is actually on screen, so this reads as a faster page rather
// than as a page that loads while you watch.
export function Defer({
  children,
  /** Roughly what the panel will occupy, so deferring does not jump the page. */
  minHeight = 220,
}: {
  children: React.ReactNode;
  minHeight?: number;
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show) return;
    const el = ref.current;
    if (!el) return;
    // Degrade to rendering everything rather than rendering nothing.
    if (typeof IntersectionObserver === "undefined") {
      setShow(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [show]);

  if (show) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} aria-hidden />;
}

"use client";

import { useEffect, useState } from "react";

/**
 * Whether the viewport is under a breakpoint, tracked live.
 *
 * Charts need this because the good shape on a desk is the wrong shape on a
 * phone, and neither scaling nor scrolling fixes it: scaling a wide chart down
 * makes its labels unreadable, and scrolling one sideways defeats the point of
 * a chart you are meant to take in at once.
 *
 * Starts false and corrects after mount, so the server and the first client
 * render agree. A chart that renders one shape on the server and another
 * immediately after is a hydration mismatch.
 */
export function useNarrow(px = 640): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [px]);
  return narrow;
}

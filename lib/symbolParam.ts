import { BY_SYM } from "./symbols";

// The selection's URL contract. Deliberately free of "use client" so the server
// component that reads searchParams can validate the value before handing it to
// the provider.

/** The URL parameter the selected instrument is mirrored to. */
export const SYMBOL_PARAM = "s";

/** Only a tracked symbol is accepted, so a hand-edited URL cannot break a panel. */
export function normaliseSymbol(input: string | null | undefined): string | null {
  if (!input) return null;
  const up = input.trim().toUpperCase();
  return BY_SYM[up] ? up : null;
}

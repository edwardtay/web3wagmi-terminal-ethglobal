// Display formatting shared by every panel, so a number reads the same
// wherever it appears. Pure functions, safe on both server and client.

/** 1_234_567 -> "1.23M". Handles negatives and sub-1 values. */
/**
 * The null glyph. One definition, and the sole place an em dash is allowed.
 *
 * It was written inline in a dozen components, which meant a rule saying "no em
 * dashes except this one" had thirteen exceptions and no way to enforce itself.
 */
export const NA = "\u2014";

export function compact(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return NA;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(digits)}K`;
  return `${sign}${abs.toFixed(digits)}`;
}

/** Compact USD, e.g. "$1.23B". */
export function usdCompact(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return `${n < 0 ? "-" : ""}$${compact(Math.abs(n), digits)}`;
}

/**
 * A crypto price with sensible decimals: big numbers get 2dp with grouping,
 * small ones keep enough significant digits that a memecoin does not read $0.00.
 */
export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NA;
  const abs = Math.abs(n);
  let dp: number;
  if (abs >= 1000) dp = 2;
  else if (abs >= 1) dp = 2;
  else if (abs >= 0.01) dp = 4;
  else if (abs >= 0.0001) dp = 6;
  else dp = 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** "$" prefixed price. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return `${n < 0 ? "-" : ""}$${price(Math.abs(n))}`;
}

/** Signed percent, e.g. "+1.42%". Input is already in percent units. */
export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** Unsigned percent, e.g. "62.1%". */
export function pctPlain(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return `${n.toFixed(digits)}%`;
}

/** Fixed-decimal number with thousands grouping. */
export function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Basis points, e.g. "12.5 bps". */
export function bps(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || !Number.isFinite(fraction)) return NA;
  return `${(fraction * 10_000).toFixed(digits)} bps`;
}

/** "3h 42m" style countdown from a millisecond delta. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NA;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Green above zero, red below, muted at zero. Use for inline text colour. */
export function signColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "var(--text3)";
  return n > 0 ? "var(--pos)" : "var(--neg)";
}

/** HH:MM:SS in the viewer's locale, for tapes and clocks. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

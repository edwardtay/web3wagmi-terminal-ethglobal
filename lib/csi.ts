// The Crypto Stress Index (CSI): our own 0-100 composite where higher means
// more financial stress in crypto. Six components, each sourced independently
// and each mapped to 0-100 by percentile rank against its OWN trailing history
// rather than an arbitrary min/max, so "80" always means "worse than 80% of the
// recent past" and the components stay comparable to each other.
//
// This file holds the definition and the maths only. It imports nothing
// server-side, so a client component can import the types from it safely.
// Fetching lives in app/api/stress/route.ts.

import { NA } from "./format";
import { correlation, logReturns, annualisedVol, percentileRank } from "./stats";

export type CsiId = "rvol" | "ivol" | "funding" | "peg" | "corr" | "dd";

/** A daily observation. `t` is a UTC-midnight timestamp in ms. */
export interface Pt {
  t: number;
  v: number;
}

export interface CsiSpec {
  id: CsiId;
  label: string;
  /** Column label in the breakdown table, kept short. */
  short: string;
  /** Weight in the composite before any dead component is dropped. */
  weight: number;
  /** Trailing window, in days, that the raw value is percentile-ranked against. */
  window: number;
  unit: string;
  source: string;
  hint: string;
}

/**
 * Weights are explicit and stated in the UI. Volatility carries the most because
 * it is the most direct read on risk; the four cross-checks (funding, peg,
 * correlation, drawdown) are equal-weighted so no single one can drive the
 * index on its own.
 */
export const CSI_SPECS: readonly CsiSpec[] = [
  {
    id: "rvol",
    label: "Realised volatility",
    short: "Realised vol",
    weight: 0.22,
    window: 365,
    unit: "% ann.",
    source: "Binance daily klines",
    hint: "Average of BTC and ETH 30-day realised volatility, annualised (sqrt-365, crypto trades every day). Ranked against the last 365 days of the same measure.",
  },
  {
    id: "ivol",
    label: "Implied volatility",
    short: "Implied vol",
    weight: 0.18,
    window: 180,
    unit: "DVOL",
    source: "Deribit DVOL (BTC)",
    hint: "Deribit's BTC DVOL index: the 30-day forward volatility the options market is pricing. This is what hedging costs, so it moves before realised vol does. Ranked against its own last 180 days.",
  },
  {
    id: "funding",
    label: "Funding dislocation",
    short: "Funding",
    weight: 0.15,
    window: 180,
    unit: "% ann. |median|",
    source: "Binance USDT-M perps",
    hint: "Perpetual futures charge a funding payment between longs and shorts to hold the contract near spot. We take the absolute annualised rate on each tracked USDT-margined perp and then the median of those: extreme funding in either direction means one side is crowded, which is a stress condition whichever way it points. Taking the median before the absolute would cancel a split market, where half the universe is crowded long against half crowded short.",
  },
  {
    id: "peg",
    label: "Stablecoin peg deviation",
    short: "Peg",
    weight: 0.15,
    window: 180,
    unit: "bps from $1",
    source: "DefiLlama stablecoins",
    hint: "Supply-weighted absolute distance from $1.00 across the major dollar stablecoins, in basis points. Yield-bearing tokenised treasuries are excluded because they trade above $1 by design. A real depeg is the cleanest stress signal in crypto, so this component moves rarely and hard.",
  },
  {
    id: "corr",
    label: "Cross-asset correlation",
    short: "Correlation",
    weight: 0.15,
    window: 365,
    unit: "avg pairwise r",
    source: "Binance daily klines",
    hint: "Average pairwise 30-day correlation of daily log returns across the nine matrix majors. Correlations converging on 1.0 means diversification has stopped working, which is what a risk-off event looks like from the inside.",
  },
  {
    id: "dd",
    label: "Bitcoin drawdown",
    short: "Drawdown",
    weight: 0.15,
    window: 365,
    unit: "% below 365d high",
    source: "Binance daily klines",
    hint: "How far BTC sits below its highest daily close of the last 365 days. Ranked against the last 365 days of that same distance.",
  },
] as const;

export const CSI_BY_ID: Record<CsiId, CsiSpec> = Object.fromEntries(
  CSI_SPECS.map((s) => [s.id, s])
) as Record<CsiId, CsiSpec>;

/** Days of composite history returned. Also the window the headline is ranked against. */
export const CSI_HISTORY_DAYS = 365;
/** Days shown in the sparkline. */
export const CSI_SPARK_DAYS = 90;
/** A component whose newest observation is older than this is treated as dead. */
export const CSI_MAX_STALE_DAYS = 4;

/* ------------------------------------------------------------ band labels -- */

export interface CsiBand {
  label: string;
  color: string;
  range: string;
}

/**
 * Five bands on the 0-100 scale. Because every component is a percentile against
 * its own trailing history, the cut points are the natural quintiles rather than
 * tuned levels, and the labels are RELATIVE readings. "extreme" means high
 * against the lookback, not high against all of market history. A long stressed
 * regime gradually normalises its own score, which is a property of any
 * percentile construction and is stated in the panel.
 */
export function csiBand(score: number): CsiBand {
  if (!Number.isFinite(score)) return { label: "unknown", color: "var(--text3)", range: NA };
  if (score < 20) return { label: "calm", color: "var(--pos)", range: "0-20" };
  if (score < 40) return { label: "normal", color: "var(--cyan)", range: "20-40" };
  if (score < 60) return { label: "elevated", color: "var(--gold)", range: "40-60" };
  if (score < 80) return { label: "stressed", color: "var(--neg)", range: "60-80" };
  return { label: "extreme", color: "var(--violet)", range: "80-100" };
}

/* ------------------------------------------------------------ series utils -- */

const DAY = 86_400_000;

/** Snap a timestamp to its UTC midnight, the key every series is joined on. */
export function dayKey(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

/** Collapse to one observation per UTC day (the last one wins), ascending. */
export function toDaily(pts: Pt[]): Pt[] {
  const m = new Map<number, number>();
  for (const p of pts) {
    if (Number.isFinite(p.v) && Number.isFinite(p.t)) m.set(dayKey(p.t), p.v);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

/**
 * Percentile rank of every point against the `window` days that end at it.
 * Points without a full window are dropped: a percentile computed off twenty
 * observations is not a percentile.
 */
export function rollingPercentile(daily: Pt[], window: number): Pt[] {
  const out: Pt[] = [];
  for (let i = window - 1; i < daily.length; i++) {
    const slice = daily.slice(i - window + 1, i + 1).map((p) => p.v);
    const r = percentileRank(slice, daily[i].v);
    if (Number.isFinite(r)) out.push({ t: daily[i].t, v: r });
  }
  return out;
}

/** Rolling annualised realised volatility, in percent, from a daily close series. */
export function rollingVol(closes: Pt[], win = 30): Pt[] {
  const out: Pt[] = [];
  for (let i = win; i < closes.length; i++) {
    const seg = closes.slice(i - win, i + 1).map((p) => p.v);
    const v = annualisedVol(logReturns(seg));
    if (Number.isFinite(v)) out.push({ t: closes[i].t, v });
  }
  return out;
}

/** Distance below the highest close of the trailing `win` days, as a positive percent. */
export function rollingDrawdown(closes: Pt[], win = 365): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < closes.length; i++) {
    const seg = closes.slice(Math.max(0, i - win + 1), i + 1);
    let hi = 0;
    for (const p of seg) if (p.v > hi) hi = p.v;
    if (hi > 0) out.push({ t: closes[i].t, v: Math.max(0, (1 - closes[i].v / hi) * 100) });
  }
  return out;
}

/**
 * Average pairwise correlation of daily log returns over a rolling window.
 * Series are joined on the dates every symbol has, so one late listing cannot
 * silently shorten the window for the others.
 */
export function rollingAvgCorrelation(bySymbol: Record<string, Pt[]>, win = 30): Pt[] {
  const syms = Object.keys(bySymbol).filter((s) => bySymbol[s].length > win + 2);
  if (syms.length < 3) return [];

  // Common date axis: dates present in every symbol.
  const counts = new Map<number, number>();
  for (const s of syms) for (const p of bySymbol[s]) counts.set(p.t, (counts.get(p.t) ?? 0) + 1);
  const dates = [...counts.entries()]
    .filter(([, c]) => c === syms.length)
    .map(([t]) => t)
    .sort((a, b) => a - b);
  if (dates.length < win + 2) return [];

  const lookup: Record<string, Map<number, number>> = {};
  for (const s of syms) lookup[s] = new Map(bySymbol[s].map((p) => [p.t, p.v]));

  // Log returns on the common axis, indexed from dates[1] onward.
  const rets: Record<string, number[]> = {};
  for (const s of syms) {
    const closes = dates.map((t) => lookup[s].get(t) as number);
    rets[s] = logReturns(closes);
  }
  const retDates = dates.slice(1);

  const out: Pt[] = [];
  for (let i = win - 1; i < retDates.length; i++) {
    let sum = 0;
    let n = 0;
    for (let a = 0; a < syms.length; a++) {
      for (let b = a + 1; b < syms.length; b++) {
        const c = correlation(
          rets[syms[a]].slice(i - win + 1, i + 1),
          rets[syms[b]].slice(i - win + 1, i + 1)
        );
        if (Number.isFinite(c)) {
          sum += c;
          n++;
        }
      }
    }
    if (n > 0) out.push({ t: retDates[i], v: sum / n });
  }
  return out;
}

/** Median of a numeric list. Ignores non-finite entries. */
export function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* --------------------------------------------------------------- composite -- */

export interface CsiComponent {
  id: CsiId;
  label: string;
  short: string;
  unit: string;
  source: string;
  hint: string;
  /** Base weight from CSI_SPECS. */
  weight: number;
  /** Weight actually applied after dropping dead components. Zero when dropped. */
  effWeight: number;
  /** Latest raw reading in this component's own units. */
  raw: number | null;
  /** Latest 0-100 percentile score, higher meaning more stress. */
  score: number | null;
  /** score * effWeight, the points this component puts into the headline. */
  contribution: number | null;
  live: boolean;
  /** Why it was dropped, when it was. */
  dropReason?: string;
  /** UTC-midnight timestamp of the latest observation. */
  at: number | null;
  /** Last 90 days of this component's score, for a small inline bar or spark. */
  spark: number[];
}

export interface CsiResult {
  score: number | null;
  percentile: number | null;
  history: Pt[];
  components: CsiComponent[];
  liveIds: CsiId[];
  droppedIds: CsiId[];
  /** Sum of the base weights that survived, before renormalising. */
  coverage: number;
}

/**
 * Build the composite from each component's percentile series.
 * Missing days are forward-filled up to CSI_MAX_STALE_DAYS so a one-day gap in
 * one feed does not punch a hole in the index; past that the component is
 * simply absent for that day and the survivors are renormalised. That keeps the
 * index on a 0-100 scale no matter how many feeds are up.
 */
export function buildCsi(scoreSeries: Partial<Record<CsiId, Pt[]>>, nowMs = Date.now()): CsiResult {
  const today = dayKey(nowMs);
  const maps: Partial<Record<CsiId, Map<number, number>>> = {};
  for (const spec of CSI_SPECS) {
    const s = scoreSeries[spec.id];
    if (s && s.length) maps[spec.id] = new Map(s.map((p) => [p.t, p.v]));
  }

  const valueAt = (id: CsiId, t: number): number | null => {
    const m = maps[id];
    if (!m) return null;
    for (let k = 0; k <= CSI_MAX_STALE_DAYS; k++) {
      const v = m.get(t - k * DAY);
      if (v != null && Number.isFinite(v)) return v;
    }
    return null;
  };

  const history: Pt[] = [];
  for (let k = CSI_HISTORY_DAYS - 1; k >= 0; k--) {
    const t = today - k * DAY;
    let num = 0;
    let den = 0;
    for (const spec of CSI_SPECS) {
      const v = valueAt(spec.id, t);
      if (v != null) {
        num += v * spec.weight;
        den += spec.weight;
      }
    }
    // Require at least half the weight present before publishing a point,
    // otherwise a single surviving feed would masquerade as the whole index.
    if (den >= 0.5) history.push({ t, v: num / den });
  }

  const components: CsiComponent[] = [];
  const liveIds: CsiId[] = [];
  const droppedIds: CsiId[] = [];

  for (const spec of CSI_SPECS) {
    const series = scoreSeries[spec.id] ?? [];
    const last = series.length ? series[series.length - 1] : null;
    const fresh = last != null && today - last.t <= CSI_MAX_STALE_DAYS * DAY;
    if (fresh) liveIds.push(spec.id);
    else droppedIds.push(spec.id);
    components.push({
      id: spec.id,
      label: spec.label,
      short: spec.short,
      unit: spec.unit,
      source: spec.source,
      hint: spec.hint,
      weight: spec.weight,
      effWeight: 0,
      raw: null,
      score: fresh && last ? last.v : null,
      contribution: null,
      live: fresh,
      dropReason: fresh
        ? undefined
        : last == null
          ? "upstream returned no usable history"
          : `newest observation is ${Math.round((today - last.t) / DAY)}d old`,
      at: last ? last.t : null,
      spark: series.slice(-CSI_SPARK_DAYS).map((p) => p.v),
    });
  }

  const coverage = components.filter((c) => c.live).reduce((a, c) => a + c.weight, 0);
  for (const c of components) {
    c.effWeight = c.live && coverage > 0 ? c.weight / coverage : 0;
    c.contribution = c.score != null ? c.score * c.effWeight : null;
  }

  const score = coverage > 0 ? components.reduce((a, c) => a + (c.contribution ?? 0), 0) : null;
  const hist = history.map((p) => p.v);
  const percentile = score != null && hist.length > 30 ? percentileRank(hist, score) : null;

  return { score, percentile, history, components, liveIds, droppedIds, coverage };
}

export interface StressPayload {
  ok: boolean;
  asOf: string;
  score: number | null;
  band: CsiBand;
  percentile: number | null;
  /** Composite value one day and one week ago, for the change chips. */
  prev1d: number | null;
  prev7d: number | null;
  /** Last CSI_SPARK_DAYS composite values, oldest first. */
  spark: number[];
  components: CsiComponent[];
  liveIds: CsiId[];
  droppedIds: CsiId[];
  coverage: number;
  historyDays: number;
}

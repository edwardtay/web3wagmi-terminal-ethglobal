// Quant primitives. Every analytic panel (risk, correlation, breadth,
// screener, signals, pairs) computes from these so one definition of
// volatility or drawdown holds across the terminal.

/** Simple returns from a price series. Length is n-1. */
export function returns(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    if (prev > 0 && Number.isFinite(series[i])) out.push(series[i] / prev - 1);
  }
  return out;
}

/** Log returns, preferred for volatility and correlation. */
export function logReturns(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    if (prev > 0 && series[i] > 0) out.push(Math.log(series[i] / prev));
  }
  return out;
}

export function mean(xs: number[]): number {
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Annualised realised volatility in percent.
 * Crypto trades 24/7, so a daily series annualises by sqrt(365), not 252.
 */
export function annualisedVol(dailyReturns: number[], periodsPerYear = 365): number {
  const sd = stdev(dailyReturns);
  return Number.isFinite(sd) ? sd * Math.sqrt(periodsPerYear) * 100 : NaN;
}

/** Worst peak-to-trough decline over the series, as a negative percent. */
export function maxDrawdown(series: number[]): number {
  if (series.length < 2) return NaN;
  let peak = series[0];
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < worst) worst = dd;
  }
  return worst * 100;
}

/** Annualised return / annualised vol. Risk-free defaults to zero. */
export function sharpe(dailyReturns: number[], periodsPerYear = 365, riskFree = 0): number {
  const sd = stdev(dailyReturns);
  if (!Number.isFinite(sd) || sd === 0) return NaN;
  return ((mean(dailyReturns) * periodsPerYear - riskFree) / (sd * Math.sqrt(periodsPerYear)));
}

/** Downside-only Sharpe. */
export function sortino(dailyReturns: number[], periodsPerYear = 365): number {
  const downside = dailyReturns.filter((r) => r < 0);
  if (downside.length < 2) return NaN;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
  if (dd === 0) return NaN;
  return (mean(dailyReturns) * periodsPerYear) / (dd * Math.sqrt(periodsPerYear));
}

/** Pearson correlation over the overlapping tail of two series. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = x[i] - mx;
    const by = y[i] - my;
    num += ax * by;
    dx += ax * ax;
    dy += by * by;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? NaN : num / den;
}

/** OLS slope/intercept/r2 of y on x. */
export function linreg(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = mean(x.slice(-n));
  const my = mean(y.slice(-n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const ax = x[i] - mx;
    const by = y[i] - my;
    sxy += ax * by;
    sxx += ax * ax;
    syy += by * by;
  }
  const slope = sxx === 0 ? NaN : sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: sxx * syy === 0 ? NaN : (sxy * sxy) / (sxx * syy) };
}

/** Beta of a against benchmark b, both as return series. */
export function beta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const { slope } = linreg(b.slice(-n), a.slice(-n));
  return slope;
}

/** Standard-score of the last value against the series. */
export function zscore(series: number[]): number {
  if (series.length < 3) return NaN;
  const sd = stdev(series);
  if (!Number.isFinite(sd) || sd === 0) return NaN;
  return (series[series.length - 1] - mean(series)) / sd;
}

/** Where the last value sits in its own history, 0..100. */
export function percentileRank(series: number[], value = series[series.length - 1]): number {
  const xs = series.filter(Number.isFinite);
  if (xs.length < 2) return NaN;
  const below = xs.filter((v) => v <= value).length;
  return (below / xs.length) * 100;
}

/** Simple moving average of the last n values. */
export function sma(series: number[], n: number): number {
  if (series.length < n) return NaN;
  return mean(series.slice(-n));
}

/** Full SMA series, aligned to the input (leading values are NaN). */
export function smaSeries(series: number[], n: number): number[] {
  return series.map((_, i) => (i + 1 < n ? NaN : mean(series.slice(i + 1 - n, i + 1))));
}

/** Wilder-smoothed RSI of the last bar. */
export function rsi(series: number[], period = 14): number {
  if (series.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = series[i] - series[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < series.length; i++) {
    const d = series[i] - series[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Percent change between the first and last value of a window. */
export function changePct(series: number[], lookback = series.length - 1): number {
  if (series.length < 2) return NaN;
  const from = series[Math.max(0, series.length - 1 - lookback)];
  const to = series[series.length - 1];
  if (!(from > 0)) return NaN;
  return (to / from - 1) * 100;
}

/** Clamp helper for gauge widths and scores. */
export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Map a value in [lo, hi] onto 0..100, clamped. */
export function scale(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi === lo) return NaN;
  return clamp(((value - lo) / (hi - lo)) * 100);
}

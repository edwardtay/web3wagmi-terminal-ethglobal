import { klines, allTickers24h, type Kline } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { ASSETS, MATRIX } from "@/lib/symbols";
import {
  annualisedVol,
  beta,
  changePct,
  correlation,
  logReturns,
  maxDrawdown,
  returns,
  sharpe,
  sortino,
} from "@/lib/stats";

// Cross-asset risk and return statistics for the whole universe, computed once
// on the server from one year of daily candles. Everything downstream (risk
// table, returns grid, scatter, correlation heatmap) reads this single payload
// so no two panels can disagree about what BTC's 90d vol was.

export const revalidate = 900;

const DAYS = 365;
/** Binance rate-limits by request weight; 8 in flight keeps us well inside it. */
const CONCURRENCY = 8;

export interface QuantRow {
  sym: string;
  name: string;
  sector: string;
  price: number;
  /** Percent returns over each window. */
  r24: number;
  r7: number;
  r30: number;
  r90: number;
  rYtd: number;
  r1y: number;
  /** Annualised realised volatility, percent. */
  vol30: number;
  vol90: number;
  /** Worst peak-to-trough over the window, negative percent. */
  mdd90: number;
  mdd365: number;
  sharpe: number;
  sortino: number;
  betaBtc: number;
  corrBtc: number;
  /** 90d return expressed annualised, the x axis of the risk/return scatter. */
  ret90Ann: number;
  quoteVolume: number;
}

export interface QuantPayload {
  ok: boolean;
  asOf: string;
  rows: QuantRow[];
  /** Correlation grids over MATRIX symbols, keyed by lookback in days. */
  matrixSyms: string[];
  corr: Record<string, number[][]>;
}

async function inChunks<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** Compound a window return up to a year, so 90d sits on the same axis as vol. */
function annualise(pctReturn: number, days: number): number {
  if (!Number.isFinite(pctReturn)) return NaN;
  return ((1 + pctReturn / 100) ** (365 / days) - 1) * 100;
}

/**
 * Year-to-date from the last close of the previous calendar year. Falls back to
 * the oldest candle we have when the series does not reach back to 1 January.
 */
function ytdPct(ks: Kline[]): number {
  const year = new Date(ks[ks.length - 1].openTime).getUTCFullYear();
  const first = ks.findIndex((k) => new Date(k.openTime).getUTCFullYear() === year);
  if (first <= 0) return NaN;
  const base = ks[first - 1].close;
  if (!(base > 0)) return NaN;
  return (ks[ks.length - 1].close / base - 1) * 100;
}

export async function GET() {
  const [tickers, series] = await Promise.all([
    allTickers24h(900),
    inChunks(ASSETS, CONCURRENCY, async (a) => ({
      asset: a,
      ks: await klines(a.pair, "1d", DAYS, revalidate),
    })),
  ]);

  const byPair = new Map((tickers ?? []).map((t) => [t.symbol, t]));
  const closesBySym = new Map<string, number[]>();
  for (const s of series) if (s.ks && s.ks.length > 30) closesBySym.set(s.asset.sym, s.ks.map((k) => k.close));

  const btc = closesBySym.get("BTC") ?? [];
  const rows: QuantRow[] = [];

  for (const { asset, ks } of series) {
    const c = closesBySym.get(asset.sym);
    if (!c || !ks) continue;
    const t = byPair.get(asset.pair);
    const rAll = returns(c);
    const lr90 = logReturns(c.slice(-91));
    const btc90 = logReturns(btc.slice(-91));
    // Correlation and beta only line up when both series cover the same days.
    const n = Math.min(lr90.length, btc90.length);
    const r90 = changePct(c, 90);

    rows.push({
      sym: asset.sym,
      name: asset.name,
      sector: asset.sector,
      price: t ? Number(t.lastPrice) : c[c.length - 1],
      r24: t ? Number(t.priceChangePercent) : changePct(c, 1),
      r7: changePct(c, 7),
      r30: changePct(c, 30),
      r90,
      rYtd: ytdPct(ks),
      r1y: changePct(c, c.length - 1),
      vol30: annualisedVol(logReturns(c.slice(-31))),
      vol90: annualisedVol(lr90),
      mdd90: maxDrawdown(c.slice(-90)),
      mdd365: maxDrawdown(c),
      sharpe: sharpe(rAll),
      sortino: sortino(rAll),
      betaBtc: asset.sym === "BTC" ? 1 : beta(lr90.slice(-n), btc90.slice(-n)),
      corrBtc: asset.sym === "BTC" ? 1 : correlation(lr90.slice(-n), btc90.slice(-n)),
      ret90Ann: annualise(r90, 90),
      quoteVolume: t ? Number(t.quoteVolume) : NaN,
    });
  }

  const matrixSyms = MATRIX.filter((s) => closesBySym.has(s));
  const corr: Record<string, number[][]> = {};
  for (const win of [30, 90, 365]) {
    corr[String(win)] = matrixSyms.map((a) =>
      matrixSyms.map((b) => {
        if (a === b) return 1;
        const ra = logReturns((closesBySym.get(a) ?? []).slice(-(win + 1)));
        const rb = logReturns((closesBySym.get(b) ?? []).slice(-(win + 1)));
        const n = Math.min(ra.length, rb.length);
        return correlation(ra.slice(-n), rb.slice(-n));
      })
    );
  }

  const payload: QuantPayload = {
    ok: rows.length > 0,
    asOf: new Date().toISOString(),
    rows,
    matrixSyms: rows.length ? matrixSyms : [],
    corr: rows.length ? corr : {},
  };
  return jsonResponse(payload, revalidate);
}

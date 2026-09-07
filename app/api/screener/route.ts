import { closes, allTickers24h } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { ASSETS } from "@/lib/symbols";
import { annualisedVol, changePct, logReturns, returns, rsi, sharpe, sma } from "@/lib/stats";

// The screener's own feed. It overlaps with /api/quant but stays separate so a
// slow correlation build never delays the table people filter on, and so the
// two panels can be cached and revalidated independently.

export const revalidate = 900;

const DAYS = 365;
const CONCURRENCY = 8;

export interface ScreenRow {
  sym: string;
  name: string;
  sector: string;
  price: number;
  r24: number;
  r7: number;
  r30: number;
  /** 24h quote volume in USDT. */
  vol24: number;
  /** Percent distance of price from the moving average. */
  d50: number;
  d200: number;
  rsi14: number;
  vol30: number;
  sharpe: number;
}

export interface ScreenPayload {
  ok: boolean;
  asOf: string;
  rows: ScreenRow[];
}

async function inChunks<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function distance(last: number, ma: number): number {
  if (!(ma > 0) || !Number.isFinite(last)) return NaN;
  return (last / ma - 1) * 100;
}

export async function GET() {
  const [tickers, series] = await Promise.all([
    allTickers24h(900),
    inChunks(ASSETS, CONCURRENCY, async (a) => ({ asset: a, c: await closes(a.pair, "1d", DAYS) })),
  ]);

  const byPair = new Map((tickers ?? []).map((t) => [t.symbol, t]));
  const rows: ScreenRow[] = [];

  for (const { asset, c } of series) {
    if (!c || c.length < 60) continue;
    const t = byPair.get(asset.pair);
    const last = c[c.length - 1];
    rows.push({
      sym: asset.sym,
      name: asset.name,
      sector: asset.sector,
      price: t ? Number(t.lastPrice) : last,
      r24: t ? Number(t.priceChangePercent) : changePct(c, 1),
      r7: changePct(c, 7),
      r30: changePct(c, 30),
      vol24: t ? Number(t.quoteVolume) : NaN,
      d50: distance(last, sma(c, 50)),
      d200: distance(last, sma(c, 200)),
      rsi14: rsi(c, 14),
      vol30: annualisedVol(logReturns(c.slice(-31))),
      sharpe: sharpe(returns(c)),
    });
  }

  const payload: ScreenPayload = { ok: rows.length > 0, asOf: new Date().toISOString(), rows };
  return jsonResponse(payload, revalidate);
}

import { klines } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { BY_SYM } from "@/lib/symbols";

// Candles for the main chart. The browser never calls Binance directly, so this
// route is the only path to OHLCV.

export const dynamic = "force-dynamic";

const INTERVALS = new Set(["15m", "1h", "4h", "1d", "1w"]);

// Shorter bars go stale faster, so cache seconds track the bar length rather
// than one flat number for every timeframe.
const CACHE: Record<string, number> = { "15m": 30, "1h": 60, "4h": 120, "1d": 300, "1w": 600 };

export interface Candle {
  /** Bar open time in seconds (what lightweight-charts wants). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume for the bar. */
  v: number;
}

export interface CandlesPayload {
  ok: boolean;
  asOf: string;
  symbol: string;
  pair: string;
  interval: string;
  candles: Candle[];
  last: number | null;
  /** Trailing 24h change in percent, from hourly closes. */
  change24h: number | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTC").toUpperCase();
  const rawInterval = url.searchParams.get("interval") ?? "1h";
  const interval = INTERVALS.has(rawInterval) ? rawInterval : "1h";
  const limit = Math.min(1000, Math.max(50, Number(url.searchParams.get("limit")) || 500));
  const seconds = CACHE[interval] ?? 60;

  const asset = BY_SYM[symbol];
  const empty: CandlesPayload = {
    ok: false,
    asOf: new Date().toISOString(),
    symbol,
    pair: asset?.pair ?? "",
    interval,
    candles: [],
    last: null,
    change24h: null,
  };
  if (!asset) return jsonResponse(empty, 300);

  // 25 hourly bars give a trailing 24h change without a second ticker endpoint.
  const [bars, hourly] = await Promise.all([
    klines(asset.pair, interval, limit, seconds),
    klines(asset.pair, "1h", 25, 60),
  ]);

  if (!bars || bars.length === 0) return jsonResponse(empty, 30);

  const candles: Candle[] = bars
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.open))
    .map((k) => ({
      t: Math.floor(k.openTime / 1000),
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
      v: k.volume,
    }));

  const last = candles.length ? candles[candles.length - 1].c : null;
  let change24h: number | null = null;
  if (hourly && hourly.length >= 2 && last != null) {
    const base = hourly[0].close;
    if (base > 0) change24h = (last / base - 1) * 100;
  }

  const payload: CandlesPayload = {
    ok: true,
    asOf: new Date().toISOString(),
    symbol,
    pair: asset.pair,
    interval,
    candles,
    last,
    change24h,
  };
  return jsonResponse(payload, seconds);
}

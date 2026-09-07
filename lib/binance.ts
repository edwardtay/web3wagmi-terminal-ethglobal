import "server-only";
import { getJson } from "./http";

// Binance public REST. No key, no auth. Spot lives on api.binance.com,
// USDT-margined futures on fapi.binance.com. Every helper returns null on
// failure so a panel degrades instead of throwing.

export const SPOT = "https://api.binance.com";
export const FAPI = "https://fapi.binance.com";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

function parseKlines(raw: RawKline[]): Kline[] {
  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
    quoteVolume: Number(k[7]),
    trades: k[8],
  }));
}

/** Spot candles. interval is a Binance interval string ("1h", "4h", "1d"). */
export async function klines(
  symbol: string,
  interval = "1d",
  limit = 200,
  revalidate = 300
): Promise<Kline[] | null> {
  const raw = await getJson<RawKline[]>(
    `${SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    { revalidate }
  );
  return Array.isArray(raw) ? parseKlines(raw) : null;
}

/** Closing prices only, the input most analytics want. */
export async function closes(symbol: string, interval = "1d", limit = 200): Promise<number[] | null> {
  const ks = await klines(symbol, interval, limit);
  return ks ? ks.map((k) => k.close).filter(Number.isFinite) : null;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
  weightedAvgPrice: string;
  count: number;
}

/**
 * Full spot 24h board. One call covers every symbol; filter after.
 * The response is ~2.5MB, past what Next's fetch cache will hold, and seven
 * routes read it, so it is memoised in process.
 */
export async function allTickers24h(revalidate = 60): Promise<Ticker24h[] | null> {
  return getJson<Ticker24h[]>(`${SPOT}/api/v3/ticker/24hr`, { revalidate, timeout: 15000, memo: true });
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

/** Perp mark/index price and current funding for every USDT-margined contract. */
export async function allPremiumIndex(revalidate = 60): Promise<PremiumIndex[] | null> {
  return getJson<PremiumIndex[]>(`${FAPI}/fapi/v1/premiumIndex`, { revalidate, timeout: 15000 });
}

export interface OpenInterestPoint {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

/** Open-interest history for one contract. period: "5m" | "1h" | "4h" | "1d". */
export async function openInterestHist(
  symbol: string,
  period = "1h",
  limit = 48,
  revalidate = 300
): Promise<OpenInterestPoint[] | null> {
  return getJson<OpenInterestPoint[]>(
    `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`,
    { revalidate }
  );
}

export interface LongShortPoint {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

/** Retail account long/short ratio. */
export async function longShortRatio(
  symbol: string,
  period = "1h",
  limit = 24,
  revalidate = 300
): Promise<LongShortPoint[] | null> {
  return getJson<LongShortPoint[]>(
    `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
    { revalidate }
  );
}

/** Top-trader positions, the "smart money" counterpart to the retail ratio. */
export async function topTraderRatio(
  symbol: string,
  period = "1h",
  limit = 24,
  revalidate = 300
): Promise<LongShortPoint[] | null> {
  return getJson<LongShortPoint[]>(
    `${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=${limit}`,
    { revalidate }
  );
}

export interface FundingRatePoint {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

/** Historical funding prints (8h cadence on most contracts). */
export async function fundingHistory(
  symbol: string,
  limit = 30,
  revalidate = 600
): Promise<FundingRatePoint[] | null> {
  return getJson<FundingRatePoint[]>(
    `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`,
    { revalidate }
  );
}

export interface DepthBook {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

/** Spot order book snapshot. limit is one of 5,10,20,50,100,500,1000,5000. */
export async function depth(symbol: string, limit = 100): Promise<DepthBook | null> {
  return getJson<DepthBook>(`${SPOT}/api/v3/depth?symbol=${symbol}&limit=${limit}`, {
    revalidate: 0,
  });
}

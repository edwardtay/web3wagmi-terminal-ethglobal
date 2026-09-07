import { getJson, jsonResponse } from "@/lib/http";
import { allTickers24h, closes, type Ticker24h } from "@/lib/binance";
import { ASSETS, HEADLINE, BY_SYM } from "@/lib/symbols";

// Market snapshot: the 24h board for the tracked universe, 72h shapes for the
// headline names, and the two global gauges (CoinGecko aggregate, Fear/Greed).
// Everything the top of the terminal needs in one round trip.

export const revalidate = 30;

export interface SnapTile {
  sym: string;
  name: string;
  pair: string;
  last: number;
  chg24: number;
  quoteVol: number;
  high24: number;
  low24: number;
  /** 0..1 position of last within the 24h low/high band. */
  rangePos: number | null;
  /** 72 hourly closes, oldest first. Empty when the kline call failed. */
  spark: number[];
}

export interface SnapGlobal {
  mcap: number;
  mcapChg24: number;
  vol24: number;
  btcDom: number;
  ethDom: number;
  stableDom: number;
  ethBtc: number | null;
  ethBtcChg24: number | null;
  ethBtcSpark: number[];
  updatedAt: number;
}

export interface FngPoint {
  t: number;
  v: number;
}

export interface SnapFng {
  value: number;
  label: string;
  yesterday: number | null;
  lastWeek: number | null;
  series: FngPoint[];
}

export interface SnapshotPayload {
  ok: boolean;
  asOf: string;
  headline: SnapTile[];
  board: { sym: string; last: number; chg24: number }[];
  global: SnapGlobal | null;
  fng: SnapFng | null;
}

interface CgGlobal {
  data?: {
    total_market_cap?: Record<string, number>;
    total_volume?: Record<string, number>;
    market_cap_percentage?: Record<string, number>;
    market_cap_change_percentage_24h_usd?: number;
    updated_at?: number;
  };
}

interface FngResponse {
  data?: { value: string; value_classification: string; timestamp: string }[];
}

function tile(t: Ticker24h | undefined, sym: string, spark: number[]): SnapTile | null {
  if (!t) return null;
  const last = Number(t.lastPrice);
  const high24 = Number(t.highPrice);
  const low24 = Number(t.lowPrice);
  const band = high24 - low24;
  return {
    sym,
    name: BY_SYM[sym]?.name ?? sym,
    pair: t.symbol,
    last,
    chg24: Number(t.priceChangePercent),
    quoteVol: Number(t.quoteVolume),
    high24,
    low24,
    // A flat band (illiquid or halted) has no meaningful position, so leave it null.
    rangePos: band > 0 ? Math.min(1, Math.max(0, (last - low24) / band)) : null,
    spark,
  };
}

export async function GET() {
  const asOf = new Date().toISOString();
  const empty: SnapshotPayload = { ok: false, asOf, headline: [], board: [], global: null, fng: null };

  const [tickers, cg, fngRaw, ...sparks] = await Promise.all([
    allTickers24h(30),
    getJson<CgGlobal>("https://api.coingecko.com/api/v3/global", { revalidate: 300 }),
    // The index prints once a day, so 30 entries is a month of context.
    getJson<FngResponse>("https://api.alternative.me/fng/?limit=30", { revalidate: 900 }),
    ...HEADLINE.map((s) => closes(BY_SYM[s]?.pair ?? `${s}USDT`, "1h", 72)),
  ]);

  if (!tickers) return jsonResponse(empty, 30);

  const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));

  const headline: SnapTile[] = [];
  HEADLINE.forEach((sym, i) => {
    const t = tile(bySymbol.get(BY_SYM[sym]?.pair ?? `${sym}USDT`), sym, sparks[i] ?? []);
    if (t) headline.push(t);
  });

  const board = ASSETS.flatMap((a) => {
    const t = bySymbol.get(a.pair);
    if (!t) return [];
    return [{ sym: a.sym, last: Number(t.lastPrice), chg24: Number(t.priceChangePercent) }];
  });

  // ETH/BTC comes off Binance's own cross pair rather than a USD division, so
  // the 24h change matches what a trader sees on the ETHBTC chart.
  const ethBtcT = bySymbol.get("ETHBTC");
  const btcSpark = sparks[HEADLINE.indexOf("BTC")] ?? [];
  const ethSpark = sparks[HEADLINE.indexOf("ETH")] ?? [];
  const ethBtcSpark =
    btcSpark.length === ethSpark.length && btcSpark.length > 1
      ? ethSpark.map((e, i) => e / btcSpark[i])
      : [];

  const d = cg?.data;
  const mcap = d?.total_market_cap?.usd;
  const global: SnapGlobal | null =
    d && typeof mcap === "number"
      ? {
          mcap,
          mcapChg24: d.market_cap_change_percentage_24h_usd ?? 0,
          vol24: d.total_volume?.usd ?? 0,
          btcDom: d.market_cap_percentage?.btc ?? 0,
          ethDom: d.market_cap_percentage?.eth ?? 0,
          stableDom: (d.market_cap_percentage?.usdt ?? 0) + (d.market_cap_percentage?.usdc ?? 0),
          ethBtc: ethBtcT ? Number(ethBtcT.lastPrice) : null,
          ethBtcChg24: ethBtcT ? Number(ethBtcT.priceChangePercent) : null,
          ethBtcSpark,
          updatedAt: d.updated_at ?? 0,
        }
      : null;

  const fd = fngRaw?.data;
  const fng: SnapFng | null =
    fd && fd.length > 0
      ? {
          value: Number(fd[0].value),
          label: fd[0].value_classification,
          yesterday: fd[1] ? Number(fd[1].value) : null,
          lastWeek: fd[7] ? Number(fd[7].value) : null,
          // Upstream returns newest first; charts want oldest first.
          series: fd
            .map((p) => ({ t: Number(p.timestamp) * 1000, v: Number(p.value) }))
            .filter((p) => Number.isFinite(p.v))
            .reverse(),
        }
      : null;

  return jsonResponse({ ok: headline.length > 0, asOf, headline, board, global, fng }, 30);
}

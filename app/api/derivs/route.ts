import { getJson, postJson, jsonResponse } from "@/lib/http";
import { hyperliquidLiquidations } from "@/lib/graph";
import {
  FAPI,
  allPremiumIndex,
  allTickers24h,
  fundingHistory,
  longShortRatio,
  openInterestHist,
  topTraderRatio,
  type FundingRatePoint,
  type OpenInterestPoint,
  type LongShortPoint,
} from "@/lib/binance";
import { ASSETS } from "@/lib/symbols";

// The perpetuals desk: funding, open interest, positioning. Binance is the
// venue of record for size, Hyperliquid is the on-chain comparison, and the
// spread between the two is the part no single-venue screen shows.

export const revalidate = 180;
const CACHE = 180;

const PERPS = ASSETS.filter((a) => a.perp);

/** Binance funding caps out at 8h on most contracts but 1h and 4h exist. */
const DEFAULT_INTERVAL_HOURS = 8;

interface FundingInfo {
  symbol: string;
  fundingIntervalHours: number;
}

interface HlMeta {
  universe: { name: string; isDelisted?: boolean }[];
}
interface HlCtx {
  funding: string;
  openInterest: string;
  markPx: string;
  midPx: string | null;
}

/**
 * Hyperliquid prefixes a contract with "k" where it quotes 1000 units, the way
 * Binance prefixes "1000". The funding rate itself is multiplier-independent,
 * so a plain symbol match plus the k-form is enough.
 */
function hlNames(sym: string): string[] {
  return [sym, `k${sym}`, sym === "MATIC" ? "POL" : sym];
}

/** Run jobs `size` at a time so a 50-call fan-out does not trip a rate limit. */
async function chunked<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export interface FundingRow {
  sym: string;
  name: string;
  perp: string;
  /** Raw per-interval rate as a fraction, e.g. 0.0001 = 1 bp. */
  rate: number;
  intervalHours: number;
  /** Per-interval rate annualised, in percent. */
  annual: number;
  /** Hyperliquid annualised funding in percent, null when not listed there. */
  hlAnnual: number | null;
  /** Binance minus Hyperliquid, in percent annualised. */
  spread: number | null;
  nextFundingTime: number;
  /** Perp mark over index, in basis-point fraction terms. */
  premium: number | null;
  /** Last 30 funding prints as fractions, oldest first. */
  history: number[];
}

export interface OiRow {
  sym: string;
  name: string;
  perp: string;
  oiUsd: number;
  /**
   * 24h change in CONTRACT count, which is what the regime is read from.
   * Notional OI rises whenever price rises, so a USD change cannot separate new
   * positions from repricing of existing ones.
   */
  oiChangePct: number | null;
  /** 24h change in notional, shown alongside so the two can be compared. */
  oiUsdChangePct: number | null;
  priceChangePct: number | null;
  regime: Regime | null;
  /** 48 hourly open-interest values in USD, oldest first. */
  series: number[];
}

export type Regime = "new longs" | "new shorts" | "short covering" | "long liquidation";

function regimeOf(price: number | null, oi: number | null): Regime | null {
  if (price == null || oi == null) return null;
  if (price >= 0 && oi >= 0) return "new longs";
  if (price < 0 && oi >= 0) return "new shorts";
  if (price >= 0 && oi < 0) return "short covering";
  return "long liquidation";
}

export interface RatioRow {
  sym: string;
  retailLong: number;
  retailShort: number;
  topLong: number;
  topShort: number;
  retailRatio: number;
  topRatio: number;
}

function empty(reason: string) {
  return jsonResponse(
    {
      ok: false,
      reason,
      asOf: new Date().toISOString(),
      hyperliquid: false,
      funding: [],
      oi: [],
      ratios: [],
      totalOiUsd: 0,
      totalOiChangePct: null,
    },
    CACHE
  );
}

export async function GET() {
  const [premium, tickers, fundingInfo, hl] = await Promise.all([
    allPremiumIndex(CACHE),
    allTickers24h(CACHE),
    getJson<FundingInfo[]>(`${FAPI}/fapi/v1/fundingInfo`, { revalidate: 3600 }),
    postJson<[HlMeta, HlCtx[]]>(
      "https://api.hyperliquid.xyz/info",
      { type: "metaAndAssetCtxs" },
      { revalidate: CACHE }
    ),
  ]);

  // premiumIndex is the one call the whole panel depends on.
  if (!premium || !Array.isArray(premium)) return empty("Binance premiumIndex unavailable");

  const byPerp = new Map(premium.map((p) => [p.symbol, p]));
  const spot = new Map((tickers ?? []).map((t) => [t.symbol, t]));
  const intervalBySym = new Map((fundingInfo ?? []).map((f) => [f.symbol, f.fundingIntervalHours]));

  const hlFunding = new Map<string, number>();
  if (Array.isArray(hl) && hl.length === 2 && Array.isArray(hl[1])) {
    const [meta, ctxs] = hl;
    meta.universe?.forEach((u, i) => {
      const ctx = ctxs[i];
      if (!ctx || u.isDelisted) return;
      const f = Number(ctx.funding);
      // Hyperliquid quotes funding hourly, Binance per settlement interval.
      if (Number.isFinite(f)) hlFunding.set(u.name, f * 24 * 365 * 100);
    });
  }

  // The on-chain side of a liquidation, from The Graph. One request, and it is
  // the only liquidation source here that survives a page reload: the Binance
  // feed is a websocket stream, so it starts empty every time the tab opens.
  const hlLiq = await hyperliquidLiquidations({
    since: new Date(Date.now() - 24 * 3600 * 1000),
    revalidate: CACHE,
  }).catch(() => null);

  const fundingHist = await chunked(PERPS, 8, (a) => fundingHistory(a.perp!, 30, 600));
  const oiHist = await chunked(PERPS, 8, (a) => openInterestHist(a.perp!, "1h", 48, 300));

  const funding: FundingRow[] = [];
  const oi: OiRow[] = [];

  PERPS.forEach((a, i) => {
    const p = byPerp.get(a.perp!);
    if (!p) return;

    const rate = Number(p.lastFundingRate);
    const hours = intervalBySym.get(a.perp!) ?? DEFAULT_INTERVAL_HOURS;
    const periodsPerYear = (24 / hours) * 365;
    // Mark and index come from the same premiumIndex row and the same instant,
    // so the basis is real rather than an artefact of two caches drifting apart.
    const mark = Number(p.markPrice);
    const index = Number(p.indexPrice);

    const hlName = hlNames(a.sym).find((n) => hlFunding.has(n));
    const hlAnnual = hlName ? hlFunding.get(hlName)! : null;
    const annual = Number.isFinite(rate) ? rate * periodsPerYear * 100 : NaN;

    const hist: FundingRatePoint[] = (fundingHist[i] as FundingRatePoint[] | null) ?? [];

    if (Number.isFinite(annual)) {
      funding.push({
        sym: a.sym,
        name: a.name,
        perp: a.perp!,
        rate,
        intervalHours: hours,
        annual,
        hlAnnual,
        spread: hlAnnual == null ? null : annual - hlAnnual,
        nextFundingTime: p.nextFundingTime,
        premium: Number.isFinite(mark) && index > 0 ? mark / index - 1 : null,
        history: hist.map((h) => Number(h.fundingRate)).filter(Number.isFinite),
      });
    }

    const pts: OpenInterestPoint[] = (oiHist[i] as OpenInterestPoint[] | null) ?? [];
    const series = pts.map((q) => Number(q.sumOpenInterestValue)).filter(Number.isFinite);
    // Contract count, the same prints in base units. The regime is read from
    // this: notional moves with price, so a USD-based read labels every rally
    // "new longs" and every selloff "long liquidation" regardless of positioning.
    const contracts = pts.map((q) => Number(q.sumOpenInterest)).filter(Number.isFinite);
    if (series.length) {
      const last = series[series.length - 1];
      // 24 hourly prints back, or the oldest print we have if the series is short.
      const prev = series[Math.max(0, series.length - 25)];
      const px = spot.get(a.pair)?.priceChangePercent;
      const priceChangePct = px == null ? null : Number(px);
      const oiUsdChangePct = prev > 0 ? (last / prev - 1) * 100 : null;

      const cLast = contracts.length ? contracts[contracts.length - 1] : NaN;
      const cPrev = contracts.length ? contracts[Math.max(0, contracts.length - 25)] : NaN;
      const oiChangePct = cPrev > 0 ? (cLast / cPrev - 1) * 100 : null;

      oi.push({
        sym: a.sym,
        name: a.name,
        perp: a.perp!,
        oiUsd: last,
        oiChangePct,
        oiUsdChangePct,
        priceChangePct: Number.isFinite(priceChangePct as number) ? priceChangePct : null,
        regime: regimeOf(priceChangePct, oiChangePct),
        series,
      });
    }
  });

  funding.sort((x, y) => y.annual - x.annual);
  oi.sort((x, y) => y.oiUsd - x.oiUsd);

  const totalOiUsd = oi.reduce((s, r) => s + r.oiUsd, 0);
  const totalPrev = oi.reduce(
    (s, r) => s + (r.series[Math.max(0, r.series.length - 25)] ?? r.oiUsd),
    0
  );
  const totalOiChangePct = totalPrev > 0 ? (totalOiUsd / totalPrev - 1) * 100 : null;

  // Retail account ratio against top-trader position ratio. Only the two
  // majors: below that the top-trader sample is too thin to read.
  const ratioSyms = ["BTCUSDT", "ETHUSDT"];
  const [retail, top] = await Promise.all([
    Promise.all(ratioSyms.map((s) => longShortRatio(s, "1h", 1, 300))),
    Promise.all(ratioSyms.map((s) => topTraderRatio(s, "1h", 1, 300))),
  ]);

  const ratios: RatioRow[] = [];
  ratioSyms.forEach((s, i) => {
    const r = (retail[i] as LongShortPoint[] | null)?.at(-1);
    const t = (top[i] as LongShortPoint[] | null)?.at(-1);
    if (!r || !t) return;
    ratios.push({
      sym: s.replace("USDT", ""),
      retailLong: Number(r.longAccount) * 100,
      retailShort: Number(r.shortAccount) * 100,
      topLong: Number(t.longAccount) * 100,
      topShort: Number(t.shortAccount) * 100,
      retailRatio: Number(r.longShortRatio),
      topRatio: Number(t.longShortRatio),
    });
  });

  return jsonResponse(
    {
      ok: funding.length > 0 || oi.length > 0,
      asOf: new Date().toISOString(),
      hyperliquid: hlFunding.size > 0,
      /**
       * Largest Hyperliquid liquidations of the last 24h, indexed.
       *
       * `direction` is the venue's own label. A CLOSE_LONG is a long being
       * closed out, so it is selling pressure, and the naming is theirs rather
       * than ours on purpose: renaming a venue's event type is how a terminal
       * ends up meaning something the venue did not say.
       */
      hlLiquidations: (hlLiq ?? []).map((l) => ({
        at: l.timestamp,
        coin: l.coin,
        direction: l.direction,
        notional: l.notional,
        price: l.avg_fill_price,
        user: l.liquidated_user,
      })),
      funding,
      oi,
      ratios,
      totalOiUsd,
      totalOiChangePct,
    },
    CACHE
  );
}

import { jsonResponse, getJson } from "@/lib/http";
import {
  allPremiumIndex,
  allTickers24h,
  closes,
  fundingHistory,
  openInterestHist,
  type FundingRatePoint,
  type OpenInterestPoint,
} from "@/lib/binance";
import { ASSETS } from "@/lib/symbols";
import { TOKENS } from "@/lib/netflow";
import { GRAPH_HISTORY_TTL, aggregateBalances, readFlowSeries } from "@/lib/flow";
import { annualisedVol, logReturns, percentileRank, stdev } from "@/lib/stats";

// The dislocation queue: what just became abnormal, ranked. Every other panel
// answers "what is the level". This one answers "what should I look at first",
// which is the reason to leave a terminal open.
//
// A signal only fires against a reference, never against a round number a
// designer picked. Funding is compared to its own print history, a price move to
// the instrument's own recent volatility, implied vol to realised vol on the same
// asset. That way "extreme" survives a regime change.

export const revalidate = 300;

export type SignalKind = "funding" | "move" | "oi" | "vol-carry" | "peg" | "flow" | "unlock";

export interface Signal {
  id: string;
  kind: SignalKind;
  /** 0-100. Ranking only, and comparable across kinds by construction. */
  severity: number;
  symbol: string | null;
  headline: string;
  detail: string;
  /** The measurement the signal rests on, so nothing is a black box. */
  evidence: string;
  /** Anchor on the home page that shows the underlying panel. */
  href: string;
  /** Direction, where one applies. Drives colour. */
  bias: "long" | "short" | "neutral";
}

/** "1st", "2nd", "23rd". A percentile printed as "2th" undermines the number. */
function ordinal(n: number): string {
  const v = Math.round(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const last = v % 10;
  return `${v}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** Map an excess above a threshold onto 0-100, saturating at `full`. */
function sev(value: number, threshold: number, full: number): number {
  if (!Number.isFinite(value) || value < threshold) return 0;
  return Math.min(100, ((value - threshold) / (full - threshold)) * 100);
}

async function chunked<T>(items: string[], size: number, job: (s: string) => Promise<T>) {
  const out = new Map<string, T>();
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const res = await Promise.all(slice.map(job));
    slice.forEach((s, j) => out.set(s, res[j]));
  }
  return out;
}

/**
 * Prints per year, read from the gaps between actual settlements rather than
 * assumed. Most USDT perps settle every 8 hours but some settle every 4, and a
 * fixed multiplier would misstate those by a factor of two.
 */
function printsPerYear(hist: FundingRatePoint[]): number {
  const times = hist.map((h) => h.fundingTime).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 3) return 3 * 365; // 8h fallback, the common case
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const hours = median / 3_600_000;
  return hours > 0 ? (24 / hours) * 365 : 3 * 365;
}

interface UnlockRow {
  date: string;
  daysAway: number;
  symbol: string;
  name: string;
  usd: number;
  pctOfMcap: number | null;
}

interface DvolPoint {
  result?: { data?: [number, number, number, number, number][] };
}

/** Deribit DVOL daily closes for one currency, newest last. */
async function dvolCloses(ccy: "BTC" | "ETH"): Promise<number[]> {
  const end = Date.now();
  const start = end - 60 * 86_400_000;
  const res = await getJson<DvolPoint>(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${ccy}&resolution=86400&start_timestamp=${start}&end_timestamp=${end}`,
    { revalidate: 900, timeout: 12_000 }
  );
  // Candle rows are [timestamp, open, high, low, close].
  return (res?.result?.data ?? []).map((r) => r[4]).filter(Number.isFinite);
}

interface StableAsset {
  symbol?: string;
  name?: string;
  price?: number | null;
  pegType?: string;
  /** Tokenised treasuries accrue yield into the price, so they sit above $1 by design. */
  yieldBearing?: boolean | null;
  circulating?: { peggedUSD?: number } | null;
}

export async function GET() {
  const asOf = new Date().toISOString();
  const perps = ASSETS.filter((a) => a.perp).map((a) => a.perp as string);

  const [tickers, premium, dailyCloses, fundingHist, oiHist, btcDvol, ethDvol, stables, unlocks, flowSeries] =
    await Promise.all([
      allTickers24h(300),
      allPremiumIndex(300),
      chunked(
        ASSETS.map((a) => a.pair),
        8,
        (p) => closes(p, "1d", 60)
      ),
      chunked(perps, 8, (p) => fundingHistory(p, 60, 900)),
      chunked(perps, 8, (p) => openInterestHist(p, "1h", 30, 900)),
      dvolCloses("BTC"),
      dvolCloses("ETH"),
      getJson<{ peggedAssets?: StableAsset[] }>(
        "https://stablecoins.llama.fi/stablecoins?includePrices=true",
        { revalidate: 900, timeout: 20_000, memo: true }
      ),
      // Over loopback, not the public hostname: that route sets a long
      // s-maxage and the CDN would serve this scan a stale copy of it.
      getJson<{ rows?: UnlockRow[] }>(
        `http://127.0.0.1:${process.env.PORT ?? 3000}/api/unlocks`,
        // The unlocks route parses a 29MB emissions dataset on a cold read, so
        // a 30s ceiling silently returned nothing and the scan reported zero
        // unlocks while the route itself was serving 126 of them.
        { revalidate: 900, timeout: 60_000 }
      ),
      // Same TTL as /api/netflow on purpose. The underlying reads go through
      // `getJson`, so Next's fetch cache serves both routes from one set of
      // requests and this costs nothing on the meter.
      readFlowSeries(GRAPH_HISTORY_TTL).catch(() => null),
    ]);

  const signals: Signal[] = [];
  const spot = new Map((tickers ?? []).map((t) => [t.symbol, t]));

  // ---- 1. Funding against its own history ---------------------------------
  // A rate is only "extreme" relative to what this contract normally pays, so a
  // permanently rich perp does not sit in the queue forever.
  for (const a of ASSETS) {
    if (!a.perp) continue;
    const hist = (fundingHist.get(a.perp) as FundingRatePoint[] | null) ?? [];
    const annualise = printsPerYear(hist);
    const rates = hist.map((h) => Number(h.fundingRate) * annualise * 100).filter(Number.isFinite);
    const live = premium?.find((p) => p.symbol === a.perp);
    const now = live ? Number(live.lastFundingRate) * annualise * 100 : NaN;
    if (!Number.isFinite(now) || rates.length < 20) continue;

    const rank = percentileRank([...rates, now], now);
    const extreme = Math.max(rank, 100 - rank);
    // Both legs must agree: an unusual rank AND a rate big enough to pay for.
    if (extreme < 92 || Math.abs(now) < 15) continue;

    const long = now > 0;
    signals.push({
      id: `funding-${a.sym}`,
      kind: "funding",
      severity: Math.round((sev(extreme, 92, 100) * 0.5 + sev(Math.abs(now), 15, 120) * 0.5)),
      symbol: a.sym,
      headline: `${a.sym} funding ${long ? "crowded long" : "crowded short"}`,
      detail: long
        ? "Longs are paying to hold. Crowded positioning cuts both ways, and it is what a squeeze needs."
        : "Shorts are paying to hold, which is the rarer and usually sharper setup.",
      evidence: `${now >= 0 ? "+" : ""}${now.toFixed(0)}% annualised, ${ordinal(rank)} percentile of its own last ${rates.length} prints`,
      href: "/#funding",
      bias: long ? "short" : "long",
    });
  }

  // ---- 2. Price move measured in the asset's own volatility ----------------
  for (const a of ASSETS) {
    const c = dailyCloses.get(a.pair) as number[] | null;
    const t = spot.get(a.pair);
    if (!c || c.length < 35 || !t) continue;
    const daily = stdev(logReturns(c.slice(-31))) * 100;
    const move = Number(t.priceChangePercent);
    if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(move)) continue;
    const sigma = Math.abs(move) / daily;
    if (sigma < 2.5) continue;

    signals.push({
      id: `move-${a.sym}`,
      kind: "move",
      severity: Math.round(sev(sigma, 2.5, 6)),
      symbol: a.sym,
      headline: `${a.sym} moved ${sigma.toFixed(1)}x its usual day`,
      detail:
        "A move this far outside the asset's own recent range is news or thin liquidity. Look at what traded before reading the chart.",
      evidence: `${move >= 0 ? "+" : ""}${move.toFixed(1)}% in 24h against a ${daily.toFixed(1)}% daily sigma`,
      href: "/#live",
      bias: move >= 0 ? "long" : "short",
    });
  }

  // ---- 3. Open interest shock, in contracts ------------------------------
  // Contracts, never notional: notional moves with price and would fire on
  // every rally.
  for (const a of ASSETS) {
    if (!a.perp) continue;
    const pts = (oiHist.get(a.perp) as OpenInterestPoint[] | null) ?? [];
    const series = pts.map((p) => Number(p.sumOpenInterest)).filter(Number.isFinite);
    if (series.length < 25) continue;
    const last = series[series.length - 1];
    const prev = series[Math.max(0, series.length - 25)];
    if (!(prev > 0)) continue;
    const chg = (last / prev - 1) * 100;
    const t = spot.get(a.pair);
    const move = t ? Number(t.priceChangePercent) : NaN;
    if (Math.abs(chg) < 12) continue;

    const building = chg > 0;
    const regime = !Number.isFinite(move)
      ? "positioning shifted"
      : building && move >= 0
        ? "new longs"
        : building && move < 0
          ? "new shorts"
          : move >= 0
            ? "short covering"
            : "long liquidation";

    signals.push({
      id: `oi-${a.sym}`,
      kind: "oi",
      severity: Math.round(sev(Math.abs(chg), 12, 45)),
      symbol: a.sym,
      headline: `${a.sym} open interest ${building ? "built" : "unwound"} ${Math.abs(chg).toFixed(0)}%`,
      detail: `Read as ${regime}. Counted in contracts, so this is positions opening or closing rather than the same positions changing in dollar value.`,
      evidence: `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% contracts in 24h, price ${Number.isFinite(move) ? `${move >= 0 ? "+" : ""}${move.toFixed(1)}%` : "unknown"}`,
      href: "/#oi",
      bias: regime === "new longs" ? "long" : regime === "new shorts" ? "short" : "neutral",
    });
  }

  // ---- 4. Vol carry: implied against realised -----------------------------
  // The one signal that prices an option trade rather than a direction.
  for (const [ccy, pair, dv] of [
    ["BTC", "BTCUSDT", btcDvol],
    ["ETH", "ETHUSDT", ethDvol],
  ] as const) {
    const c = dailyCloses.get(pair) as number[] | null;
    if (!c || c.length < 35 || dv.length < 5) continue;
    const rv = annualisedVol(logReturns(c.slice(-31)));
    const iv = dv[dv.length - 1];
    if (!Number.isFinite(rv) || !Number.isFinite(iv)) continue;
    const spread = iv - rv;
    if (Math.abs(spread) < 10) continue;

    const rich = spread > 0;
    signals.push({
      id: `volcarry-${ccy}`,
      kind: "vol-carry",
      severity: Math.round(sev(Math.abs(spread), 10, 35)),
      symbol: ccy,
      headline: `${ccy} implied vol ${rich ? "rich" : "cheap"} against realised`,
      detail: rich
        ? "Options are pricing more movement than the asset has been delivering, so premium sellers are being paid above the recent cost of hedging."
        : "Options are pricing less movement than the asset has been delivering, which is when protection is unusually cheap.",
      evidence: `implied ${iv.toFixed(0)} (Deribit DVOL) against 30d realised ${rv.toFixed(0)}, a ${spread >= 0 ? "+" : ""}${spread.toFixed(0)} point gap`,
      href: "/#options",
      bias: "neutral",
    });
  }

  // ---- 5. Stablecoin peg ---------------------------------------------------
  for (const s of stables?.peggedAssets ?? []) {
    if (s.pegType !== "peggedUSD") continue;
    // A yield-bearing token drifting above par is the product working, not a
    // depeg. Without this the queue is topped by USYC and USDY every day.
    if (s.yieldBearing === true) continue;
    const supply = s.circulating?.peggedUSD ?? 0;
    const price = s.price;
    if (supply < 500_000_000 || price == null || !Number.isFinite(price)) continue;
    const bps = (price - 1) * 10_000;
    if (Math.abs(bps) < 50) continue;

    signals.push({
      id: `peg-${s.symbol ?? s.name}`,
      kind: "peg",
      severity: Math.round(sev(Math.abs(bps), 50, 400)),
      symbol: s.symbol ?? null,
      headline: `${s.symbol ?? s.name} is ${bps < 0 ? "below" : "above"} peg`,
      detail:
        "An average price across venues, so a small gap is usually noise. A gap that persists is one of the clearest signs of stress in the market.",
      evidence: `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}% off the dollar (${bps >= 0 ? "+" : ""}${bps.toFixed(0)} bps), ${(supply / 1e9).toFixed(1)}B circulating`,
      href: "/#stablecoins",
      bias: bps < 0 ? "short" : "neutral",
    });
  }

  // Unlocks are deliberately absent from the queue. The only free source is a
  // 29MB emissions dataset, and pulling it a second time here to re-derive what
  // /api/unlocks already computes would double the cost for a signal that panel
  // already highlights.

  // A market-wide funding regime is ONE condition, not twenty. When most of the
  // universe is paying in the same direction, the individual rows are all
  // reporting the same fact, so collapse them into a single signal that names the
  // members. Otherwise one regime fills the whole queue and buries everything else.
  const COLLAPSE_AT = 5;
  // ---- 6. A scheduled unlock, close and large against the float ----------
  // Every other signal here is a measurement that became abnormal. This one is
  // a date. It is the only thing on the page a reader can know in advance, and
  // it was reaching the terminal as a table nobody scrolled to rather than as
  // something the queue would put in front of them.
  //
  // Two conditions, and both are necessary. Size alone is not an event: a
  // hundred million dollars against a large float is a Tuesday. Proximity alone
  // is not either, since a small cliff tomorrow changes nothing. What matters
  // is a large share of the circulating supply arriving soon enough to trade
  // against.
  for (const u of (unlocks?.rows ?? []).slice(0, 200)) {
    const share = u.pctOfMcap;
    if (share == null || !Number.isFinite(share)) continue;
    // Below 3% of float the market absorbs it without needing to be told, and
    // beyond a fortnight it is not yet actionable.
    if (share < 3 || u.daysAway > 14) continue;

    const when = u.daysAway === 0 ? "today" : u.daysAway === 1 ? "tomorrow" : `in ${u.daysAway} days`;
    signals.push({
      id: `unlock-${u.symbol}-${u.date}`,
      kind: "unlock",
      // Nearness counts as much as size: the same cliff is a different problem
      // today and a fortnight out.
      severity: Math.round(sev(share, 3, 25) * 0.65 + sev(14 - u.daysAway, 0, 14) * 0.35),
      symbol: u.symbol,
      headline: `${u.symbol} releases ${share.toFixed(1)}% of its supply ${when}`,
      detail:
        "New supply on a known date. It does not have to be sold to matter, because the market prices the possibility in advance, so the move often lands before the date rather than on it.",
      evidence: `$${(u.usd / 1e6).toFixed(1)}m at ${u.date}, ${share.toFixed(1)}% of circulating market cap`,
      href: "/#unlocks",
      bias: "short",
    });
  }

  // ---- 6. Exchange flow against its own thirty day distribution -----------
  // Coins arriving on an exchange can be sold and stablecoins arriving are
  // buying power, so the two legs read in opposite directions. Neither is
  // interesting at a round dollar figure: a billion of USDT moving is a normal
  // Tuesday for Binance. What makes it a signal is the size of today's move
  // against how much this balance normally moves.
  if (flowSeries) {
    for (const token of TOKENS) {
      const rows = flowSeries.filter((s) => s.sym === token.sym);
      const curve = aggregateBalances(rows);
      if (curve.length < 20) continue;

      const price = token.pricePair ? Number(spot.get(token.pricePair)?.lastPrice ?? NaN) : 1;
      if (!Number.isFinite(price) || price <= 0) continue;

      // Newest first, so index 0 is the most recent completed change.
      const changes = curve.slice(0, -1).map((p, i) => (p.balance - curve[i + 1].balance) * price);
      const latest = changes[0];
      const prior = changes.slice(1);
      const sd = stdev(prior);
      if (!Number.isFinite(latest) || !Number.isFinite(sd) || sd <= 0) continue;

      const z = latest / sd;
      if (Math.abs(z) < 2) continue;

      const arriving = latest > 0;
      // A stablecoin arriving is capital showing up to buy. A coin arriving is
      // supply showing up to sell. Same sign, opposite reading.
      const constructive = token.kind === "stable" ? arriving : !arriving;
      signals.push({
        id: `flow-${token.sym}`,
        kind: "flow",
        severity: Math.round(sev(Math.abs(z), 2, 5)),
        symbol: token.sym,
        headline: `${token.sym} ${arriving ? "arriving on" : "leaving"} exchanges`,
        detail:
          token.kind === "stable"
            ? arriving
              ? "Stablecoins moving onto exchanges is buying power arriving at the venues where it can be spent."
              : "Stablecoins leaving exchanges is capital going back to self custody or into yield, and it is not there to bid."
            : arriving
              ? "Coins moving onto exchanges become sellable supply. It is the deposit that precedes a sale, not the sale itself."
              : "Coins leaving exchanges reduces the supply that can be sold at short notice.",
        evidence: `${latest >= 0 ? "+" : "-"}$${Math.abs(latest / 1e6).toFixed(0)}m in a day, ${Math.abs(z).toFixed(1)} sigma against its own last ${prior.length} daily changes`,
        href: "/#netflow",
        bias: constructive ? "long" : "short",
      });
    }
  }

  // Eleven unlocks in a fortnight is a calendar, not a queue. Keep the two that
  // are nearest and largest, and collapse the rest into one row that says how
  // many there are, the same way a market-wide funding dislocation collapses
  // below. A queue one kind can flood stops ranking anything.
  const UNLOCK_KEEP = 2;
  const unlockSignals = signals.filter((s) => s.kind === "unlock").sort((a, b) => b.severity - a.severity);
  if (unlockSignals.length > UNLOCK_KEEP + 1) {
    const collapsed = unlockSignals.slice(UNLOCK_KEEP);
    for (const s of collapsed) signals.splice(signals.indexOf(s), 1);
    const names = collapsed
      .map((s) => s.symbol)
      .filter((v): v is string => v != null)
      .slice(0, 8);
    signals.push({
      id: "unlock-more",
      kind: "unlock",
      // Below the two it stands behind, because it is context rather than an
      // event.
      severity: Math.max(1, Math.round((unlockSignals[UNLOCK_KEEP]?.severity ?? 10) * 0.6)),
      symbol: null,
      headline: `${collapsed.length} more token releases above 3% of supply in two weeks`,
      detail:
        "Several assets releasing supply in the same fortnight. None is the largest thing here on its own, and the timetable is known in advance.",
      evidence: `${names.join(", ")}${collapsed.length > names.length ? ", and others" : ""}`,
      href: "/#unlocks",
      bias: "short",
    });
  }

  for (const dir of ["long", "short"] as const) {
    const group = signals.filter((x) => x.kind === "funding" && x.bias === (dir === "long" ? "short" : "long"));
    if (group.length < COLLAPSE_AT) continue;
    const members = group
      .map((g) => g.symbol)
      .filter((v): v is string => v != null)
      .sort();
    const worst = Math.max(...group.map((g) => g.severity));
    for (const g of group) signals.splice(signals.indexOf(g), 1);
    signals.push({
      id: `funding-wide-${dir}`,
      kind: "funding",
      // A market-wide dislocation matters more than any single leg of it.
      severity: Math.min(100, Math.round(worst + 10)),
      symbol: null,
      headline: `Funding crowded ${dir} across ${group.length} contracts`,
      detail:
        dir === "long"
          ? "Most of the tracked universe is paying to be long at once. That is a positioning regime rather than a single crowded trade, and it is the setup that unwinds together."
          : "Most of the tracked universe is paying to be short at once. Broad short crowding unwinds faster than long crowding, because covering is forced.",
      evidence: `${members.join(", ")}, each past the 92nd percentile of its own funding history`,
      href: "/#funding",
      bias: dir === "long" ? "short" : "long",
    });
  }

  signals.sort((a, b) => b.severity - a.severity);

  const counts = signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});

  return jsonResponse(
    {
      ok: Boolean(tickers),
      asOf,
      signals: signals.slice(0, 40),
      counts,
      scanned: {
        perps: perps.length,
        assets: ASSETS.length,
        stables: (stables?.peggedAssets ?? []).length,
        unlocks: (unlocks?.rows ?? []).length,
        flowWallets: new Set((flowSeries ?? []).map((s) => s.label)).size,
      },
    },
    revalidate
  );
}

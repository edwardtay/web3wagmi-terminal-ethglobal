import "server-only";
import { getJson } from "./http";

// Open interest across the venues that publish it, in dollars.
//
// The board read Binance alone while the funding column beside it already
// carried two venues, which made open interest the one number on the row that
// quietly meant something narrower than the row did. Four venues is not four
// times the work: Bybit and OKX each publish every instrument in a single
// request, so the whole board costs two calls rather than one per asset.
//
// Dollars rather than contracts, deliberately, and only for the cross-venue
// comparison. A contract is a different size on every venue and some list a
// 1000x wrapper for the small caps, so contract counts cannot be added across
// venues without a conversion table that would be wrong the week it was
// written. Notional is directly comparable.
//
// Direction still comes from contracts, on the venue that publishes a history
// for them. Notional rises with price, so a change in dollars cannot separate
// new positions from the repricing of old ones, and that reading stays on the
// Binance contract series where it has always been.

const BYBIT = "https://api.bybit.com/v5/market/tickers?category=linear";
const OKX = "https://www.okx.com/api/v5/public/open-interest?instType=SWAP";

export interface VenueOi {
  /** Notional, in dollars. */
  usd: number;
  venue: string;
}

interface BybitReply {
  result?: { list?: { symbol: string; openInterestValue?: string }[] };
}
interface OkxReply {
  data?: { instId: string; oiUsd?: string }[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Bybit and OKX open interest, keyed by base asset.
 *
 * Keyed by base rather than by each venue's instrument name, because those
 * disagree: Binance and Bybit say BTCUSDT, OKX says BTC-USDT-SWAP, and the
 * small caps carry a 1000x prefix on some venues and not others. The base is
 * the only thing all of them agree on.
 */
export async function venueOpenInterest(revalidate: number): Promise<Map<string, VenueOi[]>> {
  const [bybit, okx] = await Promise.all([
    getJson<BybitReply>(BYBIT, { revalidate, timeout: 20_000 }),
    getJson<OkxReply>(OKX, { revalidate, timeout: 20_000 }),
  ]);

  const out = new Map<string, VenueOi[]>();
  const add = (base: string, venue: string, usd: number | null) => {
    if (!base || usd == null) return;
    const list = out.get(base) ?? [];
    // One entry per venue. A 1000x wrapper and its plain contract are the same
    // exposure counted twice, and both map to the same base.
    if (list.some((v) => v.venue === venue)) return;
    list.push({ venue, usd });
    out.set(base, list);
  };

  /** BTCUSDT and 1000PEPEUSDT both reduce to their base asset. */
  const fromUsdt = (sym: string): string => {
    if (!sym.endsWith("USDT")) return "";
    const base = sym.slice(0, -4);
    return base.startsWith("1000") ? base.slice(4) : base;
  };

  for (const r of bybit?.result?.list ?? []) {
    add(fromUsdt(r.symbol), "Bybit", num(r.openInterestValue));
  }
  for (const r of okx?.data ?? []) {
    const [base, quote, kind] = r.instId.split("-");
    if (quote !== "USDT" || kind !== "SWAP") continue;
    add(base.startsWith("1000") ? base.slice(4) : base, "OKX", num(r.oiUsd));
  }
  return out;
}

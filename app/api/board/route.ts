import { allTickers24h } from "@/lib/binance";
import { jsonResponse } from "@/lib/http";
import { ASSETS } from "@/lib/symbols";

// REST seed for the live board. The socket needs a second or two to hand over
// its first frame for every pair, so the board renders server-warm from the
// 24h ticker and the stream overwrites row by row as ticks arrive.

export const revalidate = 30;

export interface BoardRow {
  sym: string;
  name: string;
  sector: string;
  pair: string;
  last: number;
  changePct: number;
  quoteVol: number;
  high: number;
  low: number;
  open: number;
  trades: number;
}

export async function GET() {
  // One call returns all 3600+ spot symbols, which is cheaper than 27 calls.
  const all = await allTickers24h(revalidate);
  if (!all || !Array.isArray(all)) {
    return jsonResponse({ ok: false, rows: [], asOf: new Date().toISOString() }, revalidate);
  }

  const by = new Map(all.map((t) => [t.symbol, t]));
  const rows: BoardRow[] = [];
  for (const a of ASSETS) {
    const t = by.get(a.pair);
    if (!t) continue;
    const last = Number(t.lastPrice);
    if (!Number.isFinite(last)) continue;
    rows.push({
      sym: a.sym,
      name: a.name,
      sector: a.sector,
      pair: a.pair,
      last,
      changePct: Number(t.priceChangePercent),
      quoteVol: Number(t.quoteVolume),
      high: Number(t.highPrice),
      low: Number(t.lowPrice),
      // Ticker24h does not carry openPrice, so back it out of last and the
      // 24h percent change. Only used for the range gauge, so exactness is fine.
      open: last / (1 + Number(t.priceChangePercent) / 100),
      trades: Number(t.count) || 0,
    });
  }

  return jsonResponse({ ok: rows.length > 0, rows, asOf: new Date().toISOString() }, revalidate);
}

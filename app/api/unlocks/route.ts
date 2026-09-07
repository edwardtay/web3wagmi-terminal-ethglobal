import { getJson, jsonResponse } from "@/lib/http";

// api.llama.fi/emissions and /emissionsBreakdown both answer 402 on the free
// tier now. The dataset bucket behind the public unlocks page is still open,
// so that is the source: one ~21MB index covering every tracked token.
export const revalidate = 900;

const SRC = "https://defillama-datasets.llama.fi/emissionsIndex";

const HORIZON_DAYS = 60;
// Sub-$100k unlocks are noise on a calendar and there are hundreds of them.
const MIN_USD = 100_000;
// Roughly 125 token-days clear $100k over a 60-day window, so this cap is a
// guard against a bad upstream day rather than a real trim of the calendar.
const MAX_ROWS = 150;

interface CliffAllocation {
  recipient?: string;
  category?: string;
  amount?: number;
}

interface UnlockEvent {
  timestamp?: number;
  cliffAllocations?: CliffAllocation[];
  // Linear entries describe a change in emission rate per week rather than a
  // quantity, so they are deliberately not counted as an unlock amount.
  summary?: { totalTokensCliff?: number };
}

interface IndexEntry {
  name?: string;
  protocolSlug?: string;
  circSupply?: number;
  mcap?: number;
  tokenPrice?: { price?: number; symbol?: string }[];
  unlockEvents?: UnlockEvent[];
}

export interface UnlockRow {
  date: string; // YYYY-MM-DD, UTC
  daysAway: number;
  name: string;
  symbol: string;
  tokens: number;
  usd: number;
  mcap: number | null;
  pctOfMcap: number | null;
  /** Recipient buckets driving the unlock, largest first. */
  recipients: string[];
}

export interface UnlocksPayload {
  ok: boolean;
  asOf: string;
  horizonDays: number;
  rows: UnlockRow[];
  totalUsd: number;
  heavyCount: number; // rows above 1% of circulating market cap
}

const DAY = 86_400_000;

/** UTC calendar day key, because unlocks are scheduled in UTC. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function GET() {
  const doc = await getJson<{ data?: IndexEntry[] }>(SRC, { revalidate, timeout: 25_000 });
  const entries = doc?.data;

  const empty: UnlocksPayload = {
    ok: false,
    asOf: new Date().toISOString(),
    horizonDays: HORIZON_DAYS,
    rows: [],
    totalUsd: 0,
    heavyCount: 0,
  };
  if (!Array.isArray(entries)) return jsonResponse(empty, 60);

  const now = Date.now();
  const end = now + HORIZON_DAYS * DAY;
  const today = Date.parse(`${dayKey(now)}T00:00:00Z`);

  // One token can post several cliffs on the same day (separate recipient
  // tranches). Traders read the day, so collapse them into one calendar row.
  const byTokenDay = new Map<string, UnlockRow>();

  for (const e of entries) {
    const tp = e.tokenPrice?.[0];
    const price = tp?.price;
    const symbol = tp?.symbol;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    if (!symbol || !e.name) continue;

    for (const ev of e.unlockEvents ?? []) {
      const ts = ev.timestamp;
      if (typeof ts !== "number") continue;
      const ms = ts * 1000;
      if (ms < now || ms > end) continue;
      const tokens = ev.summary?.totalTokensCliff;
      if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;

      const day = dayKey(ms);
      const key = `${e.protocolSlug ?? e.name}|${day}`;
      const row = byTokenDay.get(key);
      const mcap = typeof e.mcap === "number" && Number.isFinite(e.mcap) && e.mcap > 0 ? e.mcap : null;
      const target: UnlockRow =
        row ??
        {
          date: day,
          // Counted in calendar days so two events on the same date never read
          // as different distances.
          daysAway: Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - today) / DAY)),
          name: e.name,
          symbol,
          tokens: 0,
          usd: 0,
          mcap,
          pctOfMcap: null,
          recipients: [],
        };
      target.tokens += tokens;
      target.usd += tokens * price;
      for (const a of ev.cliffAllocations ?? []) {
        const r = a.recipient;
        if (r && !target.recipients.includes(r)) target.recipients.push(r);
      }
      byTokenDay.set(key, target);
    }
  }

  const rows = [...byTokenDay.values()]
    .filter((r) => r.usd >= MIN_USD)
    .map((r) => ({ ...r, pctOfMcap: r.mcap ? (r.usd / r.mcap) * 100 : null }))
    .sort((a, b) => (a.date === b.date ? b.usd - a.usd : a.date < b.date ? -1 : 1))
    .slice(0, MAX_ROWS);

  const payload: UnlocksPayload = {
    ok: rows.length > 0,
    asOf: new Date().toISOString(),
    horizonDays: HORIZON_DAYS,
    rows,
    totalUsd: rows.reduce((s, r) => s + r.usd, 0),
    heavyCount: rows.filter((r) => (r.pctOfMcap ?? 0) >= 1).length,
  };

  return jsonResponse(payload, revalidate);
}

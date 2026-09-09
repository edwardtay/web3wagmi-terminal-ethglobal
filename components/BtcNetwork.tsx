"use client";

import { useApi } from "@/lib/useApi";
import { AsOf, ChangeChip, Loading, Panel, TokenIcon, Unavailable } from "@/components/ui";
import { compact, num, usd, duration, NA } from "@/lib/format";

// Bitcoin transaction cost and the state of the network behind it: what the
// mempool is holding, what the hashrate and difficulty are doing, and how far
// the next halving is.

interface BtcData {
  ok: boolean;
  btcUsd: number;
  vbytes: number;
  fees: { fastest: number; halfHour: number; hour: number; economy: number; minimum: number };
  mempool: { count: number; vsize: number; totalFeeSats: number; blocksDeep: number };
  hashrate: number;
  difficulty: number;
  difficultyChange: number | null;
  previousRetarget: number | null;
  retargetBlocks: number | null;
  retargetDate: string | null;
  tipHeight: number;
  halvingHeight: number;
  halvingBlocksLeft: number;
  halvingDate: string | null;
  halvingProgress: number;
}

interface GasPayload {
  ok: boolean;
  asOf: string;
  btc: BtcData | null;
}


function fiat(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return NA;
  return n < 1 ? `$${n.toFixed(3)}` : usd(n);
}

function dateLabel(iso: string | null): string {
  if (!iso) return NA;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NA;
  return new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function BtcNetwork() {
  const { data, loading, failed } = useApi<GasPayload>("/api/gas", 60);
  const b = data?.btc ?? null;

  const tiers = b
    ? [
        { label: "fastest", sub: "next block", rate: b.fees.fastest, color: "var(--neg)" },
        { label: "30 min", sub: "~3 blocks", rate: b.fees.halfHour, color: "var(--accent)" },
        { label: "1 hour", sub: "~6 blocks", rate: b.fees.hour, color: "var(--cyan)" },
        { label: "economy", sub: "no hurry", rate: b.fees.economy, color: "var(--pos)" },
      ]
    : [];
  const maxRate = tiers.reduce((m, t) => Math.max(m, t.rate), 0);
  const feeUsd = (rate: number) => (b ? ((rate * b.vbytes) / 1e8) * b.btcUsd : 0);

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <TokenIcon sym="BTC" size={14} />
          Bitcoin network
        </span>
      }
      right={<AsOf iso={data?.asOf} staleMs={15 * 60 * 1000} />}
    >
      {loading ? (
        <Loading rows={5} />
      ) : failed || !b || !b.ok ? (
        <Unavailable what="Bitcoin network data" />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-[var(--text3)]">
            <span>fee rate, sat/vB</span>
            <span>·</span>
            <span>cost shown for a {b.vbytes} vB transaction at {usd(b.btcUsd)}/BTC</span>
          </div>

          {/* One row per tier, not a grid of boxes.
              These are four points on a single scale, cheapest to fastest, and
              a two by two grid of cards broke that order into a shape with no
              reading direction: the bars could not be compared because they sat
              in different columns, which is the only thing a bar is for. */}
          <div className="divide-y divide-[var(--border2)] rounded-lg border border-[var(--border)]">
            {tiers.map((t) => (
              <div key={t.label} className="flex items-center gap-3 px-2.5 py-2">
                <div className="w-[92px] shrink-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">{t.label}</div>
                  <div className="font-mono text-[10px] text-[var(--text3)]">{t.sub}</div>
                </div>
                <div className="flex w-[74px] shrink-0 items-baseline gap-1">
                  <span className="whitespace-nowrap font-mono text-[15px] font-bold" style={{ color: t.color }}>
                    {num(t.rate, 0)}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text3)]">sat/vB</span>
                </div>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${maxRate > 0 ? Math.max(2, (t.rate / maxRate) * 100) : 0}%`, background: t.color }}
                  />
                </div>
                <div className="w-[62px] shrink-0 whitespace-nowrap text-right font-mono text-[12px] font-semibold text-[var(--text)]">
                  {fiat(feeUsd(t.rate))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {/* Backlog */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-3">
              <div className="panel-h font-display text-[10px] font-bold uppercase tracking-[0.09em]">Mempool backlog</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--text)]">
                  {b.mempool.blocksDeep.toFixed(1)}
                </span>
                <span className="font-mono text-[11px] text-[var(--text3)]">blocks deep</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    // Past roughly a dozen blocks the queue is congested enough
                    // that low-fee spends wait hours, so cap the bar there.
                    width: `${Math.min(100, (b.mempool.blocksDeep / 12) * 100)}%`,
                    background:
                      b.mempool.blocksDeep > 6 ? "var(--neg)" : b.mempool.blocksDeep > 2 ? "var(--accent)" : "var(--pos)",
                  }}
                />
              </div>
              <dl className="mt-2 space-y-1 font-mono text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">unconfirmed tx</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">{num(b.mempool.count, 0)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">total vsize</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">{compact(b.mempool.vsize, 1)} vB</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">fees waiting</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {fiat((b.mempool.totalFeeSats / 1e8) * b.btcUsd)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">clear time at 10 min/block</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {duration(b.mempool.blocksDeep * 10 * 60 * 1000)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Hashrate and difficulty */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-3">
              <div className="flex items-center gap-1.5">
                <span className="panel-h font-display text-[10px] font-bold uppercase tracking-[0.09em]">
                  Hashrate &amp; difficulty
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--text)]">
                  {b.hashrate > 0 ? num(b.hashrate / 1e18, 1) : NA}
                </span>
                <span className="font-mono text-[11px] text-[var(--text3)]" title="exahashes per second">
                  EH/s
                </span>
              </div>
              <dl className="mt-2 space-y-1 font-mono text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">difficulty</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {b.difficulty > 0 ? compact(b.difficulty, 2) : NA}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">last adjustment</dt>
                  <dd className="whitespace-nowrap">
                    <ChangeChip value={b.previousRetarget} />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">next, projected</dt>
                  <dd className="whitespace-nowrap">
                    <ChangeChip value={b.difficultyChange} />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">retarget in</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {b.retargetBlocks != null ? `${num(b.retargetBlocks, 0)} blocks` : NA}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">retarget date</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">{dateLabel(b.retargetDate)}</dd>
                </div>
              </dl>
            </div>

            {/* Halving */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-3">
              <div className="flex items-center gap-1.5">
                <span className="panel-h font-display text-[10px] font-bold uppercase tracking-[0.09em]">
                  Halving countdown
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--gold)]">
                  {b.tipHeight > 0 ? num(b.halvingBlocksLeft, 0) : NA}
                </span>
                <span className="font-mono text-[11px] text-[var(--text3)]">blocks to go</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, Math.max(0, b.halvingProgress))}%`, background: "var(--gold)" }}
                />
              </div>
              <dl className="mt-2 space-y-1 font-mono text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">epoch progress</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {b.tipHeight > 0 ? `${b.halvingProgress.toFixed(1)}%` : NA}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">block height now</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {b.tipHeight > 0 ? num(b.tipHeight, 0) : NA}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">halving at block</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">
                    {b.halvingHeight > 0 ? num(b.halvingHeight, 0) : NA}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-[var(--text3)]">estimated date</dt>
                  <dd className="whitespace-nowrap text-[var(--text2)]">{dateLabel(b.halvingDate)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

"use client";

import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { AsOf, ChangeChip, Loading, LivePill, Meter, Panel, Section, Sparkline, Unavailable } from "@/components/ui";
import { pct, pctPlain, price, signColor, usd, usdCompact } from "@/lib/format";
import type { SnapTile, SnapshotPayload } from "@/app/api/snapshot/route";

const API = "/api/snapshot";
const POLL = 30;

/** The band the Fear and Greed index falls in, and the colour that reads it. */
function fngZone(v: number): { label: string; color: string } {
  if (v < 25) return { label: "Extreme fear", color: "var(--neg)" };
  if (v < 45) return { label: "Fear", color: "var(--neg)" };
  if (v <= 55) return { label: "Neutral", color: "var(--gold)" };
  if (v <= 74) return { label: "Greed", color: "var(--pos)" };
  return { label: "Extreme greed", color: "var(--pos)" };
}




/* ------------------------------------------------------------------ tape -- */

/**
 * The scrolling strip. Content is rendered twice inside .tape-track because
 * the keyframe translates by exactly -50%, so the second copy lands where the
 * first started and the loop has no visible seam.
 */
export function Tape() {
  const { data, loading, failed } = useApi<SnapshotPayload>(API, POLL);

  if (loading) {
    return (
      <div className="border-y border-[var(--border)] bg-[var(--bg2)] px-3 py-2">
        <Loading rows={1} />
      </div>
    );
  }
  if (failed || !data?.ok || data.headline.length === 0) {
    return (
      <div className="border-y border-[var(--border)] bg-[var(--bg2)] px-3">
        <Unavailable what="The market tape" />
      </div>
    );
  }

  const items: React.ReactNode[] = data.headline.map((t) => (
    <TapeQuote key={t.sym} sym={t.sym} last={t.last} chg={t.chg24} />
  ));

  if (data.global) {
    items.push(
      <TapeStat key="mcap" label="TOTAL MCAP" value={usdCompact(data.global.mcap)} chg={data.global.mcapChg24} />
    );
    items.push(<TapeStat key="dom" label="BTC DOM" value={pctPlain(data.global.btcDom)} />);
    if (data.global.ethBtc != null) {
      // Rendered as a stat rather than a quote: ETH/BTC is a cross rate with no
      // /s/[symbol] page behind it, so linking it would dead end on a 404.
      items.push(
        <TapeStat
          key="ethbtc"
          label="ETH/BTC"
          value={price(data.global.ethBtc)}
          chg={data.global.ethBtcChg24 ?? 0}
        />
      );
    }
  }
  if (data.fng) {
    const z = fngZone(data.fng.value);
    items.push(
      <span key="fng" className="inline-flex items-baseline gap-1.5 px-4 font-mono text-[11px]">
        <span className="text-[var(--text3)]">FEAR / GREED</span>
        <span className="font-semibold" style={{ color: z.color }}>
          {data.fng.value} {z.label}
        </span>
      </span>
    );
  }

  return (
    <div className="relative overflow-hidden border-y border-[var(--border)] bg-[var(--bg2)] py-2" aria-label="Market ticker tape">
      <div className="tape-track">
        <span className="inline-flex items-center">{items}</span>
        <span className="inline-flex items-center" aria-hidden>
          {items}
        </span>
      </div>
    </div>
  );
}

function TapeQuote({ sym, last, chg, unit = "$" }: { sym: string; last: number; chg: number; unit?: string }) {
  return (
    <Link
      href={`/s/${sym.replace("/", "")}`}
      className="inline-flex items-baseline gap-1.5 px-4 font-mono text-[11px] hover:opacity-80"
    >
      <span className="font-semibold text-[var(--text)]">{sym}</span>
      <span className="text-[var(--text2)]">
        {unit}
        {price(last)}
      </span>
      <span className="font-semibold" style={{ color: signColor(chg) }}>
        {pct(chg)}
      </span>
    </Link>
  );
}

function TapeStat({ label, value, chg }: { label: string; value: string; chg?: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 px-4 font-mono text-[11px]">
      <span className="text-[var(--text3)]">{label}</span>
      <span className="font-semibold text-[var(--text)]">{value}</span>
      {chg != null && (
        <span className="font-semibold" style={{ color: signColor(chg) }}>
          {pct(chg)}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------- snapshot -- */

export function Snapshot() {
  const { data, loading, failed } = useApi<SnapshotPayload>(API, POLL);

  return (
    <Section
      title="Market Snapshot"
      id="snapshot"
      right={
        <>
          <LivePill live={!failed} label={failed ? "stale" : "30s"} />
          <AsOf iso={data?.asOf} />
        </>
      }
    >
      {loading ? (
        <Loading rows={6} />
      ) : failed || !data?.ok || data.headline.length === 0 ? (
        <div className="card p-4">
          <Unavailable what="The market snapshot" />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {data.headline.map((t) => (
              <AssetTile key={t.sym} t={t} />
            ))}
          </div>
          <GlobalRow data={data} />
        </div>
      )}
    </Section>
  );
}

function AssetTile({ t }: { t: SnapTile }) {
  const up = t.chg24 >= 0;
  return (
    <Link href={`/s/${t.sym}`} className="card block min-w-0 p-3 no-underline">
      <div className="flex min-w-0 items-start justify-between gap-1.5">
        <div className="min-w-0">
          <div className="font-display text-sm font-bold leading-tight text-[var(--text)] break-words">{t.sym}</div>
          <div className="text-[10px] leading-tight text-[var(--text3)] break-words">{t.name}</div>
        </div>
        <ChangeChip value={t.chg24} />
      </div>

      <div className="mt-2 whitespace-nowrap font-mono text-[15px] font-semibold text-[var(--text)]">{usd(t.last)}</div>

      <div className="mt-2 [&>svg]:w-full">
        <Sparkline data={t.spark} up={up} width={160} height={32} />
      </div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-[var(--text3)]">72h hourly</div>

      <RangeBar low={t.low24} high={t.high24} pos={t.rangePos} />

      <div className="mt-2 flex items-baseline justify-between gap-2 font-mono text-[10px] text-[var(--text3)]">
        <span>24h vol</span>
        <span className="whitespace-nowrap text-[var(--text2)]">{usdCompact(t.quoteVol)}</span>
      </div>
    </Link>
  );
}

/** Where the last trade sits between the 24h low and high. */
function RangeBar({ low, high, pos }: { low: number; high: number; pos: number | null }) {
  return (
    <div className="mt-2.5">
      <div className="relative h-1.5 w-full rounded-full bg-[var(--surface2)]">
        {pos != null && (
          <span
            className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]"
            style={{ left: `${pos * 100}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[9px] text-[var(--text3)]">
        <span className="whitespace-nowrap" title="24 hour low">
          L {price(low)}
        </span>
        <span className="whitespace-nowrap" title="24 hour high">
          H {price(high)}
        </span>
      </div>
    </div>
  );
}

function GlobalRow({ data }: { data: SnapshotPayload }) {
  const g = data.global;
  const f = data.fng;
  if (!g && !f) {
    return (
      <div className="card p-4">
        <Unavailable what="Global market stats" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Panel title="Total market cap">
        {g ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--text)]">
                {usdCompact(g.mcap)}
              </span>
              <ChangeChip value={g.mcapChg24} />
            </div>
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px]">
              <div>
                <dt className="uppercase tracking-wide text-[var(--text3)]">24h volume</dt>
                <dd className="font-semibold text-[var(--text2)]">{usdCompact(g.vol24)}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide text-[var(--text3)]">stables</dt>
                <dd className="font-semibold text-[var(--text2)]">{pctPlain(g.stableDom)} of cap</dd>
              </div>
            </dl>
          </>
        ) : (
          <Unavailable what="Market cap" />
        )}
      </Panel>

      <Panel title="BTC dominance">
        {g ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="whitespace-nowrap font-mono text-xl font-bold text-[var(--text)]">
                {pctPlain(g.btcDom, 2)}
              </span>
              <span className="font-mono text-[11px] text-[var(--text3)]">ETH {pctPlain(g.ethDom, 2)}</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
              <div className="flex h-full">
                <div style={{ width: `${g.btcDom}%`, background: "var(--btc)" }} />
                <div style={{ width: `${g.ethDom}%`, background: "var(--eth)" }} />
              </div>
            </div>
            {/* The bar already shows the split, so it needs a key rather than a
                sentence describing it. */}
            <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: "var(--btc)" }} />
                <dt className="text-[var(--text3)]">BTC</dt>
                <dd className="font-semibold text-[var(--text2)]">{pctPlain(g.btcDom, 1)}</dd>
              </div>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: "var(--eth)" }} />
                <dt className="text-[var(--text3)]">ETH</dt>
                <dd className="font-semibold text-[var(--text2)]">{pctPlain(g.ethDom, 1)}</dd>
              </div>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-sm bg-[var(--surface2)]" />
                <dt className="text-[var(--text3)]">rest</dt>
                <dd className="font-semibold text-[var(--text2)]">
                  {pctPlain(Math.max(0, 100 - g.btcDom - g.ethDom), 1)}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <Unavailable what="Dominance" />
        )}
      </Panel>


      <Panel
        title="Fear and Greed"
      >
        {f ? (
          <>
            <Meter label={fngZone(f.value).label} score={f.value} color={fngZone(f.value).color} />
            <div className="mt-2 [&>svg]:w-full">
              <Sparkline data={f.series.map((p) => p.v)} width={220} height={30} stroke="var(--cyan)" />
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                30 day series
              </div>
            </div>
            {/* Label above, figure below, matching the other snapshot cards.
                Run together on one line these three read as a sentence and have
                to be parsed; stacked they can be scanned. "30d series" was also
                a caption for the chart pretending to be a data point, so it has
                moved onto the chart. */}
            <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px]">
              <div>
                <dt className="uppercase tracking-wide text-[var(--text3)]">yesterday</dt>
                <dd className="font-semibold text-[var(--text2)]">{f.yesterday ?? "n/a"}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide text-[var(--text3)]">7 days ago</dt>
                <dd className="font-semibold text-[var(--text2)]">{f.lastWeek ?? "n/a"}</dd>
              </div>
            </dl>
          </>
        ) : (
          <Unavailable what="Fear and Greed" />
        )}
      </Panel>
    </div>
  );
}

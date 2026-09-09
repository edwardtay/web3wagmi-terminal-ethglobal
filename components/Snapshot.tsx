"use client";

import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { Composites } from "./Composites";
import { brandColor } from "@/lib/brandColors";
import { AsOf, ChangeChip, Loading, LivePill, Meter, Panel, Section, Sparkline, Unavailable } from "@/components/ui";
import { pct, pctPlain, price, signColor, usdCompact } from "@/lib/format";
import type { SnapshotPayload } from "@/app/api/snapshot/route";

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



/**
 * Fear and Greed as a dial.
 *
 * It was a horizontal meter with yesterday and last week printed underneath as
 * two loose numbers. A dial is the right shape for this one reading: the index
 * is a position on a fixed nought to a hundred scale with named zones, which is
 * exactly what a car's instrument shows, and the zones can be coloured on the
 * arc itself rather than described in a legend.
 *
 * Yesterday and last week become ticks on the same arc. As figures underneath
 * they were two numbers a reader had to hold in their head to compare; on the
 * dial the comparison is the distance between the needle and the tick, which is
 * the comparison being asked for.
 */
const FNG_ZONES: { to: number; color: string; label: string }[] = [
  { to: 25, color: "var(--neg)", label: "Extreme fear" },
  { to: 45, color: "color-mix(in srgb, var(--neg) 55%, var(--surface))", label: "Fear" },
  { to: 55, color: "var(--gold)", label: "Neutral" },
  { to: 74, color: "color-mix(in srgb, var(--pos) 55%, var(--surface))", label: "Greed" },
  { to: 100, color: "var(--pos)", label: "Extreme greed" },
];

function FngGauge({ value, yesterday, lastWeek }: { value: number; yesterday?: number | null; lastWeek?: number | null }) {
  const W = 220;
  const H = 124;
  const cx = W / 2;
  const cy = 112;
  const r = 86;
  // Nought sits at nine o'clock and a hundred at three, so the needle sweeps
  // the way a reader expects a dial to run.
  const angle = (v: number) => Math.PI * (1 - Math.min(100, Math.max(0, v)) / 100);
  const at = (v: number, radius: number) => [cx + radius * Math.cos(angle(v)), cy - radius * Math.sin(angle(v))];

  const arc = (from: number, to: number) => {
    const [x1, y1] = at(from, r);
    const [x2, y2] = at(to, r);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };

  const [nx, ny] = at(value, r - 16);
  const zone = fngZone(value);

  const tick = (v: number | null | undefined, key: string, label: string) => {
    if (v == null || !Number.isFinite(v)) return null;
    const [x1, y1] = at(v, r - 9);
    const [x2, y2] = at(v, r + 7);
    return (
      <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text3)" strokeWidth="1.5">
        <title>{`${label}: ${v}`}</title>
      </line>
    );
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ height: "auto" }} role="img"
           aria-label={`Fear and Greed index ${value}, ${zone.label}`}>
        {FNG_ZONES.map((z, i) => (
          <path
            key={z.label}
            d={arc(i === 0 ? 0 : FNG_ZONES[i - 1].to, z.to)}
            fill="none"
            stroke={z.color}
            strokeWidth="11"
            strokeLinecap="butt"
          />
        ))}
        {tick(yesterday, "y", "Yesterday")}
        {tick(lastWeek, "w", "7 days ago")}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4.5" fill="var(--text)" />
        <text x={cx} y={cy - 30} textAnchor="middle" className="font-mono"
              style={{ fontSize: 26, fontWeight: 700, fill: zone.color }}>
          {value}
        </text>
        <text x={cx} y={cy - 14} textAnchor="middle"
              style={{ fontSize: 10, fill: "var(--text3)", textTransform: "uppercase" }}>
          {zone.label}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text3)]">
        <span>0 extreme fear</span>
        <span className="ml-auto">100 extreme greed</span>
      </div>
      {(yesterday != null || lastWeek != null) && (
        <div className="mt-1 font-mono text-[10px] text-[var(--text3)]">
          ticks: yesterday {yesterday ?? "n/a"}, 7 days ago {lastWeek ?? "n/a"}
        </div>
      )}
    </div>
  );
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
          {/* "live", not "30s". The stamp beside it already says 29s ago, and
              two similar numbers next to each other read as the same fact
              stated twice rather than as a cadence and an age. */}
          <LivePill live={!failed} label={failed ? "stale" : "live"} />
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
          {/* Composites rather than six price tiles.
              Six of twenty seven tracked assets is an arbitrary sample that
              answers nothing about the other twenty one, and a reader who
              wants the BTC price has it in the tape above, on the focus strip,
              and on every other site they have open. What none of those give
              is whether this move is broad, whether the market is paying for
              risk beyond the majors, and how much leverage is behind it. */}
          {/* The two readings a person looks for first, before the composites.
              Total market cap and Fear and Greed are what a reader arrives
              wanting; the breadth and correlation numbers are what they stay
              for. Putting the composites above them made the first screen open
              on the least familiar thing on the page. */}
          <GlobalRow data={data} />
          <Composites />
        </div>
      )}
    </Section>
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
                {/* The projects' own marks, as every other share bar here now
                    uses. The --btc and --eth tokens are darkened for legibility
                    as text on a light page, which is right for a number and
                    wrong for a fill: a bar is the one place the actual brand
                    colour carries information. */}
                <div style={{ width: `${g.btcDom}%`, background: brandColor("bitcoin") ?? "var(--btc)" }} />
                <div style={{ width: `${g.ethDom}%`, background: brandColor("ethereum") ?? "var(--eth)" }} />
              </div>
            </div>
            {/* The bar already shows the split, so it needs a key rather than a
                sentence describing it. */}
            <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: brandColor("bitcoin") ?? "var(--btc)" }} />
                <dt className="text-[var(--text3)]">BTC</dt>
                <dd className="font-semibold text-[var(--text2)]">{pctPlain(g.btcDom, 1)}</dd>
              </div>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: brandColor("ethereum") ?? "var(--eth)" }} />
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
            <FngGauge value={f.value} yesterday={f.yesterday} lastWeek={f.lastWeek} />
            <div className="mt-2 [&>svg]:w-full">
              <Sparkline data={f.series.map((p) => p.v)} width={220} height={30} stroke="var(--cyan)" />
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                30 day series
              </div>
            </div>
          </>
        ) : (
          <Unavailable what="Fear and Greed" />
        )}
      </Panel>
    </div>
  );
}

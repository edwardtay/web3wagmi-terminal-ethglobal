"use client";

import { useEffect, useMemo, useState } from "react";
import type { Desk, ExpiryRow, OptionsPayload, PainRow } from "@/app/api/options/route";
import {
  AsOf,
  BarCell,
  InfoHint,
  Loading,
  Panel,
  Section,
  Segmented,
  Sparkline,
  TableWrap,
  Unavailable,
} from "@/components/ui";
import { compact, num, pct, pctPlain, usd, usdCompact, NA } from "@/lib/format";
import { useSymbol } from "@/lib/useSymbol";
import { useApi } from "@/lib/useApi";

const CCY = ["BTC", "ETH"] as const;
type Ccy = (typeof CCY)[number];


/** Short expiry label: "31JUL26" reads as "31 Jul 26". */
function label(code: string): string {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code);
  if (!m) return code;
  return `${m[1]} ${m[2][0]}${m[2].slice(1).toLowerCase()} ${m[3]}`;
}

function dteLabel(d: number): string {
  if (d < 1) return `${Math.max(0, Math.round(d * 24))}h`;
  return `${Math.round(d)}d`;
}

/* --------------------------------------------------------------- term curve */

/** ATM implied vol against days to expiry. Even x spacing keeps the far-dated
 *  expiries legible instead of crushing the front of the curve. */
function TermCurve({ rows }: { rows: ExpiryRow[] }) {
  const pts = rows.filter((r) => r.atmIv != null);
  if (pts.length < 2) return <Unavailable what="The term structure" />;
  const W = 320;
  const H = 132;
  const padL = 30;
  const padB = 20;
  const padT = 10;
  const ivs = pts.map((p) => p.atmIv as number);
  const lo = Math.min(...ivs);
  const hi = Math.max(...ivs);
  const span = hi - lo || 1;
  const yLo = lo - span * 0.25;
  const yHi = hi + span * 0.25;
  const x = (i: number) => padL + (i * (W - padL - 6)) / (pts.length - 1);
  const y = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo)) * (H - padT - padB);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.atmIv as number).toFixed(1)}`).join(" ");

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[132px] w-full" role="img" aria-label="ATM implied volatility by expiry">
        {[yHi, (yHi + yLo) / 2, yLo].map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={W - 4} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="0.6" />
            <text x={2} y={y(v) + 3} fontSize="8" fill="var(--text3)" fontFamily="monospace">
              {v.toFixed(0)}%
            </text>
          </g>
        ))}
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle
            key={p.code}
            cx={x(i)}
            cy={y(p.atmIv as number)}
            r={p.quarterly ? 3.2 : 2.1}
            fill={p.quarterly ? "var(--violet)" : "var(--accent)"}
          >
            <title>{`${label(p.code)} · ${dteLabel(p.dte)} · ATM IV ${(p.atmIv as number).toFixed(2)}%`}</title>
          </circle>
        ))}
        {pts.map((p, i) =>
          i === 0 || i === pts.length - 1 || (pts.length > 4 && i === Math.floor(pts.length / 2)) ? (
            <text
              key={`l${p.code}`}
              x={x(i)}
              y={H - 6}
              fontSize="8"
              fill="var(--text3)"
              fontFamily="monospace"
              textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}
            >
              {dteLabel(p.dte)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------- skew bar --- */

/** Centre-zero bar: left of centre is put-bid (negative skew). */
function SkewBar({ value, max }: { value: number | null; max: number }) {
  if (value == null || max <= 0) return <div className="h-1.5 w-full rounded-full bg-[var(--surface2)]" />;
  const w = Math.min(50, (Math.abs(value) / max) * 50);
  const neg = value < 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
      <div
        className="absolute top-0 h-full"
        style={{
          width: `${w}%`,
          left: neg ? `${50 - w}%` : "50%",
          background: neg ? "var(--neg)" : "var(--pos)",
          borderRadius: 9999,
        }}
      />
      <div className="absolute left-1/2 top-0 h-full w-px" style={{ background: "var(--border)" }} />
    </div>
  );
}

/* -------------------------------------------------------------- max pain --- */

function PainChart({ row, index }: { row: PainRow; index: number | null }) {
  const curve = row.curve;
  if (!curve.length || row.maxPain == null) return <Unavailable what="Max pain" />;
  const max = Math.max(...curve.map((c) => c.usd)) || 1;
  return (
    <div className="mt-2">
      <div className="flex h-16 items-end gap-[2px]">
        {curve.map((c) => {
          const isPain = c.k === row.maxPain;
          const nearSpot =
            index != null &&
            Math.abs(c.k - index) === Math.min(...curve.map((d) => Math.abs(d.k - (index as number))));
          return (
            <div
              key={c.k}
              className="min-w-0 flex-1 rounded-t-[2px]"
              style={{
                height: `${Math.max(3, (c.usd / max) * 100)}%`,
                background: isPain ? "var(--gold)" : nearSpot ? "var(--cyan)" : "var(--surface2)",
              }}
              title={`Strike ${num(c.k, 0)} · total in-the-money value ${usdCompact(c.usd)}`}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text3)]">
        <span className="whitespace-nowrap">
          <span className="mr-1 inline-block h-2 w-2 rounded-[2px] align-middle" style={{ background: "var(--gold)" }} />
          max pain
        </span>
        <span className="whitespace-nowrap">
          <span className="mr-1 inline-block h-2 w-2 rounded-[2px] align-middle" style={{ background: "var(--cyan)" }} />
          spot
        </span>
        <span className="whitespace-nowrap">{curve.length} strikes around spot</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ stats -- */

function Stat({
  k,
  v,
  sub,
  color,
  hint,
}: {
  k: string;
  v: string;
  sub?: string;
  color?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text3)]">{k}</span>
      </div>
      <div className="mt-1 font-mono text-base font-bold leading-tight" style={{ color: color ?? "var(--text)" }}>
        {v}
      </div>
      {sub && <div className="mt-0.5 break-words text-[10px] leading-snug text-[var(--text3)]">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- main -- */

export function OptionsDesk() {
  const { data, loading, failed } = useApi<OptionsPayload>("/api/options", 300);
  // Deribit only lists BTC and ETH, so the desk follows the shared selection when
  // it is one of those and otherwise holds its own choice.
  const { symbol } = useSymbol();
  const [ccy, setCcy] = useState<Ccy>("BTC");
  useEffect(() => {
    if (symbol === "BTC" || symbol === "ETH") setCcy(symbol);
  }, [symbol]);

  const desk: Desk | undefined = useMemo(
    () => data?.desks?.find((d) => d.currency === ccy),
    [data, ccy]
  );

  // The desk sits in the focused instrument group but can only follow a focus
  // Deribit lists. Holding BTC while the header says OP, and saying nothing, is
  // the one thing this terminal does not do: a panel that quietly means
  // something other than its heading.
  const followsFocus = symbol === ccy;
  const hint = followsFocus
    ? undefined
    : `Focus is ${symbol}. Deribit lists options on BTC and ETH only, so this desk stays on ${ccy} rather than following it.`;

  // Whether the reader chose this currency, or is only seeing it because the
  // focused asset has no options at all.
  //
  // The hint above was the whole defence and it was not enough. Focused on XRP,
  // the desk rendered ETH's max pain at $2,480 against spot $2,471.96 under a
  // heading that named neither, directly below a header saying XRP. A reader
  // scrolling into that sees an XRP max pain of two and a half thousand
  // dollars, and every number under it is wrong by four orders of magnitude.
  //
  // A sentence at the top of a panel does not survive being scrolled past. So
  // when the focus is not listed, the desk collapses to that statement and the
  // reader opts in deliberately with the currency control, which stays.
  const [optedIn, setOptedIn] = useState(false);
  useEffect(() => {
    // Choosing a new focus withdraws the opt-in: it was consent to see one
    // asset's options, not standing permission to substitute any other.
    setOptedIn(false);
  }, [symbol]);
  const substituting = !followsFocus && !optedIn;

  const right = (
    <>
      <Segmented options={CCY} value={ccy} onChange={setCcy} ariaLabel="Options currency" />
      <AsOf iso={data?.asOf} staleMs={15 * 60 * 1000} />
    </>
  );

  if (substituting) {
    return (
      <Section title="Options Desk" id="options" right={right}>
        <div className="card p-4">
          <p className="text-[13px] leading-relaxed text-[var(--text2)]">
            No options desk for <strong className="text-[var(--text)]">{symbol}</strong>. Deribit
            lists options on BTC and ETH only, and the rest of this terminal covers {symbol}{" "}
            normally.
          </p>
          <button
            type="button"
            onClick={() => setOptedIn(true)}
            className="mt-3 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 font-mono text-[11px] font-semibold text-[var(--accent)]"
          >
            Show the {ccy} desk instead
          </button>
        </div>
      </Section>
    );
  }

  if (loading) {
    return (
      <Section title="Options Desk" id="options" hint={hint} right={right}>
        <div className="card p-4">
          <Loading rows={8} />
        </div>
      </Section>
    );
  }

  if (failed || !data?.ok || !desk?.ok) {
    return (
      <Section title="Options Desk" id="options" hint={hint} right={right}>
        <div className="card p-4">
          <Unavailable what={`The ${ccy} options desk (Deribit)`} />
        </div>
      </Section>
    );
  }

  const rows = desk.expiries;
  const maxOi = Math.max(...rows.map((r) => r.oiUsd), 1);
  const maxSkew = Math.max(...rows.map((r) => Math.abs(r.skew ?? 0)), 1);
  const front = rows[0];
  const dvol = desk.dvol;
  const shapeColor =
    desk.shape === "backwardation" ? "var(--neg)" : desk.shape === "contango" ? "var(--pos)" : "var(--text2)";
  const wings = rows.map((r) => r.skewWingPct).filter((v): v is number => v != null);
  // The 30-day tenor is the market's reference point for skew, so headline that
  // one rather than the noisy front-week contract.
  const skewed = rows.filter((r) => r.skew != null);
  const ref = skewed.length
    ? skewed.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a))
    : null;

  return (
    <Section
      title="Options Desk"
      id="options"
      hint={hint}
      right={right}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* ---------------------------------------------------------- DVOL -- */}
        <Panel
          title={`${ccy} DVOL · 30d implied vol index`}
          className="lg:col-span-1"
          right={<span className="pill text-[var(--text3)]">Deribit</span>}
        >
          {dvol ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-3xl font-bold leading-none text-[var(--text)]">
                    {dvol.last.toFixed(1)}
                    <span className="ml-1 text-sm font-semibold text-[var(--text3)]">vol</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span
                      className="whitespace-nowrap font-mono text-[11px] font-semibold"
                      style={{
                        color:
                          dvol.chg30d == null
                            ? "var(--text3)"
                            : dvol.chg30d >= 0
                              ? "var(--neg)"
                              : "var(--pos)",
                      }}
                      title="Change over the last 30 days. Rising implied vol is the risk-off direction."
                    >
                      {pct(dvol.chg30d)} 30d
                    </span>
                    <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
                      range {dvol.lo.toFixed(1)} to {dvol.hi.toFixed(1)}
                    </span>
                  </div>
                </div>
                <Sparkline
                  data={dvol.series}
                  width={130}
                  height={40}
                  stroke={dvol.chg30d != null && dvol.chg30d >= 0 ? "var(--neg)" : "var(--pos)"}
                />
              </div>

              {dvol.percentile30d != null && (
                <div className="mt-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text3)]">
                      percentile in its own 30d range
                    </span>
                    <span className="font-mono text-sm font-bold" style={{ color: "var(--accent)" }}>
                      {dvol.percentile30d.toFixed(0)}
                      <span className="text-[10px] font-semibold text-[var(--text3)]">th</span>
                    </span>
                  </div>
                  <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, Math.max(0, dvol.percentile30d))}%`, background: "var(--accent)" }}
                    />
                  </div>
                  <div className="mt-1.5 break-words text-[11px] leading-snug text-[var(--text3)]">
                    {dvol.percentile30d >= 80
                      ? "Options are expensive against the last month. Fear is priced."
                      : dvol.percentile30d <= 20
                        ? "Options are cheap against the last month. Protection is on sale."
                        : "Mid-range against the last month."}
                  </div>
                </div>
              )}
            </>
          ) : (
            <Unavailable what="DVOL history" />
          )}
        </Panel>

        {/* ------------------------------------------------------ desk stats -- */}
        <Panel title={`${ccy} desk summary`} className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat k="index" v={usd(desk.index)} sub={`${ccy} spot, Deribit index`} />
            <Stat
              k="open interest"
              v={usdCompact(desk.totalOiUsd)}
              sub={`${compact(desk.totalOi, 0)} contracts across ${rows.length} expiries`}
            />
            <Stat k="24h volume" v={usdCompact(desk.totalVolUsd)} sub="premium traded, all strikes" />
            <Stat
              k="put/call OI"
              v={desk.pcrOi == null ? NA : desk.pcrOi.toFixed(2)}
              sub={`front ${front.code ? label(front.code) : ""} at ${desk.pcrFront == null ? NA : desk.pcrFront.toFixed(2)}`}
              color={desk.pcrOi == null ? undefined : desk.pcrOi > 1 ? "var(--neg)" : "var(--pos)"}
            />
            <Stat
              k="atm iv front"
              v={desk.frontIv == null ? NA : `${desk.frontIv.toFixed(1)}%`}
              sub={`back ${desk.backIv == null ? NA : `${desk.backIv.toFixed(1)}%`}, annualised`}
            />
            <Stat
              k="25d rr ~30d"
              v={ref?.skew == null ? NA : `${ref.skew >= 0 ? "+" : ""}${ref.skew.toFixed(2)}`}
              color={ref?.skew == null ? undefined : ref.skew < 0 ? "var(--neg)" : "var(--pos)"}
              sub={
                ref?.skew == null
                  ? "no wing pair with a usable mark"
                  : `${label(ref.code)}, vol points, ${ref.skew < 0 ? "puts bid" : "calls bid"} (approximation)`
              }
            />
            <Stat
              k="term shape"
              v={desk.shape ?? NA}
              color={shapeColor}
              sub={
                desk.shape === "backwardation"
                  ? "front vol above back vol: the market is paying up for immediate protection"
                  : desk.shape === "contango"
                    ? "front vol below back vol: the calm, carry-friendly default"
                    : "front and back vol within half a point"
              }
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text3)]">call OI</div>
              <div className="mt-1 font-mono text-sm font-bold" style={{ color: "var(--pos)" }}>
                {compact(desk.callOi, 0)}
              </div>
              <div className="mt-1.5">
                <BarCell value={desk.callOi} max={Math.max(desk.callOi, desk.putOi)} color="var(--pos)" />
              </div>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text3)]">put OI</div>
              <div className="mt-1 font-mono text-sm font-bold" style={{ color: "var(--neg)" }}>
                {compact(desk.putOi, 0)}
              </div>
              <div className="mt-1.5">
                <BarCell value={desk.putOi} max={Math.max(desk.callOi, desk.putOi)} color="var(--neg)" />
              </div>
            </div>
          </div>
        </Panel>

        {/* -------------------------------------------------- term structure -- */}
        <Panel
          title="IV term structure"
          className="lg:col-span-1"
          right={
            <span className="pill whitespace-nowrap" style={{ color: shapeColor }}>
              {desk.shape ?? NA}
            </span>
          }
        >
          <TermCurve rows={rows} />
          <div className="mt-1 break-words text-[11px] leading-snug text-[var(--text3)]">
            ATM implied vol, annualised, by days to expiry. Violet dots are quarterly expiries.
          </div>
        </Panel>

        {/* ---------------------------------------------------- max pain x2 -- */}
        {desk.pain.map((p) => (
          <Panel
            key={p.code}
            // The currency belongs in the heading. Cropped out of the desk, or
            // scrolled to directly, this card carried an expiry and a price and
            // nothing saying which asset either belonged to.
            title={`Max pain · ${ccy} · ${label(p.code)}`}
            className="lg:col-span-1"
            right={
              <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
                {dteLabel(p.dte)} to expiry
              </span>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-2xl font-bold leading-none text-[var(--text)]">
                  {p.maxPain == null ? NA : usd(p.maxPain)}
                </div>
                <div className="mt-1 font-mono text-[11px] text-[var(--text3)]">
                  spot {usd(desk.index)}
                </div>
              </div>
              <span
                className="whitespace-nowrap font-mono text-sm font-semibold"
                style={{
                  color: p.distPct == null ? "var(--text3)" : p.distPct >= 0 ? "var(--pos)" : "var(--neg)",
                }}
                title="Distance from spot to max pain"
              >
                {pct(p.distPct)}
              </span>
            </div>
            <PainChart row={p} index={desk.index} />
          </Panel>
        ))}

        {/* ------------------------------------------------------ big table -- */}
        <Panel
          title="Expiry ladder"
          hint={`Negative skew means puts trade above calls, so downside is bid. Skew is approximated: the public book summary carries no greeks. One contract is one ${ccy}, valued at the Deribit index.`}
          className="lg:col-span-3"
          right={
            wings.length ? (
              <span className="whitespace-nowrap font-mono text-[10px] text-[var(--text3)]">
                skew wings {Math.min(...wings).toFixed(1)}% to {Math.max(...wings).toFixed(1)}% out
              </span>
            ) : undefined
          }
        >
          <TableWrap maxHeight={420} tight>
            <thead>
              <tr>
                <th scope="col" className="ident">Expiry</th>
                <th scope="col" className="num">
                  DTE
                </th>
                <th scope="col" className="num">
                  ATM IV
                </th>
                <th scope="col" className="num">
                  <abbr title="Approximate 25-delta risk reversal: call implied vol minus put implied vol, in vol points">
                    25d RR
                  </abbr>
                </th>
                <th scope="col">Skew</th>
                <th scope="col" className="num">
                  OI
                </th>
                <th scope="col" className="num">
                  OI USD
                </th>
                <th scope="col">Share</th>
                <th scope="col" className="num">
                  <abbr title="Put open interest divided by call open interest">P/C</abbr>
                </th>
                <th scope="col" className="num">
                  24h vol
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td className="ident font-mono text-[var(--text)]">
                    <span>{label(r.code)}</span>
                    {r.quarterly && (
                      <span
                        className="ml-1 font-mono text-[10px]"
                        style={{ color: "var(--violet)" }}
                        title="Quarterly expiry"
                      >
                        ◆
                      </span>
                    )}
                  </td>
                  <td className="num">{dteLabel(r.dte)}</td>
                  <td className="num text-[var(--text)]">{r.atmIv == null ? NA : pctPlain(r.atmIv, 1)}</td>
                  <td
                    className="num font-semibold"
                    style={{
                      color: r.skew == null ? "var(--text3)" : r.skew < 0 ? "var(--neg)" : "var(--pos)",
                    }}
                  >
                    {r.skew == null ? NA : `${r.skew >= 0 ? "+" : ""}${r.skew.toFixed(2)}`}
                  </td>
                  <td className="min-w-[64px]">
                    <SkewBar value={r.skew} max={maxSkew} />
                  </td>
                  <td className="num">{compact(r.oi, 0)}</td>
                  <td className="num text-[var(--text)]">{usdCompact(r.oiUsd)}</td>
                  <td className="min-w-[64px]">
                    <BarCell value={r.oiUsd} max={maxOi} color="var(--accent)" />
                  </td>
                  <td
                    className="num"
                    style={{ color: r.pcr == null ? "var(--text3)" : r.pcr > 1 ? "var(--neg)" : "var(--pos)" }}
                  >
                    {r.pcr == null ? NA : r.pcr.toFixed(2)}
                  </td>
                  <td className="num">{usdCompact(r.volUsd)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Panel>
      </div>
    </Section>
  );
}

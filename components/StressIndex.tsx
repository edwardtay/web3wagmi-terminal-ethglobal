"use client";

import { Panel, Loading, Unavailable, Sparkline, TableWrap, AsOf } from "@/components/ui";
import { useApi } from "@/lib/useApi";
import { num, pctPlain, NA } from "@/lib/format";
import { csiBand, CSI_SPARK_DAYS, type CsiComponent, type CsiId, type StressPayload } from "@/lib/csi";

const METHODOLOGY =
  "The Crypto Stress Index is our own composite, not a standard market measure. Six independently sourced components are each converted to 0-100 by percentile rank against their own trailing history (365 days for realised vol, correlation and drawdown; 180 days for implied vol, funding and the stablecoin peg), then combined at fixed weights: realised vol 22%, implied vol 18%, funding 15%, peg 15%, correlation 15%, drawdown 15%. Higher means more stress. If a source fails its component is dropped and the survivors are renormalised, and the drop is shown in the table. The headline percentile compares today's composite to the last 365 days of the same composite.";

/** Band cut points, drawn as the scale under the headline score. */
const BANDS = [0, 20, 40, 60, 80, 100];

/** Each component reports in its own units, so the raw column is formatted per row. */
function rawLabel(id: CsiId, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return NA;
  switch (id) {
    case "rvol":
      return `${num(v, 1)}%`;
    case "ivol":
      return num(v, 1);
    case "funding":
      return `${num(v, 2)}%`;
    case "peg":
      return `${num(v, 1)} bps`;
    case "corr":
      return num(v, 2);
    case "dd":
      return `${num(v, 1)}%`;
  }
}

function scoreColor(score: number | null): string {
  return score == null ? "var(--text3)" : csiBand(score).color;
}

function Gauge({ score }: { score: number }) {
  return (
    <div className="mt-3">
      <div className="relative h-2 w-full overflow-hidden rounded-full">
        <div className="flex h-full w-full">
          {BANDS.slice(0, -1).map((lo) => (
            <div
              key={lo}
              className="h-full flex-1"
              style={{ background: csiBand(lo + 1).color, opacity: 0.28 }}
            />
          ))}
        </div>
        <div
          className="absolute top-0 h-full w-[3px] rounded-full"
          style={{ left: `calc(${Math.min(100, Math.max(0, score))}% - 1.5px)`, background: "var(--text)" }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-[var(--text3)]">
        {BANDS.map((b) => (
          <span key={b}>{b}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Change in index points, not percent: the composite is already a 0-100 scale,
 * so "+3.2 pts" is the honest unit. Rising stress is red.
 */
function Delta({ label, from, to }: { label: string; from: number | null; to: number }) {
  const d = from != null ? to - from : null;
  const col = d == null || Math.abs(d) < 0.05 ? "var(--text3)" : d > 0 ? "var(--neg)" : "var(--pos)";
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span className="text-[var(--text3)]">{label}</span>
      <span className="font-mono font-semibold tabular-nums" style={{ color: col }}>
        {d == null ? NA : `${d >= 0 ? "+" : ""}${d.toFixed(1)} pts`}
      </span>
    </span>
  );
}

function Row({ c, maxContrib }: { c: CsiComponent; maxContrib: number }) {
  const col = scoreColor(c.score);
  return (
    <tr style={c.live ? undefined : { opacity: 0.72 }}>
      <td className="min-w-0">
        <div className="flex items-start gap-1.5">
          {/* The hint lives in the Decomposition header, not here: a tooltip
              inside the scrolling table body gets clipped by its overflow. */}
          <span
            className="font-semibold text-[var(--text)]"
            style={{ overflowWrap: "anywhere" }}
            title={`${c.hint} Source: ${c.source}.`}
          >
            {c.short}
          </span>
        </div>
        <div className="mt-0.5 text-[10px] text-[var(--text3)]" style={{ overflowWrap: "anywhere" }}>
          {c.live ? c.unit : `dropped: ${c.dropReason ?? "no data"}`}
        </div>
      </td>
      <td className="num">{rawLabel(c.id, c.raw)}</td>
      <td className="num">
        {c.live && c.score != null ? (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--surface2)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.min(100, Math.max(0, c.score))}%`, background: col }}
              />
            </div>
            <span className="font-bold" style={{ color: col }}>
              {c.score.toFixed(0)}
            </span>
          </div>
        ) : (
          <span className="text-[var(--text3)]">dropped</span>
        )}
      </td>
      <td className="num">
        {c.live ? (
          <>
            {(c.effWeight * 100).toFixed(0)}%
            {Math.abs(c.effWeight - c.weight) > 0.005 && (
              <span className="text-[var(--text3)]"> (base {(c.weight * 100).toFixed(0)}%)</span>
            )}
          </>
        ) : (
          <span className="text-[var(--text3)]">0%</span>
        )}
      </td>
      <td className="num">
        {c.contribution != null && c.live ? (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--surface2)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${maxContrib > 0 ? Math.min(100, (c.contribution / maxContrib) * 100) : 0}%`,
                  background: "var(--text2)",
                }}
              />
            </div>
            <span className="font-semibold text-[var(--text)]">{c.contribution.toFixed(1)}</span>
          </div>
        ) : (
          <span className="text-[var(--text3)]">{NA}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The long form, for the reader who wants it.
 *
 * A composite nobody else publishes has to say so, and has to say what its
 * bands mean, or "extreme" reads as an absolute when it is a percentile.
 */
const CAVEAT =
  "Computed from public data: Binance, Deribit and DefiLlama. No one else publishes this index, so it cannot be compared against anything but itself. Each component is percentile-ranked against its own trailing history, so \"extreme\" means high against the lookback rather than high in absolute terms, and a stress regime that persists for months will gradually normalise its own score. Cached for 15 minutes.";

export function StressIndex() {
  const { data, loading, failed } = useApi<StressPayload>("/api/stress", 900);

  return (
    <Panel
      title="Crypto Stress Index"
      right={data?.asOf ? <AsOf iso={data.asOf} staleMs={30 * 60 * 1000} /> : null}
    >
      {loading ? (
        <Loading rows={7} />
      ) : failed || !data || !data.ok || data.score == null ? (
        <Unavailable what="The Crypto Stress Index" />
      ) : (
        <Body data={data} score={data.score} />
      )}
    </Panel>
  );
}

function Body({ data, score }: { data: StressPayload; score: number }) {
  const band = csiBand(score);
  const dropped = data.components.filter((c) => !c.live);
  const maxContrib = Math.max(...data.components.map((c) => c.contribution ?? 0), 1);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className="font-mono text-[42px] font-bold leading-none tabular-nums"
              style={{ color: band.color }}
            >
              {score.toFixed(1)}
            </span>
            <span className="font-mono text-[11px] text-[var(--text3)]">/ 100</span>
            <span
              className="rounded-md px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-wider"
              style={{ color: band.color, background: "var(--surface2)" }}
            >
              {band.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text2)]">
            <span>
              {data.percentile != null ? (
                <>
                  <span className="font-mono font-semibold text-[var(--text)]">
                    {pctPlain(data.percentile, 0)}
                  </span>{" "}
                  of the last {data.historyDays} days were calmer
                </>
              ) : (
                "percentile unavailable"
              )}
            </span>
            <Delta label="1d" from={data.prev1d} to={score} />
            <Delta label="7d" from={data.prev7d} to={score} />
          </div>
        </div>
        {/* The svg scales to the row. Every other sparkline on the terminal
            carries this rule and this one did not, so it drew at its intrinsic
            190px and left the rest of the row empty. */}
        <div className="min-w-0 flex-1 [&>svg]:w-full">
          <Sparkline data={data.spark} width={190} height={44} stroke={band.color} />
          <div className="mt-0.5 text-right font-mono text-[9px] text-[var(--text3)]">
            composite, last {Math.min(CSI_SPARK_DAYS, data.spark.length)}d
          </div>
        </div>
      </div>

      <Gauge score={score} />

      <div className="mt-0.5 grid grid-cols-5 font-mono text-[9px] uppercase tracking-wide">
        {[0, 20, 40, 60, 80].map((lo) => {
          const b = csiBand(lo + 1);
          const active = score >= lo && (score < lo + 20 || lo === 80);
          return (
            <span
              key={lo}
              className="text-center"
              style={{ color: active ? b.color : "var(--text3)", fontWeight: active ? 700 : 400 }}
            >
              {b.label}
            </span>
          );
        })}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <h4 className="font-display text-[10px] font-bold uppercase tracking-[0.09em] text-[var(--text2)]">
            Decomposition
          </h4>
        </div>
        <TableWrap maxHeight={340}>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col" className="num">
                Raw
              </th>
              <th scope="col" className="num">
                Score
              </th>
              <th scope="col" className="num">
                Weight
              </th>
              <th scope="col" className="num">
                Contrib
              </th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((c) => (
              <Row key={c.id} c={c} maxContrib={maxContrib} />
            ))}
            <tr>
              <td className="font-semibold text-[var(--text)]">Composite</td>
              <td className="num text-[var(--text3)]">{NA}</td>
              <td className="num font-bold" style={{ color: band.color }}>
                {score.toFixed(1)}
              </td>
              <td className="num font-semibold text-[var(--text)]">
                {(data.components.reduce((a, c) => a + c.effWeight, 0) * 100).toFixed(0)}%
              </td>
              <td className="num font-bold text-[var(--text)]">{score.toFixed(1)}</td>
            </tr>
          </tbody>
        </TableWrap>
      </div>

      {dropped.length > 0 && (
        <div
          className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-2.5 text-[11px] leading-relaxed"
          style={{ color: "var(--gold)", overflowWrap: "anywhere" }}
        >
          <span className="font-semibold">Reweighted.</span>{" "}
          {dropped.map((c) => c.label).join(", ")}{" "}
          {dropped.length === 1 ? "is" : "are"} unavailable, so{" "}
          {(dropped.reduce((a, c) => a + c.weight, 0) * 100).toFixed(0)}% of the base weight was
          redistributed across the {data.liveIds.length} live components. Read the score with that in
          mind.
        </div>
      )}


    </div>
  );
}

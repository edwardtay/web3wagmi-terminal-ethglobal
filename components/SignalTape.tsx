"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, AsOf, Segmented } from "./ui";

// What just became abnormal, ranked. This sits at the top because it is the
// answer to the only question worth asking on arrival.

// Kept in step with the kinds /api/signals emits by hand, because this is a
// client component and the route's type is server-side. It drifted: flow and
// unlock arrived on the route and not here, and a Record keyed by the narrower
// type still typechecks, so both new kinds rendered a blank badge rather than a
// compile error. Adding a kind to the route means adding it in all three places
// below.
type SignalKind = "funding" | "move" | "oi" | "vol-carry" | "peg" | "flow" | "unlock";

interface Signal {
  id: string;
  kind: SignalKind;
  severity: number;
  symbol: string | null;
  headline: string;
  detail: string;
  evidence: string;
  href: string;
  bias: "long" | "short" | "neutral";
}

interface SignalsPayload {
  ok: boolean;
  asOf: string;
  signals: Signal[];
  counts: Partial<Record<SignalKind, number>>;
  scanned: { perps: number; assets: number; stables: number };
}

const KIND_LABEL: Record<SignalKind, string> = {
  funding: "funding",
  move: "price",
  oi: "positioning",
  "vol-carry": "volatility",
  peg: "peg",
  flow: "exchange flow",
  unlock: "supply",
};

const KIND_COLOR: Record<SignalKind, string> = {
  funding: "var(--accent)",
  move: "var(--cyan)",
  oi: "var(--violet)",
  "vol-carry": "var(--gold)",
  peg: "var(--neg)",
  flow: "var(--pos)",
  unlock: "var(--neg)",
};



function severityColor(s: number): string {
  if (s >= 66) return "var(--neg)";
  if (s >= 33) return "var(--gold)";
  return "var(--text3)";
}

/**
 * Severity as a word.
 *
 * The bare number ranks the queue correctly and tells a reader nothing: 30 out
 * of what, against which scale, and is that a lot. The score is a ranking
 * device rather than a measurement, so the honest presentation is the band,
 * with the number kept on hover for anyone comparing two rows.
 *
 * The thresholds are the ones the colour already used, so the label and the
 * colour cannot disagree.
 */
function severityBand(s: number): string {
  if (s >= 66) return "extreme";
  if (s >= 33) return "strong";
  if (s >= 10) return "notable";
  return "slight";
}

export function SignalTape() {
  const { data, loading, failed } = useApi<SignalsPayload>("/api/signals", 300);
  type Filter = "all" | SignalKind;

  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const all = data?.signals ?? [];
  const rows = filter === "all" ? all : all.filter((s) => s.kind === filter);

  const kinds = (Object.keys(KIND_LABEL) as SignalKind[]).filter((k) => (data?.counts?.[k] ?? 0) > 0);

  const right = (
    <>
      {kinds.length > 1 && (
        <Segmented
          options={[
            { value: "all" as Filter, label: `all ${all.length}` },
            ...kinds.map((k) => ({ value: k as Filter, label: `${KIND_LABEL[k]} ${data?.counts?.[k] ?? 0}` })),
          ]}
          value={filter}
          onChange={setFilter}
          ariaLabel="Signal kind"
        />
      )}
      {data?.asOf && <AsOf iso={data.asOf} staleMs={20 * 60 * 1000} />}
    </>
  );

  if (loading) {
    return (
      <Section title="What changed" id="signals" right={right}>
        <Panel>
          <Loading rows={4} />
        </Panel>
      </Section>
    );
  }

  return (
    <Section title="What changed" id="signals" right={right}>
      <Panel className="panel-accent">
        {failed || !data?.ok ? (
          <div className="py-6 text-center font-mono text-[11px] text-[var(--text3)]">
            The dislocation scan is unavailable right now.
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5 py-6 text-center font-mono text-[11px] text-[var(--text3)]">
            <span>
              Nothing abnormal across {data.scanned.perps} perps, {data.scanned.assets} spot pairs and{" "}
              {data.scanned.stables} stablecoins.
            </span>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((s) => {
              const open = expanded === s.id;
              return (
                <li key={s.id}>
                  <div
                    className="rounded-lg border border-[var(--border2)] bg-[var(--bg2)] p-2.5"
                    style={{ borderLeft: `3px solid ${severityColor(s.severity)}` }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span
                          className="pill shrink-0 px-1.5 py-0 text-[9px] uppercase"
                          style={{
                            color: KIND_COLOR[s.kind],
                            borderColor: KIND_COLOR[s.kind],
                            background: `color-mix(in srgb, ${KIND_COLOR[s.kind]} 12%, transparent)`,
                          }}
                        >
                          {KIND_LABEL[s.kind]}
                        </span>
                        <span className="min-w-0 break-words text-[13px] font-semibold text-[var(--text)]">
                          {s.headline}
                        </span>
                        {s.bias !== "neutral" && (
                          /* A pill, like the kind badge beside it. These are the
                             same class of thing, a label on the row, and one of
                             them rendering as bare coloured text read as part of
                             the headline rather than as a tag. */
                          <span
                            className="pill shrink-0 border-transparent px-1.5 py-0 text-[9px] uppercase"
                            style={{
                              color: s.bias === "long" ? "var(--pos)" : "var(--neg)",
                              background: s.bias === "long" ? "var(--pos-soft)" : "var(--neg-soft)",
                            }}
                            title={`Reads ${s.bias} on this signal alone`}
                          >
                            {s.bias}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {/* Severity is the stripe down the left of the row and
                            was also a pill, which put three shouting tags on a
                            row that has two facts. The stripe already ranks it,
                            the rows are already ordered by it, and the band is
                            in the title where the number lives. */}
                        <span
                          className="shrink-0 font-mono text-[10px] text-[var(--text3)]"
                          title={`How far past its own trigger this reading sits, scored ${s.severity} of 100. A ranking device for ordering the queue, not a measurement of the market.`}
                        >
                          {severityBand(s.severity).toLowerCase()}
                        </span>
                        <button
                          onClick={() => setExpanded(open ? null : s.id)}
                          aria-expanded={open}
                          className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                        >
                          {open ? "less" : "why"}
                        </button>
                        <a
                          href={s.href}
                          className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                        >
                          panel
                        </a>
                      </div>
                    </div>

                    <div className="mt-1 break-words font-mono text-[11px] text-[var(--text2)]">{s.evidence}</div>

                    {open && (
                      <p className="mt-2 border-t border-[var(--border2)] pt-2 text-[12px] leading-relaxed text-[var(--text2)]">
                        {s.detail}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </Section>
  );
}

"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, Unavailable, InfoHint } from "./ui";

// The note the terminal wrote without being asked.
//
// Every other panel here answers a question a reader brought. This one is the
// terminal having already looked: it runs on its own schedule, reads every
// desk, and says what someone arriving this morning would want told to them.
//
// It sits at the top because that is the order the work happens in. A reader
// gets the account first and the evidence underneath it, and every number in
// the account is on a panel further down the same page.

interface Brief {
  date: string;
  session?: string;
  writtenAt: string;
  text: string;
  read: string[];
  missing: string[];
}

interface Payload {
  ok: boolean;
  brief: Brief | null;
  archive?: Brief[];
  note: string | null;
}

function when(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * The note as points, structured here rather than by the model.
 *
 * The prompt already fixes what each sentence does: the first is what matters
 * most, the last is what to watch, and the middle is the supporting picture.
 * So the shape is known without asking the model to format anything, which
 * matters because every attempt to let it produce structure ended in headings,
 * bullets and a preamble. It writes sentences; the layout is applied.
 *
 * A single sentence stays a sentence. Bulleting one point is furniture.
 */
function BriefBody({ text }: { text: string }) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((s) => s.trim());
  if (sentences.length < 3) {
    return <p className="text-[14px] leading-relaxed text-[var(--text)]">{text}</p>;
  }

  const lead = sentences[0];
  const watch = sentences[sentences.length - 1];
  const middle = sentences.slice(1, -1);

  return (
    <>
      <p className="text-[14px] font-semibold leading-relaxed text-[var(--text)]">{lead}</p>

      {middle.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {middle.map((s, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-[var(--text2)]">
              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2.5 flex flex-wrap items-baseline gap-1.5 text-[13px] leading-relaxed text-[var(--text2)]">
        <span className="pill shrink-0 border-transparent bg-[var(--accent-soft)] px-1.5 py-0 text-[9px] uppercase text-[var(--accent)]">
          watch
        </span>
        <span className="min-w-0">{watch}</span>
      </p>
    </>
  );
}

export function MorningBrief() {
  // Six hours on the server, so the poll here only needs to notice a new one.
  const { data, loading, failed } = useApi<Payload>("/api/brief", 900);
  const [showPast, setShowPast] = useState(false);

  const past = data?.archive ?? [];

  return (
    <Section
      title="The brief"
      id="brief"
      hint="Written by the terminal rather than asked for: one pass over every desk, in prose, once per six-hour session anchored to 00:00, 06:00, 12:00 and 18:00 UTC, which are roughly the handovers between Asia, Europe and New York. The note names its own session, so the one on screen is the one everybody else is reading and the next is due at a time you can predict. Every figure in it comes from a panel below and nothing was gathered by the model, which is handed the readings and asked only to write them up. It describes conditions and never recommends a trade. Earlier notes are kept only while the server runs, because this terminal has no database and does not need one for anything else."
      right={
        data?.brief ? (
          <span className="font-mono text-[10px] text-[var(--text3)]">{when(data.brief.writtenAt)}</span>
        ) : null
      }
    >
      <Panel className="panel-accent">
        {loading ? (
          <Loading rows={3} />
        ) : failed || !data?.brief ? (
          <>
            <Unavailable what="The morning note" />
            {data?.note && <p className="mt-2 text-[12px] text-[var(--text3)]">{data.note}</p>}
          </>
        ) : (
          <>
            <BriefBody text={data.brief.text} />

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--border2)] pt-2.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                {data.brief.session ?? data.brief.date}
              </span>
              <span className="flex flex-wrap items-center gap-1 font-mono text-[9px] text-[var(--text3)]">
                read
                {data.brief.read.map((r) => (
                  <span key={r} className="rounded border border-[var(--border)] bg-[var(--bg2)] px-1 py-px text-[var(--text2)]">
                    {r}
                  </span>
                ))}
              </span>
              {data.brief.missing.length > 0 && (
                <span className="font-mono text-[9px] text-[var(--text3)]">
                  could not read {data.brief.missing.join(", ")}
                </span>
              )}
              {data.note && <span className="text-[10px] text-[var(--text3)]">{data.note}</span>}
              {past.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPast((v) => !v)}
                  className="ml-auto rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                >
                  {showPast ? "hide earlier" : `${past.length} earlier`}
                </button>
              )}
            </div>

            {showPast && (
              <div className="mt-3 space-y-3 border-t border-[var(--border2)] pt-3">
                {past.map((b) => (
                  <div key={b.writtenAt}>
                    <div className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                      {b.session ?? b.date} · {when(b.writtenAt)}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text2)]">{b.text}</p>
                  </div>
                ))}
                <p className="font-mono text-[9px] text-[var(--text3)]">
                  Earlier notes are held in memory and reset when the server restarts.
                  <InfoHint text="Keeping them would mean a database this terminal does not otherwise need. The limit is stated rather than hidden, which is the same rule every panel here follows about its own scope." />
                </p>
              </div>
            )}
          </>
        )}
      </Panel>
    </Section>
  );
}

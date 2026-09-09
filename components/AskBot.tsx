"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The assistant bubble, bottom right.
//
// It talks to /api/ask, which is the same loop the command palette uses, so
// every number in an answer came back from a tool reading this terminal's own
// desks. That is the whole reason it can be trusted on live questions: it is not
// recalling anything, it is reading the panels.
//
// Scoped to what this terminal measures, deliberately. A guide library tool was
// built and removed: on a market terminal a reader asking "is there selling
// pressure" wants the desks, and a retrieval bot answering from blog posts is
// both off-topic and unreliable. It answered a question about liquidity pools
// with a Bitcoin mining pool guide. The guides have their own bot; this one says
// so and stops rather than guessing.
//
// Rendered through a portal: it sits above a page whose header carries
// backdrop-blur, and a backdrop-filter establishes a containing block for fixed
// position descendants.

interface Turn {
  role: "you" | "bot";
  text: string;
  desks?: string[];
}

const DESK_LABEL: Record<string, string> = {
  dislocation_queue: "what changed",
  exchange_flow: "exchange flow",
  derivatives: "funding",
  query_uniswap_subgraph: "uniswap",
  compare_protocols: "protocols",
  market_coverage: "coverage",
};

/** Shown once, so the bubble is not an empty box asking to be guessed at. */
const OPENERS = [
  "What is unusual right now?",
  "Is there selling pressure building?",
  "How concentrated is WBTC ownership?",
  "How does Aave compare to Compound?",
];

/**
 * An answer, broken where its own sentences break.
 *
 * The prose is deliberately plain: the model is forbidden headings, bullets and
 * line breaks, because when it was allowed them it produced a desk by desk
 * report with a preamble instead of an answer. That fix left a different
 * problem, which is that four sentences of dense numbers arrive as one block
 * and the finding is buried in the middle of it.
 *
 * The structure is added here rather than asked for. The first sentence is the
 * conclusion, because the prompt requires the lead to be the thing that matters
 * most, so it is set apart. The rest gets spacing between sentences, which is
 * the difference between a paragraph a reader scans and one they skip.
 */
function Answer({ text }: { text: string }) {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((s) => s.trim());
  if (parts.length < 2) return <>{text}</>;
  const [lead, ...rest] = parts;
  return (
    <>
      <p className="font-semibold text-[var(--text)]">{lead}</p>
      {rest.map((s, i) => (
        <p key={i} className="mt-1.5 text-[var(--text2)]">
          {s}
        </p>
      ))}
    </>
  );
}

export function AskBot() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, open]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || pending) return;
    setQ("");
    setTurns((t) => [...t, { role: "you", text: question }]);
    setPending(true);
    try {
      // The focused asset comes from the URL rather than context, so this works
      // on every page and not only the one holding the symbol provider.
      const focus = new URLSearchParams(window.location.search).get("s") ?? undefined;
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, focus }),
      });
      const body = (await res.json()) as {
        answer: string | null;
        note: string | null;
        used: { tool: string }[];
      };
      setTurns((t) => [
        ...t,
        {
          role: "bot",
          text: body.answer ?? body.note ?? "No answer came back.",
          desks: [...new Set((body.used ?? []).map((u) => DESK_LABEL[u.tool] ?? u.tool))],
        },
      ]);
    } catch {
      setTurns((t) => [...t, { role: "bot", text: "That question could not be answered." }]);
    } finally {
      setPending(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <>
      {/* A heavier edge than a card's. This floats over a page already made of
          bordered panels, so a one pixel hairline in the same colour read as
          another panel that happened to be on top rather than as something that
          had just opened. The accent border and the ring around it give a clear
          outside edge without adding a fourth surface colour. */}
      {open && (
        <div className="fixed bottom-[76px] right-4 z-[140] flex w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border-2 border-[var(--accent)] bg-[var(--surface)] shadow-[0_0_0_4px_var(--accent-soft),var(--shadow-lg)]">
          <div className="flex items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg2)] px-3 py-2">
            <span className="font-display text-[12px] font-bold tracking-tight text-[var(--text)]">
              Ask the terminal
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close the assistant"
              className="flex h-7 w-7 items-center justify-center text-[var(--text3)] hover:text-[var(--text)]"
            >
              &times;
            </button>
          </div>

          <div className="thin-scroll max-h-[46vh] min-h-[120px] overflow-y-auto px-3 py-3">
            {turns.length === 0 && (
              <div className="space-y-1.5">
                <p className="text-[12px] leading-relaxed text-[var(--text2)]">
                  Every number in an answer is read live from the panels on this page.
                </p>
                {OPENERS.map((o) => (
                  <button
                    key={o}
                    onClick={() => send(o)}
                    className="block w-full rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2.5 py-1.5 text-left font-mono text-[10px] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className={t.role === "you" ? "mb-3 text-right" : "mb-3"}>
                <div
                  className={
                    t.role === "you"
                      ? "inline-block max-w-[85%] rounded-lg bg-[var(--surface2)] px-2.5 py-1.5 text-left text-[12px] text-[var(--text)]"
                      : "text-[12px] leading-relaxed text-[var(--text)]"
                  }
                  style={{ overflowWrap: "anywhere" }}
                >
                  {t.role === "bot" ? <Answer text={t.text} /> : t.text}
                </div>
                {t.desks && t.desks.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[9px] text-[var(--text3)]">
                    <span>read</span>
                    {t.desks.map((d) => (
                      <span
                        key={d}
                        className="rounded border border-[var(--border)] bg-[var(--bg2)] px-1 py-px text-[var(--text2)]"
                      >
                        {d}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}

            {pending && (
              <p className="font-mono text-[11px] text-[var(--text3)]">Reading the desks...</p>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(q);
            }}
            className="flex gap-2 border-t border-[var(--border)] p-2"
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask about this market"
              aria-label="Ask about the market"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2.5 py-1.5 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text3)] focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={pending}
              className="shrink-0 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 font-mono text-[11px] font-semibold text-[var(--accent)] disabled:opacity-50"
            >
              Ask
            </button>
          </form>
        </div>
      )}

      {/* The corner, below the feedback tab pinned to the edge at 88px. Filled
          in the brand accent rather than outlined, because an outlined circle on
          a page of outlined cards is another card. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close the assistant" : "Ask the terminal"}
        aria-expanded={open}
        className="ask-bot-fab fixed bottom-4 right-4 z-[130] flex h-12 w-12 items-center justify-center rounded-full text-[var(--on-accent)]"
        style={open ? { display: "none" } : undefined}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
        </svg>
      </button>
    </>,
    document.body
  );
}

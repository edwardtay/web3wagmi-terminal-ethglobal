"use client";

import { TokenIcon } from "./ui";

import { Command } from "cmdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { ASSETS } from "@/lib/symbols";

// Cmd+K navigation, and the place to ask a question.
//
// A terminal is a keyboard surface first: every panel is an anchor on the home
// page, so the palette jumps to sections and opens a symbol drill-in.
//
// It is also where a question belongs. Thirty panels answer "what is the market
// doing" and none of them answer "why", because why means joining panels: a
// move against the funding behind it, a deposit against the venue that would
// have to absorb it. The reader does that join in their head today, if they
// know which panels to join. Here they can just ask, and the answer arrives with
// the measurement attached and the desks it read named, so it can be checked
// rather than trusted.

interface Answer {
  ok: boolean;
  answer: string | null;
  used: { tool: string; bytes?: number; error?: string }[];
  note: string | null;
}

/** Shown when the box is empty, because a blank prompt teaches nobody anything. */
const STARTERS = [
  "What is unusual in the market right now?",
  "Is there selling pressure building in ETH?",
  "Can the market absorb the coins that just moved onto exchanges?",
  "What are leveraged traders paying to hold right now?",
];

/** The desks, named the way a reader would recognise them. */
const TOOL_LABEL: Record<string, string> = {
  dislocation_queue: "what changed",
  exchange_flow: "exchange flow",
  derivatives: "funding",
};

interface Item {
  label: string;
  hint: string;
  href: string;
}

const SECTIONS: Item[] = [
  { label: "What changed", hint: "ranked dislocations across the market", href: "/#signals" },
  { label: "Snapshot", hint: "headline prices, dominance, fear and greed", href: "/#snapshot" },
  { label: "Chart and context", hint: "the focused instrument: candles, funding, open interest, its signals", href: "/#focus" },
  { label: "Live board", hint: "streaming prices across the universe", href: "/#live" },
  { label: "Funding", hint: "perp funding, annualised, CEX vs Hyperliquid", href: "/#funding" },
  { label: "Open interest", hint: "OI levels, regime, positioning", href: "/#oi" },
  { label: "Liquidations", hint: "live force-order tape", href: "/#liquidations" },
  { label: "Options", hint: "DVOL, term structure, skew, max pain", href: "/#options" },
  { label: "Order book", hint: "depth, imbalance, trade tape", href: "/#microstructure" },
  { label: "Exchange flow", hint: "netflow onto and off exchanges", href: "/#netflow" },
  { label: "DEX pools", hint: "trending and new on-chain pools", href: "/#dex" },
  { label: "Chains", hint: "TVL by chain", href: "/#chains" },
  { label: "Protocols", hint: "TVL movers, DEX volume, fees and revenue", href: "/#protocols" },
  { label: "Stablecoins", hint: "supply and peg deviation", href: "/#stablecoins" },
  { label: "Yields", hint: "DeFi pool scanner", href: "/#yields" },
  { label: "Gas", hint: "EVM base fees and Bitcoin network", href: "/#gas" },
  { label: "Returns", hint: "cross-asset performance matrix", href: "/#returns" },
  { label: "Risk", hint: "volatility, drawdown, Sharpe, beta", href: "/#risk" },
  { label: "Correlation", hint: "pairwise correlation heatmap", href: "/#correlation" },
  { label: "Breadth", hint: "participation and alt-season read", href: "/#breadth" },
  { label: "Rotation", hint: "sector leadership quadrant", href: "/#rotation" },
  { label: "Screener", hint: "filter the universe on quant metrics", href: "/#screener" },
  { label: "Stress index", hint: "our composite market stress score", href: "/#stress" },
  { label: "Unlocks", hint: "token unlock calendar", href: "/#unlocks" },
  { label: "The Graph", hint: "what the indexed on-chain desks run on", href: "/thegraph" },
  { label: "Methodology", hint: "how every number is computed", href: "/methodology" },
  { label: "Data status", hint: "which upstreams are live", href: "/status" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The question being answered. Non-null switches the palette into answer mode. */
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped per question so a slow answer cannot overwrite a newer one. */
  const runId = useRef(0);

  const reset = useCallback(() => {
    setAsked(null);
    setAnswer(null);
    setPending(false);
    runId.current++;
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      // Escape backs out of an answer before it closes the palette, so a reader
      // who wants to ask a second question does not have to reopen it.
      if (e.key === "Escape") {
        if (asked) reset();
        else setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asked, reset]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      reset();
    }
  }, [open, reset]);

  async function submit(question: string) {
    const q = question.trim();
    if (!q) return;
    const id = ++runId.current;
    setAsked(q);
    setAnswer(null);
    setPending(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const body = (await res.json()) as Answer;
      if (runId.current === id) setAnswer(body);
    } catch {
      if (runId.current === id) {
        setAnswer({ ok: false, answer: null, used: [], note: "The question could not be answered." });
      }
    } finally {
      if (runId.current === id) setPending(false);
    }
  }

  // A question has a space in it. A symbol or a panel name mostly does not, and
  // guessing wrong only costs one extra row at the top of the list.
  const looksLikeQuestion = query.trim().includes(" ");

  function go(href: string) {
    setOpen(false);
    window.location.href = href;
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/55 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        {asked ? (
          <div>
            <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
              <p className="min-w-0 break-words text-sm font-semibold text-[var(--text)]">{asked}</p>
              <button
                type="button"
                onClick={reset}
                className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
              >
                Esc
              </button>
            </div>

            <div className="px-4 py-4">
              {pending && (
                <p className="font-mono text-[11px] text-[var(--text3)]">Reading the desks...</p>
              )}

              {!pending && answer?.answer && (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text)]">
                    {answer.answer}
                  </p>
                  {answer.used.length > 0 && (
                    /* Naming the desks is what makes the answer checkable. A
                       reader who doubts a number knows which panel to open. */
                    <p className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--border2)] pt-3 font-mono text-[10px] text-[var(--text3)]">
                      <span>read</span>
                      {[...new Set(answer.used.map((u) => u.tool))].map((tool) => (
                        <span
                          key={tool}
                          className="rounded border border-[var(--border)] bg-[var(--bg2)] px-1.5 py-0.5 text-[var(--text2)]"
                        >
                          {TOOL_LABEL[tool] ?? tool}
                        </span>
                      ))}
                    </p>
                  )}
                </>
              )}

              {!pending && !answer?.answer && (
                <p className="font-mono text-[11px] text-[var(--text3)]">
                  {answer?.note ?? "No answer came back."}
                </p>
              )}
            </div>
          </div>
        ) : (
        <Command label="Terminal command menu" loop>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              // Enter on a question sends it, whatever row happens to be
              // highlighted. Typing a sentence and pressing Enter should not
              // navigate somewhere by accident.
              if (e.key === "Enter" && looksLikeQuestion) {
                e.preventDefault();
                submit(query);
              }
            }}
            placeholder="Ask a question, or jump to a panel or symbol"
            className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text3)]"
          />
          <Command.List className="thin-scroll max-h-[52vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center font-mono text-[11px] text-[var(--text3)]">
              Nothing matches that. Press Enter to ask it as a question.
            </Command.Empty>

            {looksLikeQuestion && (
              <Command.Group
                heading="Ask"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-[var(--text3)]"
              >
                <Command.Item
                  value={query}
                  forceMount
                  onSelect={() => submit(query)}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[var(--text2)] data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:text-[var(--text)]"
                >
                  <span className="min-w-0 break-words font-semibold text-[var(--text)]">{query}</span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                    answer this
                  </span>
                </Command.Item>
              </Command.Group>
            )}

            {query.trim() === "" && (
              <Command.Group
                heading="Ask the terminal"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-[var(--text3)]"
              >
                {STARTERS.map((s) => (
                  <Command.Item
                    key={s}
                    value={s}
                    onSelect={() => submit(s)}
                    className="cursor-pointer rounded-lg px-3 py-2 text-sm text-[var(--text2)] data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:text-[var(--text)]"
                  >
                    <span className="break-words">{s}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading="Symbols"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-[var(--text3)]"
            >
              {ASSETS.map((a) => (
                <Command.Item
                  key={a.sym}
                  value={`${a.sym} ${a.name}`}
                  onSelect={() => go(`/s/${a.sym}`)}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[var(--text2)] data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:text-[var(--text)]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <TokenIcon sym={a.sym} />
                    <span className="font-mono text-xs font-bold text-[var(--text)]">{a.sym}</span>
                    <span className="break-words text-xs text-[var(--text3)]">{a.name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">
                    {a.sector}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading="Panels"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-[var(--text3)]"
            >
              {SECTIONS.map((s) => (
                <Command.Item
                  key={s.href}
                  value={`${s.label} ${s.hint}`}
                  onSelect={() => go(s.href)}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-[var(--text2)] data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:text-[var(--text)]"
                >
                  <span className="font-semibold text-[var(--text)]">{s.label}</span>
                  <span className="min-w-0 break-words text-right text-[11px] text-[var(--text3)]">{s.hint}</span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
        )}
      </div>
    </div>
  );
}

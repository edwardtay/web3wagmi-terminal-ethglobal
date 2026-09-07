"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ASSETS } from "@/lib/symbols";
import { usd } from "@/lib/format";
import { useApi } from "@/lib/useApi";

// Alerts, stored in localStorage and evaluated in the tab. There is no account
// and no server, so an alert only fires while this tab is open. That limit is
// stated in the UI rather than hidden, because a missed alert someone believed
// in is worse than no alert.
//
// Two kinds, and they arm differently on purpose.
//
// A price alert is a level: it fires once when the level is crossed and then
// sits in the list marked fired, because a price oscillating around a threshold
// would otherwise fire forever.
//
// A dislocation alert watches the queue, which is what this terminal is for.
// It fires per distinct signal rather than once for all time: ARB moving four
// sigma today and ETH funding going extreme next week are two events, and an
// alert that armed once and died would miss the second. Fired signal ids are
// remembered per alert so the same event does not repeat on every poll.

const KEY = "w3w-terminal-alerts";

/** Signal kinds the dislocation queue emits, plus a catch-all. */
const SIGNAL_KINDS = ["any", "flow", "funding", "move", "oi", "vol-carry", "peg"] as const;
type SignalKind = (typeof SIGNAL_KINDS)[number];

const KIND_LABEL: Record<SignalKind, string> = {
  any: "anything",
  flow: "exchange flow",
  funding: "funding",
  move: "a price move",
  oi: "open interest",
  "vol-carry": "vol carry",
  peg: "a stablecoin peg",
};

interface PriceAlert {
  id: string;
  kind: "price";
  sym: string;
  above: boolean;
  price: number;
  /** Set once the alert has fired, so it does not repeat every poll. */
  firedAt?: number;
}

interface SignalAlert {
  id: string;
  kind: "signal";
  /** "any" watches every kind. */
  signalKind: SignalKind;
  /** "any" watches every asset, including market-wide signals with no symbol. */
  sym: string;
  minSeverity: number;
  /**
   * The matching signal ids present at the last check.
   *
   * Not an all-time list. A signal id is `move-ARB`, stable per kind and asset,
   * so remembering every id ever seen would fire for ARB once and then swallow
   * every future ARB move forever. Holding only what is currently in the queue
   * makes this a rising edge: a signal that clears and returns is a new event
   * and fires again, which is what a reader waiting on it expects.
   */
  active?: string[];
  firedAt?: number;
}

type Alert = PriceAlert | SignalAlert;

/**
 * What reaches the toast stack.
 *
 * A fired alert and the thing that fired it are not the same shape: a price
 * alert reports a level crossing and a dislocation alert reports one signal out
 * of several that matched at once. Flattening both into a display record here
 * means the toast does not have to know which kind it came from.
 */
interface Fired {
  key: string;
  title: string;
  detail: string;
}

interface Signal {
  id: string;
  kind: string;
  severity: number;
  symbol: string | null;
  headline: string;
  evidence: string;
}

interface BoardRow {
  sym: string;
  last: number;
}

interface BoardPayload {
  ok: boolean;
  rows?: BoardRow[];
}

function load(): Alert[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Alerts saved before dislocation alerts existed have no `kind`. Reading
    // them as price alerts keeps anything already armed working.
    return (parsed as Partial<Alert>[])
      .filter((a): a is Partial<Alert> => Boolean(a) && typeof a === "object")
      .map((a) => (a.kind ? (a as Alert) : ({ ...(a as object), kind: "price" } as Alert)));
  } catch {
    return [];
  }
}

function save(alerts: Alert[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(alerts));
  } catch {
    /* private mode: alerts stay in memory for this session only */
  }
}

/**
 * Renders into document.body rather than in place.
 *
 * This component lives inside the sticky header, and that header carries
 * backdrop-blur. A backdrop-filter establishes a containing block for fixed
 * position descendants, so `position: fixed` inside it resolves against the
 * header's box instead of the viewport: the overlay covered a strip across the
 * top of the page and the fired-alert toast appeared under the site nav rather
 * than in the bottom corner. Nothing about the styles was wrong.
 */
function Overlay({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return createPortal(children, document.body);
}

export function Alerts() {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sym, setSym] = useState("BTC");
  const [dir, setDir] = useState<"above" | "below">("above");
  const [price, setPrice] = useState("");
  const [sigKind, setSigKind] = useState<SignalKind>("flow");
  const [sigSym, setSigSym] = useState("any");
  const [triggered, setTriggered] = useState<Fired[]>([]);
  const loaded = useRef(false);
  // Monotonic suffix: array length would repeat an id after a deletion, and two
  // alerts sharing an id collide as React keys and delete each other.
  const seq = useRef(0);

  // Hydrate after mount so the server and first client render agree.
  useEffect(() => {
    setAlerts(load());
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (loaded.current) save(alerts);
  }, [alerts]);

  const { data } = useApi<BoardPayload>("/api/board", 30);

  const prices = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of data?.rows ?? []) map[r.sym] = r.last;
    return map;
  }, [data]);

  // Evaluate price alerts on every price refresh. One fires once, then sits in
  // the list marked fired until it is cleared, because a price oscillating
  // around a threshold would otherwise fire forever.
  useEffect(() => {
    if (!alerts.length || !Object.keys(prices).length) return;
    const hits: Fired[] = [];
    const next = alerts.map((a) => {
      if (a.kind !== "price" || a.firedAt) return a;
      const p = prices[a.sym];
      if (p == null) return a;
      const hit = a.above ? p >= a.price : p <= a.price;
      if (!hit) return a;
      const fired = { ...a, firedAt: Date.now() };
      hits.push({
        key: `${a.id}-${fired.firedAt}`,
        title: `${a.sym} ${a.above ? "crossed above" : "fell below"} ${usd(a.price)}`,
        detail: `now ${usd(p)}`,
      });
      return fired;
    });
    if (hits.length) {
      setAlerts(next);
      setTriggered((t) => [...hits, ...t].slice(0, 5));
    }
  }, [prices, alerts]);

  const { data: sigData } = useApi<{ signals?: Signal[] }>("/api/signals", 300);

  // Evaluate dislocation alerts. These fire per distinct signal rather than
  // once for all time, so a matching event next week still reaches the reader,
  // and each alert remembers the ids it has already reported.
  useEffect(() => {
    const signals = sigData?.signals ?? [];
    if (!alerts.length || signals.length === 0) return;

    const hits: Fired[] = [];
    let changed = false;
    const next = alerts.map((a) => {
      if (a.kind !== "signal") return a;
      const matching = signals.filter(
        (s) =>
          s.severity >= a.minSeverity &&
          (a.signalKind === "any" || s.kind === a.signalKind) &&
          (a.sym === "any" || s.symbol === a.sym)
      );
      const ids = matching.map((s) => s.id);
      const was = new Set(a.active ?? []);
      const fresh = matching.filter((s) => !was.has(s.id));

      // The stored set is rewritten even when nothing fired, so a signal
      // dropping out of the queue is forgotten and can fire again on return.
      const sameSet = ids.length === was.size && ids.every((id) => was.has(id));
      if (fresh.length === 0 && sameSet) return a;

      changed = true;
      for (const s of fresh) {
        hits.push({ key: `${a.id}-${s.id}-${Date.now()}`, title: s.headline, detail: s.evidence });
      }
      return { ...a, active: ids, ...(fresh.length ? { firedAt: Date.now() } : {}) };
    });

    if (changed) {
      setAlerts(next);
      setTriggered((t) => [...hits, ...t].slice(0, 5));
    }
  }, [sigData, alerts]);

  function add(e: React.FormEvent) {
    e.preventDefault();
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;
    setAlerts((a) => [
      {
        id: `${sym}-${dir}-${p}-${Date.now()}-${seq.current++}`,
        kind: "price",
        sym,
        above: dir === "above",
        price: p,
      },
      ...a,
    ]);
    setPrice("");
  }

  function addSignal(e: React.FormEvent) {
    e.preventDefault();
    setAlerts((a) => [
      {
        id: `sig-${sigKind}-${sigSym}-${Date.now()}-${seq.current++}`,
        kind: "signal",
        signalKind: sigKind,
        sym: sigSym,
        // Everything the queue publishes is already past its own threshold, so
        // a severity floor here would be a second opinion on a decision the
        // signal engine already made. Zero, and the reader filters by kind.
        minSeverity: 0,
      },
      ...a,
    ]);
  }

  // A dislocation alert is never spent, so it counts as armed whatever it has
  // already reported.
  const pending = alerts.filter((a) => a.kind === "signal" || !a.firedAt).length;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Alerts, ${pending} armed`}
        aria-expanded={open}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {pending > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent2)] px-1 font-mono text-[9px] font-bold text-[var(--on-accent)]">
            {pending}
          </span>
        )}
      </button>

      {/* Fired alerts surface as a stack in the corner, dismissible. */}
      {triggered.length > 0 && (
        <Overlay>
        <div className="fixed bottom-4 right-4 z-[150] flex w-72 flex-col gap-2">
          {triggered.map((t) => (
            <div key={t.key} className="card panel-accent p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words font-mono text-xs font-bold text-[var(--text)]">
                  {t.title}
                </span>
                <button
                  onClick={() => setTriggered((x) => x.filter((y) => y.key !== t.key))}
                  aria-label="Dismiss alert"
                  className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text3)] hover:text-[var(--text)]"
                >
                  ×
                </button>
              </div>
              <div className="mt-1 break-words font-mono text-[10px] text-[var(--text3)]">{t.detail}</div>
            </div>
          ))}
        </div>
        </Overlay>
      )}

      {open && (
        <Overlay>
        <div
          className="fixed inset-0 z-[160] flex items-start justify-end bg-black/40 p-4 pt-24"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="card w-full max-w-sm p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3
                className="panel-h cursor-help font-display text-[11px] font-bold uppercase tracking-[0.09em] underline decoration-dotted underline-offset-4"
                title="Stored in this browser and checked while the tab is open. Close it and nothing fires. A price alert fires once at its level; a dislocation alert keeps watching and reports each new signal."
              >
                Alerts
              </h3>
              <button onClick={() => setOpen(false)} aria-label="Close alerts" className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text3)] hover:text-[var(--text)]">
                ×
              </button>
            </div>

            <form onSubmit={add} className="flex flex-wrap items-center gap-2">
              <select
                value={sym}
                onChange={(e) => setSym(e.target.value)}
                aria-label="Symbol"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-xs text-[var(--text)]"
              >
                {ASSETS.map((a) => (
                  <option key={a.sym} value={a.sym}>
                    {a.sym}
                  </option>
                ))}
              </select>
              <select
                value={dir}
                onChange={(e) => setDir(e.target.value as "above" | "below")}
                aria-label="Direction"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-xs text-[var(--text)]"
              >
                <option value="above">above</option>
                <option value="below">below</option>
              </select>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="price"
                aria-label="Trigger price"
                className="w-24 rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-xs text-[var(--text)] placeholder:text-[var(--text3)]"
              />
              <button
                type="submit"
                className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--accent)]"
              >
                Set
              </button>
            </form>

            {/* The dislocation form. The queue is the reason to leave a
                terminal open, so being able to wait on it is the alert that
                matters most here. */}
            <form onSubmit={addSignal} className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border2)] pt-3">
              <span className="font-mono text-[11px] text-[var(--text3)]">tell me when</span>
              <select
                value={sigKind}
                onChange={(e) => setSigKind(e.target.value as SignalKind)}
                aria-label="Signal kind"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-xs text-[var(--text)]"
              >
                {SIGNAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <span className="font-mono text-[11px] text-[var(--text3)]">fires for</span>
              <select
                value={sigSym}
                onChange={(e) => setSigSym(e.target.value)}
                aria-label="Signal asset"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-xs text-[var(--text)]"
              >
                <option value="any">any asset</option>
                {ASSETS.map((a) => (
                  <option key={a.sym} value={a.sym}>
                    {a.sym}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--accent)]"
              >
                Watch
              </button>
            </form>

            <div className="mt-3 space-y-1.5">
              {alerts.length === 0 && (
                <div className="py-3 text-center font-mono text-[11px] text-[var(--text3)]">No alerts armed.</div>
              )}
              {alerts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface2)] px-2.5 py-1.5">
                  <span className="min-w-0 break-words font-mono text-[11px] text-[var(--text2)]">
                    {a.kind === "price" ? (
                      <>
                        <span className="font-bold text-[var(--text)]">{a.sym}</span>{" "}
                        {a.above ? "\u2265" : "\u2264"} {usd(a.price)}
                        {a.firedAt && <span className="ml-1.5 text-[var(--gold)]">fired</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-bold text-[var(--text)]">
                          {a.sym === "any" ? "any asset" : a.sym}
                        </span>{" "}
                        {KIND_LABEL[a.signalKind]}
                        {a.minSeverity > 0 && ` at ${a.minSeverity}+`}
                        {/* Count rather than a fired flag: this kind re-arms, so
                            "fired" alone would misdescribe it. */}
                        {a.active?.length ? (
                          <span className="ml-1.5 text-[var(--gold)]">{a.active.length} firing</span>
                        ) : null}
                      </>
                    )}
                  </span>
                  <button
                    onClick={() => setAlerts((x) => x.filter((y) => y.id !== a.id))}
                    aria-label="Remove alert"
                    className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text3)] hover:text-[var(--neg)]"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
        </Overlay>
      )}
    </>
  );
}

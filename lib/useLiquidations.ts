"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Binance USDT-margined futures all-market force-order stream. Payload shape
// (verified against the connector docs and the raw event typings):
//   { e:"forceOrder", E, o:{ s,S,o,f,q,p,ap,X,l,z,T } }
// Only the latest force order per symbol per 1000ms is pushed, so this is a
// snapshot tape rather than every single fill. Nothing is persisted: the
// totals below cover the current browser session only.

const WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";

/** Ring buffer caps. Three buffers so a filtered view is never empty just
 *  because the last 300 prints happened to be dust. */
const CAP_ALL = 300;
const CAP_10K = 150;
const CAP_100K = 100;

export type LiqSide = "long" | "short";
export type SocketStatus = "connecting" | "live" | "down";

export interface LiqEvent {
  /** Stable key: symbol + trade time + a monotonic counter (ties are common). */
  id: string;
  /** Order trade time in ms (o.T), which is the fill, not the event push. */
  ts: number;
  symbol: string;
  /** Display base, e.g. "1000PEPEUSDT" -> "PEPE". */
  base: string;
  side: LiqSide;
  qty: number;
  price: number;
  usd: number;
}

export interface SymbolTotal {
  symbol: string;
  base: string;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
}

export interface LiquidationsState {
  status: SocketStatus;
  /** Wall-clock ms when this session's counting began. */
  sessionStart: number;
  /** Most recent first. */
  tape: { all: LiqEvent[]; t10k: LiqEvent[]; t100k: LiqEvent[] };
  longUsd: number;
  shortUsd: number;
  count: number;
  largest: LiqEvent | null;
  /** Descending by total notional. */
  bySymbol: SymbolTotal[];
}

const QUOTES = ["USDT", "USDC", "BUSD", "USD"];

/** "1000PEPEUSDT" -> "PEPE". The 1000x contracts are a quoting convention, so
 *  collapsing them keeps the ranking readable. */
export function baseOf(symbol: string): string {
  let s = symbol;
  for (const q of QUOTES) {
    if (s.endsWith(q)) {
      s = s.slice(0, -q.length);
      break;
    }
  }
  return s.replace(/^1000000/, "").replace(/^1000/, "") || symbol;
}

/** The traded contract, e.g. "1000PEPEUSDT" -> "1000PEPE". Quantities on the
 *  1000x listings are counted in those contracts, not in the token, so a size
 *  must be labelled with this rather than with baseOf(). */
export function unitOf(symbol: string): string {
  for (const q of QUOTES) {
    if (symbol.endsWith(q)) return symbol.slice(0, -q.length);
  }
  return symbol;
}

function push<T>(buf: T[], item: T, cap: number): T[] {
  const next = [item, ...buf];
  return next.length > cap ? next.slice(0, cap) : next;
}

/**
 * Rolling liquidation tape and session totals.
 *
 * Side mapping, the field most often read backwards: the stream reports the
 * side of the *liquidating order the exchange sends to the book*, not the side
 * of the trader. A forced SELL closes a long position, so S:"SELL" means a
 * LONG was liquidated. S:"BUY" closes a short.
 */
export function useLiquidations(): LiquidationsState {
  const [state, setState] = useState<LiquidationsState>(() => ({
    status: "connecting",
    sessionStart: Date.now(),
    tape: { all: [], t10k: [], t100k: [] },
    longUsd: 0,
    shortUsd: 0,
    count: 0,
    largest: null,
    bySymbol: [],
  }));

  // Incoming prints are batched and flushed on a timer. A busy minute can push
  // hundreds of events and one setState per message would thrash React.
  const pending = useRef<LiqEvent[]>([]);
  const totals = useRef<Map<string, SymbolTotal>>(new Map());
  const seq = useRef(0);

  const ws = useRef<WebSocket | null>(null);
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  const flush = useCallback(() => {
    const batch = pending.current;
    if (batch.length === 0) return;
    pending.current = [];

    // Per-symbol accumulation happens here, outside the state updater, because
    // React may invoke an updater more than once and this map is a mutation.
    for (const e of batch) {
      const row = totals.current.get(e.symbol) ?? {
        symbol: e.symbol,
        base: e.base,
        longUsd: 0,
        shortUsd: 0,
        totalUsd: 0,
        count: 0,
      };
      if (e.side === "long") row.longUsd += e.usd;
      else row.shortUsd += e.usd;
      row.totalUsd += e.usd;
      row.count += 1;
      totals.current.set(e.symbol, row);
    }
    const bySymbol = [...totals.current.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => b.totalUsd - a.totalUsd);

    setState((prev) => {
      let { longUsd, shortUsd, count, largest } = prev;
      let all = prev.tape.all;
      let t10k = prev.tape.t10k;
      let t100k = prev.tape.t100k;
      // batch is oldest-first, so pushing in order leaves newest at index 0.
      for (const e of batch) {
        if (e.side === "long") longUsd += e.usd;
        else shortUsd += e.usd;
        count += 1;
        if (!largest || e.usd > largest.usd) largest = e;
        all = push(all, e, CAP_ALL);
        if (e.usd >= 10_000) t10k = push(t10k, e, CAP_10K);
        if (e.usd >= 100_000) t100k = push(t100k, e, CAP_100K);
      }
      return { ...prev, tape: { all, t10k, t100k }, longUsd, shortUsd, count, largest, bySymbol };
    });
  }, []);

  useEffect(() => {
    const flushTimer = setInterval(flush, 400);
    return () => clearInterval(flushTimer);
  }, [flush]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      setState((s) => ({ ...s, status: "down" }));
      return;
    }

    const parse = (raw: unknown) => {
      // Defensive: accept both the bare stream shape and the combined-stream
      // wrapper, and tolerate a missing avg price on a partially filled order.
      if (!raw || typeof raw !== "object") return;
      const outer = raw as Record<string, unknown>;
      const msg = (outer.data && typeof outer.data === "object" ? outer.data : outer) as Record<string, unknown>;
      if (msg.e !== "forceOrder") return;
      const o = msg.o as Record<string, unknown> | undefined;
      if (!o || typeof o.s !== "string") return;

      const qty = Number(o.z ?? o.q);
      const fallbackQty = Number(o.q);
      const q = Number.isFinite(qty) && qty > 0 ? qty : fallbackQty;
      const avg = Number(o.ap);
      const lim = Number(o.p);
      const px = Number.isFinite(avg) && avg > 0 ? avg : lim;
      if (!Number.isFinite(q) || !Number.isFinite(px) || q <= 0 || px <= 0) return;

      const ts = Number(o.T ?? msg.E);
      const symbol = o.s;
      const side: LiqSide = o.S === "SELL" ? "long" : "short";
      seq.current += 1;
      pending.current.push({
        id: `${symbol}-${ts}-${seq.current}`,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        symbol,
        base: baseOf(symbol),
        side,
        qty: q,
        price: px,
        usd: q * px,
      });
    };

    const connect = () => {
      if (closedByUs.current || document.hidden) return;
      setState((s) => (s.status === "live" ? s : { ...s, status: "connecting" }));
      let sock: WebSocket;
      try {
        sock = new WebSocket(WS_URL);
      } catch {
        schedule();
        return;
      }
      ws.current = sock;

      sock.onopen = () => {
        attempts.current = 0;
        setState((s) => ({ ...s, status: "live" }));
      };
      sock.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string);
          // The all-market stream has been observed to deliver either a single
          // event or an array of them, so handle both.
          if (Array.isArray(data)) data.forEach(parse);
          else parse(data);
        } catch {
          // A malformed frame should not kill the tape.
        }
      };
      sock.onerror = () => sock.close();
      sock.onclose = () => {
        ws.current = null;
        if (closedByUs.current) return;
        setState((s) => ({ ...s, status: "down" }));
        schedule();
      };
    };

    const schedule = () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      attempts.current += 1;
      // 1s, 2s, 4s ... capped at 30s so a long outage does not hammer Binance.
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempts.current - 1, 5));
      retryTimer.current = setTimeout(connect, wait);
    };

    const onVisibility = () => {
      if (document.hidden) {
        // Drop the socket in a background tab: the buffer would fill with
        // prints nobody saw and the totals would keep counting anyway.
        closedByUs.current = true;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        ws.current?.close();
        ws.current = null;
        setState((s) => ({ ...s, status: "down" }));
      } else {
        closedByUs.current = false;
        attempts.current = 0;
        // A socket the OS tore down while the page was suspended is still an
        // object here, with a readyState that says it is finished. Clear it
        // before reconnecting or the tape stays frozen looking live.
        const s = ws.current;
        if (s && s.readyState !== WebSocket.OPEN && s.readyState !== WebSocket.CONNECTING) {
          ws.current = null;
        }
        connect();
      }
    };

    // Restoring from the back/forward cache does not reliably fire
    // visibilitychange, and the sockets are dead by then.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && !document.hidden) onVisibility();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    connect();

    return () => {
      closedByUs.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      ws.current?.close();
      ws.current = null;
    };
  }, []);

  return state;
}

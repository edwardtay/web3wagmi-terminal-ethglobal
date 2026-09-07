"use client";

import { useEffect, useRef, useState } from "react";

// One combined Binance socket for the whole tracked universe. The CSP allows
// wss://stream.binance.com only, so this is the single upstream the browser is
// permitted to open directly; everything else goes through /api.

/** Payload of the !ticker stream, already parsed into numbers. */
export interface LiveQuote {
  pair: string;
  last: number;
  /** Price on the previous tick, so a cell can colour its move. */
  prev: number;
  /** 24h change in percent units. */
  changePct: number;
  /** 24h quote volume in USDT. */
  quoteVol: number;
  high: number;
  low: number;
  open: number;
  trades: number;
  dir: 1 | -1 | 0;
  /** Increments only when the price actually moved, so a flash can re-key on it. */
  seq: number;
  ts: number;
}

export interface StreamState {
  quotes: Record<string, LiveQuote>;
  connected: boolean;
  /** Epoch ms of the last committed batch. 0 before the first one. */
  lastTick: number;
}

/** Raw combined-stream frame. Binance sends single-letter keys. */
interface TickerFrame {
  stream: string;
  data: {
    s: string;
    c: string;
    P: string;
    q: string;
    h: string;
    l: string;
    o: string;
    n: number;
    E: number;
  };
}

const WS_BASE = "wss://stream.binance.com:9443/stream?streams=";

// 250ms is below the eye's flicker threshold for a number board but well above
// Binance's per-symbol cadence, so 27 symbols collapse into four renders a second.
const COMMIT_MS = 250;
const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribe to @ticker for every pair on one socket.
 *
 * @param pairs Binance spot pairs in upper case, e.g. ["BTCUSDT"]. The set is
 *              read once per identity change, so pass a stable array.
 */
export function useBinanceStream(pairs: string[]): StreamState {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [connected, setConnected] = useState(false);
  const [lastTick, setLastTick] = useState(0);

  // Buffer between socket frames and React. Written on every message, drained
  // by the commit timer.
  const pending = useRef<Record<string, LiveQuote>>({});
  const seen = useRef<Record<string, LiveQuote>>({});

  const key = pairs.join(",");

  useEffect(() => {
    if (!key) return;
    const list = key.split(",");

    let ws: WebSocket | null = null;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const commit = window.setInterval(() => {
      const batch = pending.current;
      const keys = Object.keys(batch);
      if (keys.length === 0) return;
      pending.current = {};
      setQuotes((prev) => ({ ...prev, ...batch }));
      setLastTick(Date.now());
    }, COMMIT_MS);

    function handle(raw: string) {
      let frame: TickerFrame;
      try {
        frame = JSON.parse(raw) as TickerFrame;
      } catch {
        return;
      }
      const d = frame?.data;
      if (!d || !d.s || !d.c) return;
      const last = Number(d.c);
      if (!Number.isFinite(last)) return;
      const before = pending.current[d.s] ?? seen.current[d.s];
      const prev = before ? before.last : last;
      const moved = before != null && last !== prev;
      const q: LiveQuote = {
        pair: d.s,
        last,
        prev,
        changePct: Number(d.P),
        quoteVol: Number(d.q),
        high: Number(d.h),
        low: Number(d.l),
        open: Number(d.o),
        trades: Number(d.n),
        dir: moved ? (last > prev ? 1 : -1) : (before?.dir ?? 0),
        seq: (before?.seq ?? 0) + (moved ? 1 : 0),
        ts: Number(d.E) || Date.now(),
      };
      pending.current[d.s] = q;
      seen.current[d.s] = q;
    }

    function open() {
      if (disposed || document.visibilityState === "hidden") return;
      const streams = list.map((p) => `${p.toLowerCase()}@ticker`).join("/");
      try {
        ws = new WebSocket(WS_BASE + streams);
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => handle(typeof e.data === "string" ? e.data : "");
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        schedule();
      };
    }

    // 1s, 2s, 4s ... capped at 30s, with +/-25% jitter so a Binance-side blip
    // does not bring every open tab back in the same millisecond.
    function schedule() {
      if (disposed || document.visibilityState === "hidden") return;
      if (reconnectTimer) return;
      const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry);
      retry += 1;
      const delay = base * (0.75 + Math.random() * 0.5);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    }

    function close() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        // Drop the handlers first: an intentional close must not trigger a retry.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
        ws = null;
      }
      setConnected(false);
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        // A backgrounded tab keeps a socket the OS may already have torn down,
        // and the board is not being read anyway.
        close();
      } else if (!ws) {
        retry = 0;
        open();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    open();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(commit);
      close();
    };
  }, [key]);

  return { quotes, connected, lastTick };
}

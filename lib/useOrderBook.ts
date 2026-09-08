"use client";

import { NA } from "./format";
import { useCallback, useSyncExternalStore } from "react";

// Book, depth chart and tape all read one socket per pair. Three panels on the
// same symbol would otherwise open three connections for data that arrives on
// a single combined stream.
//
// The book comes from <pair>@depth20@100ms, the partial-book stream, rather
// than the @depth diff stream. The diff stream needs a REST snapshot plus
// U/u sequence bookkeeping and silently rots if one frame is dropped; the
// partial stream is self-correcting every 100ms. 20 levels is all the widget
// shows anyway, and the deep curve comes from /api/depth instead.

export interface Level {
  price: number;
  qty: number;
}

export interface Book {
  bids: Level[];
  asks: Level[];
  ts: number;
  /** Where the current snapshot came from: the REST seed or the live stream. */
  src: "rest" | "ws";
}

export interface Print {
  /** Binance aggTrade id, monotonic per pair, used to drop replays. */
  id: number;
  price: number;
  qty: number;
  ts: number;
  /** True when the aggressor lifted the offer. m=true means the buyer was the
   *  maker, so the taker sold into the bid. */
  buy: boolean;
}

export interface StreamStatus {
  connected: boolean;
  /** Repeated failures with nothing to show. Panels render Unavailable. */
  failed: boolean;
}

const WS_ROOT = "wss://stream.binance.com:9443/stream?streams=";
const MAX_PRINTS = 80;
/** 4Hz. Past what the eye resolves on a book, and it keeps mobile CPU quiet. */
const FLUSH_MS = 250;
const MAX_BACKOFF_MS = 15_000;
/** Give a remount a moment to re-subscribe before tearing the socket down. */
const IDLE_CLOSE_MS = 4_000;

const EMPTY_PRINTS: Print[] = [];
const OFFLINE: StreamStatus = { connected: false, failed: false };

interface Store {
  pair: string;
  refs: number;
  ws: WebSocket | null;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  onVisibility: (() => void) | null;
  onPageShow: ((e: PageTransitionEvent) => void) | null;
  pendingBook: Book | null;
  pendingPrints: Print[];
  lastPrintId: number;
  book: Book | null;
  prints: Print[];
  status: StreamStatus;
  listeners: Set<() => void>;
}

const stores = new Map<string, Store>();

function getStore(pair: string): Store {
  let s = stores.get(pair);
  if (!s) {
    s = {
      pair,
      refs: 0,
      ws: null,
      attempts: 0,
      reconnectTimer: null,
      idleTimer: null,
      flushTimer: null,
      onVisibility: null,
      onPageShow: null,
      pendingBook: null,
      pendingPrints: [],
      lastPrintId: 0,
      book: null,
      prints: EMPTY_PRINTS,
      status: OFFLINE,
      listeners: new Set(),
    };
    stores.set(pair, s);
  }
  return s;
}

function emit(s: Store) {
  for (const fn of s.listeners) fn();
}

function setStatus(s: Store, next: Partial<StreamStatus>) {
  const merged = { ...s.status, ...next };
  if (merged.connected === s.status.connected && merged.failed === s.status.failed) return;
  s.status = merged;
  emit(s);
}

function parseLevels(raw: [string, string][] | undefined): Level[] {
  if (!Array.isArray(raw)) return [];
  const out: Level[] = [];
  for (const [p, q] of raw) {
    const price = Number(p);
    const qty = Number(q);
    if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) out.push({ price, qty });
  }
  return out;
}

function flush(s: Store) {
  let changed = false;
  if (s.pendingBook) {
    s.book = s.pendingBook;
    s.pendingBook = null;
    changed = true;
  }
  if (s.pendingPrints.length) {
    s.prints = [...s.pendingPrints, ...s.prints].slice(0, MAX_PRINTS);
    s.pendingPrints = [];
    changed = true;
  }
  if (changed) emit(s);
}

async function seed(s: Store) {
  try {
    const res = await fetch(`/api/depth?symbol=${encodeURIComponent(s.pair)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { ok?: boolean; bids?: Level[]; asks?: Level[] };
    // The stream always wins: only fill the gap before its first frame lands.
    if (!data?.ok || s.book || s.pendingBook) return;
    const bids = (data.bids ?? []).filter((l) => Number.isFinite(l.price));
    const asks = (data.asks ?? []).filter((l) => Number.isFinite(l.price));
    if (!bids.length || !asks.length) return;
    s.pendingBook = { bids, asks, ts: Date.now(), src: "rest" };
    flush(s);
  } catch {
    // A dead seed is not fatal; the socket is the real source.
  }
}

function open(s: Store) {
  if (s.ws || typeof window === "undefined") return;
  if (typeof document !== "undefined" && document.hidden) return;

  const p = s.pair.toLowerCase();
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${WS_ROOT}${p}@depth20@100ms/${p}@aggTrade`);
  } catch {
    scheduleReconnect(s);
    return;
  }
  s.ws = ws;

  ws.onopen = () => {
    s.attempts = 0;
    setStatus(s, { connected: true, failed: false });
  };

  ws.onmessage = (ev) => {
    let msg: { stream?: string; data?: unknown };
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    const stream = msg.stream ?? "";
    if (stream.includes("@depth")) {
      const d = msg.data as { bids?: [string, string][]; asks?: [string, string][] };
      const bids = parseLevels(d?.bids);
      const asks = parseLevels(d?.asks);
      if (bids.length && asks.length) s.pendingBook = { bids, asks, ts: Date.now(), src: "ws" };
    } else if (stream.includes("@aggTrade")) {
      const d = msg.data as { a?: number; p?: string; q?: string; T?: number; m?: boolean };
      const id = Number(d?.a);
      const price = Number(d?.p);
      const qty = Number(d?.q);
      if (!Number.isFinite(id) || id <= s.lastPrintId) return;
      if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
      s.lastPrintId = id;
      // Newest first, matching how the tape renders.
      s.pendingPrints.unshift({ id, price, qty, ts: Number(d?.T) || Date.now(), buy: d?.m !== true });
      if (s.pendingPrints.length > MAX_PRINTS) s.pendingPrints.length = MAX_PRINTS;
    }
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // close() throws only on an already-dead socket.
    }
  };

  ws.onclose = () => {
    if (s.ws === ws) s.ws = null;
    setStatus(s, { connected: false });
    if (s.refs > 0) scheduleReconnect(s);
  };
}

function scheduleReconnect(s: Store) {
  if (s.reconnectTimer || s.refs === 0) return;
  s.attempts += 1;
  // Three clean failures with nothing on screen means the venue or the network
  // is gone, so say so instead of spinning forever.
  if (s.attempts >= 3 && !s.book) setStatus(s, { failed: true });
  const wait = Math.min(MAX_BACKOFF_MS, 800 * 2 ** (s.attempts - 1));
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    open(s);
  }, wait);
}

function closeSocket(s: Store) {
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  const ws = s.ws;
  s.ws = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }
  setStatus(s, { connected: false });
}

function start(s: Store) {
  if (s.flushTimer) return;
  s.flushTimer = setInterval(() => flush(s), FLUSH_MS);
  s.onVisibility = () => {
    // A backgrounded tab does not need 10 frames a second, and mobile browsers
    // kill the socket anyway. Drop it and rebuild on return.
    if (document.hidden) {
      closeSocket(s);
    } else if (s.refs > 0) {
      s.attempts = 0;
      // A socket object whose readyState says it is finished still counts as
      // present to open(), so clear it first or the book never reconnects.
      if (s.ws && s.ws.readyState !== WebSocket.OPEN && s.ws.readyState !== WebSocket.CONNECTING) {
        closeSocket(s);
      }
      open(s);
      void seed(s);
    }
  };
  document.addEventListener("visibilitychange", s.onVisibility);
  // Restoring from the back/forward cache brings the page back with its sockets
  // already dead and does not reliably fire visibilitychange, so the book would
  // sit at whatever it held when the phone was locked, still looking live.
  s.onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted && !document.hidden) s.onVisibility?.();
  };
  window.addEventListener("pageshow", s.onPageShow);
  void seed(s);
  open(s);
}

function stop(s: Store) {
  closeSocket(s);
  if (s.flushTimer) {
    clearInterval(s.flushTimer);
    s.flushTimer = null;
  }
  if (s.onVisibility) {
    document.removeEventListener("visibilitychange", s.onVisibility);
    s.onVisibility = null;
  }
  if (s.onPageShow) {
    window.removeEventListener("pageshow", s.onPageShow);
    s.onPageShow = null;
  }
  s.attempts = 0;
  s.pendingBook = null;
  s.pendingPrints = [];
}

function subscribe(pair: string, cb: () => void): () => void {
  const s = getStore(pair);
  s.listeners.add(cb);
  s.refs += 1;
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  start(s);
  return () => {
    s.listeners.delete(cb);
    s.refs = Math.max(0, s.refs - 1);
    if (s.refs === 0 && !s.idleTimer) {
      s.idleTimer = setTimeout(() => {
        s.idleTimer = null;
        if (s.refs === 0) stop(s);
      }, IDLE_CLOSE_MS);
    }
  };
}

function useStream(pair: string) {
  const sub = useCallback((cb: () => void) => subscribe(pair, cb), [pair]);
  const book = useSyncExternalStore(
    sub,
    () => getStore(pair).book,
    () => null
  );
  const prints = useSyncExternalStore(
    sub,
    () => getStore(pair).prints,
    () => EMPTY_PRINTS
  );
  const status = useSyncExternalStore(
    sub,
    () => getStore(pair).status,
    () => OFFLINE
  );
  return { book, prints, status };
}

/** Live 20-level book for a Binance spot pair, e.g. "BTCUSDT". */
export function useOrderBook(pair: string): { book: Book | null; status: StreamStatus } {
  const { book, status } = useStream(pair);
  return { book, status };
}

/** Most recent aggregated prints, newest first, capped at 80. */
export function useTradeTape(pair: string): { prints: Print[]; status: StreamStatus } {
  const { prints, status } = useStream(pair);
  return { prints, status };
}

/**
 * Sizes span eight orders of magnitude across the universe (5.5 BTC against
 * 40M SHIB), so pick the decimals from the magnitude rather than fixing them.
 */
export function fmtSize(q: number): string {
  if (!Number.isFinite(q)) return NA;
  const a = Math.abs(q);
  if (a >= 1e6) return `${(q / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return q.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return q.toFixed(3);
  return q.toFixed(4);
}

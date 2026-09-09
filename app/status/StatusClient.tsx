"use client";

import { NA } from "@/lib/format";

import { useCallback, useEffect, useState } from "react";
import { Panel, AsOf } from "@/components/ui";

// Data integrity, checked from the browser rather than the server, so what you
// read here is exactly what the panels on the home page are getting.

interface Route {
  path: string;
  label: string;
  upstream: string;
}

const ROUTES: Route[] = [
  { path: "/api/signals", label: "Dislocation scan", upstream: "Binance, Deribit, DefiLlama" },
  { path: "/api/snapshot", label: "Snapshot", upstream: "Binance, CoinGecko, alternative.me" },
  { path: "/api/board", label: "Price board seed", upstream: "Binance spot" },
  { path: "/api/candles?symbol=BTC&interval=1h&limit=50", label: "Candles", upstream: "Binance spot" },
  { path: "/api/derivs", label: "Funding and open interest", upstream: "Binance futures, Hyperliquid" },
  { path: "/api/options?currency=BTC", label: "Options desk", upstream: "Deribit" },
  { path: "/api/depth?symbol=BTC", label: "Order book seed", upstream: "Binance spot" },
  { path: "/api/netflow", label: "Exchange netflow", upstream: "archive JSON-RPC nodes, Binance" },
  { path: "/api/dex", label: "DEX pools", upstream: "GeckoTerminal" },
  { path: "/api/chains", label: "Chain TVL", upstream: "DefiLlama" },
  { path: "/api/protocols", label: "Protocols, DEX volume, fees", upstream: "DefiLlama" },
  { path: "/api/stablecoins", label: "Stablecoins", upstream: "DefiLlama stablecoins" },
  { path: "/api/yields", label: "Yields", upstream: "DefiLlama yields" },
  { path: "/api/gas", label: "Gas and Bitcoin network", upstream: "public RPC nodes, mempool.space" },
  { path: "/api/quant", label: "Quant analytics", upstream: "Binance spot" },
  { path: "/api/screener", label: "Screener", upstream: "Binance spot" },
  { path: "/api/breadth", label: "Breadth and rotation", upstream: "Binance spot" },
  { path: "/api/stress", label: "Stress index", upstream: "Binance, Deribit, DefiLlama" },
  { path: "/api/unlocks", label: "Token unlocks", upstream: "DefiLlama emissions" },
  // Register a desk here when it is built, not after it fails. Both silent
  // outages this terminal has had were a large upstream document outgrowing its
  // timeout, and both went unnoticed because the route answered ok:false with
  // an empty list, which reads on the panel as a market statement rather than a
  // fetch that never finished. This page is what tells those two apart, and it
  // can only do it for routes it knows about.
  { path: "/api/revenue", label: "Fees and revenue", upstream: "DefiLlama fees" },
  { path: "/api/standards", label: "Standardized subgraphs", upstream: "The Graph gateway" },
  { path: "/api/brief", label: "The brief", upstream: "the desks below, plus the model" },
  { path: "/api/agents", label: "Agent registries", upstream: "The Graph, Agent0 subgraphs" },
];

interface Result {
  status: "checking" | "ok" | "degraded" | "down";
  ms: number;
  asOf?: string | null;
  note?: string;
}

export function StatusClient() {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const check = useCallback(async () => {
    setResults(Object.fromEntries(ROUTES.map((r) => [r.path, { status: "checking" as const, ms: 0 }])));
    await Promise.all(
      ROUTES.map(async (r) => {
        const t0 = performance.now();
        let out: Result;
        try {
          const res = await fetch(r.path, { cache: "no-store" });
          const ms = Math.round(performance.now() - t0);
          if (!res.ok) {
            out = { status: "down", ms, note: `HTTP ${res.status}` };
          } else {
            const json = (await res.json()) as { ok?: boolean; asOf?: string | null };
            // ok:false means the route answered but its upstream did not, which
            // is the degraded case the panels are designed to survive.
            out = {
              status: json.ok === false ? "degraded" : "ok",
              ms,
              asOf: json.asOf ?? null,
              note: json.ok === false ? "upstream returned nothing" : undefined,
            };
          }
        } catch (err) {
          out = {
            status: "down",
            ms: Math.round(performance.now() - t0),
            note: err instanceof Error ? err.message : "request failed",
          };
        }
        setResults((prev) => ({ ...prev, [r.path]: out }));
      })
    );
    setCheckedAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const counts = ROUTES.reduce(
    (acc, r) => {
      const s = results[r.path]?.status;
      if (s === "ok") acc.ok++;
      else if (s === "degraded") acc.degraded++;
      else if (s === "down") acc.down++;
      return acc;
    },
    { ok: 0, degraded: 0, down: 0 }
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="pill" style={{ color: "var(--pos)" }}>
          {counts.ok} live
        </span>
        <span className="pill" style={{ color: "var(--gold)" }}>
          {counts.degraded} degraded
        </span>
        <span className="pill" style={{ color: "var(--neg)" }}>
          {counts.down} down
        </span>
        <button
          onClick={() => void check()}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-mono text-[11px] font-semibold text-[var(--text2)] hover:border-[var(--accent)] hover:text-[var(--text)]"
        >
          Re-check
        </button>
        {checkedAt && <AsOf iso={checkedAt} />}
      </div>

      <Panel>
        <div className="thin-scroll overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Feed</th>
                <th>Upstream</th>
                <th>State</th>
                <th className="num">Latency</th>
                <th>Data age</th>
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((r) => {
                const res = results[r.path];
                const color =
                  res?.status === "ok"
                    ? "var(--pos)"
                    : res?.status === "degraded"
                      ? "var(--gold)"
                      : res?.status === "down"
                        ? "var(--neg)"
                        : "var(--text3)";
                return (
                  <tr key={r.path}>
                    <td>
                      <span className="font-semibold text-[var(--text)]">{r.label}</span>
                      <div className="font-mono text-[10px] text-[var(--text3)]">{r.path}</div>
                    </td>
                    <td>{r.upstream}</td>
                    <td>
                      <span className="font-mono text-[11px] font-bold" style={{ color }}>
                        {res?.status ?? "checking"}
                      </span>
                      {res?.note && <div className="text-[10px] text-[var(--text3)]">{res.note}</div>}
                    </td>
                    <td className="num">{res && res.ms > 0 ? `${res.ms} ms` : NA}</td>
                    <td>{res?.asOf ? <AsOf iso={res.asOf} /> : NA}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

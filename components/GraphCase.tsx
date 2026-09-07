"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { Panel, Loading, Unavailable, TokenIcon } from "./ui";
import { usdCompact, compact, num } from "@/lib/format";

// The live half of the Graph case page.
//
// Everything here is read from the same routes the terminal itself runs on, at
// the same moment, so the page cannot drift from the product it describes. That
// is the point: a case page with its own copy of the numbers is marketing, and
// a case page reading the live desk is evidence.

interface Dex {
  liquidityUsd: number;
  volumeUsd: number;
  deepest: string | null;
  inflowVsVolume: number | null;
}

interface Holders {
  symbol: string;
  holders: number;
  topShare: number | null;
  contractShare: number | null;
  walletShare: number | null;
}

interface Token {
  sym: string;
  kind: "stable" | "crypto";
  reservesUsd: number;
  flowUsd: Partial<Record<"h24" | "d7", number | null>>;
  dex?: Dex | null;
  holders?: Holders | null;
}

interface Netflow {
  ok: boolean;
  source: "graph" | "rpc" | null;
  note: string | null;
  tokens: Token[];
  coverage: { wallets: number; walletsTracked: number; venues: number; callsPerRefresh?: number; costPerMonthUsd?: number };
}

interface AskResult {
  ok: boolean;
  answer: string | null;
  used: { tool: string; bytes?: number; error?: string }[];
  note: string | null;
}

const TOOL_LABEL: Record<string, string> = {
  dislocation_queue: "what changed",
  exchange_flow: "exchange flow",
  derivatives: "funding",
};

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function signed(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${usdCompact(Math.abs(v))}`;
}

export function GraphCase() {
  const { data, loading, failed } = useApi<Netflow>("/api/netflow", 300);

  if (loading) {
    return (
      <Panel>
        <Loading rows={6} />
      </Panel>
    );
  }
  if (failed || !data?.ok) {
    return (
      <Panel>
        <Unavailable what={data?.note ? `The flow desk (${data.note})` : "The flow desk"} />
      </Panel>
    );
  }

  // Every tracked asset, not only the coins. A stablecoin has no absorption
  // ratio and showing it with the reason is more informative than leaving the
  // table with one row and one number in it.
  const rows = data.tokens;

  return (
    <div className="space-y-3">
      {/* The composed number, first, because it is the one thing neither
          product produces alone. */}
      <Panel
        title="Deposits against the venue that would absorb them"
        hint="Deposits from the Token API, liquidity from a Uniswap subgraph. The ratio needs both."
      >
        <div className="overflow-x-auto">
          <table className="tbl w-full">
            <thead>
              <tr>
                <th className="ident">Asset</th>
                <th className="num" title="Net, so a venue taking and sending the same amount reads flat.">
                  24h onto exchanges
                </th>
                <th className="num" title="Uniswap v3 on Ethereum only, so this is a floor on the real venue.">
                  Onchain liquidity
                </th>
                <th className="num" title="Last completed day, not the day in progress.">
                  Onchain daily volume
                </th>
                <th className="num" title="Coins arriving only. Higher means harder to absorb.">
                  Deposits vs volume
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.sym}>
                  <td>
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text)]"><TokenIcon sym={t.sym} />{t.sym}</span>
                    <div className="font-mono text-[10px] text-[var(--text3)]">
                      {t.kind === "stable" ? "stablecoin" : "coin"}
                    </div>
                  </td>
                  <td className="num text-[var(--text2)]">{signed(t.flowUsd.h24)}</td>
                  <td className="num text-[var(--text2)]">{t.dex ? usdCompact(t.dex.liquidityUsd) : "n/a"}</td>
                  <td className="num text-[var(--text2)]">{t.dex ? usdCompact(t.dex.volumeUsd) : "n/a"}</td>
                  <td className="num">
                    {t.kind === "stable" ? (
                      <span className="text-[var(--text3)]">
                        buying power
                        <span className="block font-mono text-[10px]">nothing to absorb</span>
                      </span>
                    ) : t.dex?.inflowVsVolume == null ? (
                      <span className="text-[var(--text3)]">
                        outflow
                        <span className="block font-mono text-[10px]">nothing arrived</span>
                      </span>
                    ) : (
                      <span
                        className="font-semibold"
                        style={{ color: t.dex.inflowVsVolume >= 1 ? "var(--neg)" : "var(--text2)" }}
                      >
                        {num(t.dex.inflowVsVolume, t.dex.inflowVsVolume < 10 ? 2 : 1)}x
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <a
          href="/#netflow"
          className="mt-2 inline-block font-mono text-[11px] text-[var(--text3)] underline hover:text-[var(--text)]"
        >
          See it on the live desk
        </a>
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Who holds the supply" hint="Contracts split from wallets: pools and bridges hold for many people, so the wallet share is the part that can act alone.">
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th className="ident">Asset</th>
                  <th className="num" title="Addresses with a non-zero balance, not people.">
                    Holders
                  </th>
                  <th className="num" title="Share of circulating supply, mostly infrastructure.">
                    Top 10
                  </th>
                  <th className="num" title="The share that can act alone.">
                    In wallets
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokens.filter((t) => t.holders).map((t) => (
                  <tr key={t.sym}>
                    <td>
                      <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text)]"><TokenIcon sym={t.sym} />{t.sym}</span>
                      {t.holders?.symbol && t.holders.symbol !== t.sym && (
                        <div className="font-mono text-[10px] text-[var(--text3)]">as {t.holders.symbol}</div>
                      )}
                    </td>
                    <td className="num text-[var(--text2)]">{compact(t.holders?.holders ?? 0, 0)}</td>
                    <td className="num text-[var(--text2)]">{pct(t.holders?.topShare)}</td>
                    <td className="num font-semibold text-[var(--text)]">{pct(t.holders?.walletShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="What it costs" hint="The Token API meters money, not calls. A time series read costs thirteen times a balance read, so the category a route picks matters more than shaving a call. Hourly would be $24.19 and every fifteen minutes $96.77, past the plan's hard cutoff.">
          <dl className="space-y-2 font-mono text-[12px]">
            {[
              ["Reads per refresh", String(data.coverage.callsPerRefresh ?? "n/a")],
              ["Cost per month", data.coverage.costPerMonthUsd != null ? `$${data.coverage.costPerMonthUsd.toFixed(2)}` : "n/a"],
              ["Free credit", "$25.00"],
              ["Refresh window", "4 hours"],
              ["Source answering", data.source ?? "none"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 border-b border-[var(--border2)] pb-1.5">
                <dt className="text-[var(--text3)]">{k}</dt>
                <dd className="text-right font-semibold text-[var(--text)]">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <AskBox />
    </div>
  );
}

function AskBox() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(question: string) {
    const text = question.trim();
    if (!text || pending) return;
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      setResult((await res.json()) as AskResult);
    } catch {
      setResult({ ok: false, answer: null, used: [], note: "The question could not be answered." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel
      title="Ask it"
      hint="Every number comes from a tool reading these routes. The desks it read are named below."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(q);
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="How concentrated is WBTC ownership?"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text3)] focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text2)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {pending ? "Reading" : "Ask"}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {[
          "What is unusual right now?",
          "Is there selling pressure building?",
          "How concentrated is WBTC ownership?",
        ].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setQ(s);
              submit(s);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--bg2)] px-2 py-1 text-left font-mono text-[10px] text-[var(--text3)] hover:border-[var(--accent)] hover:text-[var(--text)]"
          >
            {s}
          </button>
        ))}
      </div>

      {pending && <p className="mt-3 font-mono text-[11px] text-[var(--text3)]">Reading the desks...</p>}

      {!pending && result && (
        <div className="mt-3 border-t border-[var(--border2)] pt-3">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text)]">
            {result.answer ?? result.note}
          </p>
          {result.used.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-[var(--text3)]">
              <span>read</span>
              {[...new Set(result.used.map((u) => u.tool))].map((t) => (
                <span key={t} className="rounded border border-[var(--border)] bg-[var(--bg2)] px-1.5 py-0.5 text-[var(--text2)]">
                  {TOOL_LABEL[t] ?? t}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

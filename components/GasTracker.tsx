"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { AsOf, Loading, Panel, Segmented, TableWrap, Th, Unavailable} from "@/components/ui";
import { num, usd, NA } from "@/lib/format";

// Cost to transact, chain by chain. Sorted cheapest first because the ranking,
// and the size of the gap, is what a user is actually asking.

interface ChainGas {
  id: string;
  name: string;
  token: string;
  l2: boolean;
  ok: boolean;
  baseGwei: number;
  tipP10: number;
  tipP50: number;
  tipP90: number;
  effGwei: number;
  nativeUsd: number;
  transferUsd: number;
  swapUsd: number;
}

interface GasPayload {
  ok: boolean;
  asOf: string;
  transferGas: number;
  swapGas: number;
  chains: ChainGas[];
}

type Mode = "transfer" | "swap";

/** Gwei with decimals that suit the magnitude: L2s live below 0.01. */
function gwei(n: number): string {
  if (!Number.isFinite(n)) return NA;
  if (n === 0) return "0";
  if (n >= 100) return num(n, 1);
  if (n >= 1) return num(n, 3);
  if (n >= 0.001) return num(n, 5);
  return n.toExponential(1);
}

/** Sub-cent costs need more places than usd() gives, or an L2 reads $0.00. */
function cost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return NA;
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return usd(n);
}


export function GasTracker() {
  const { data, loading, failed } = useApi<GasPayload>("/api/gas", 60);
  const [mode, setMode] = useState<Mode>("transfer");

  const chains = data?.chains ?? [];
  const live = chains.filter((c) => c.ok);
  const dead = chains.filter((c) => !c.ok);

  const pick = (c: ChainGas) => (mode === "transfer" ? c.transferUsd : c.swapUsd);
  const max = live.reduce((m, c) => Math.max(m, pick(c)), 0);
  const min = live.reduce((m, c) => (m === 0 ? pick(c) : Math.min(m, pick(c))), 0);
  const gasUnits = mode === "transfer" ? data?.transferGas : data?.swapGas;

  return (
    <Panel
      hint="Priority fee percentiles over the last 20 blocks. Rollup fees are execution only and exclude the L1 data cost, so an L2 row understates the true total."
      title="Gas across chains"
      right={
        <div className="flex items-center gap-2">
          <Segmented<Mode>
            options={[
              { value: "transfer", label: "transfer" },
              { value: "swap", label: "swap" },
            ]}
            value={mode}
            onChange={setMode}
            ariaLabel="Transaction type to price"
          />
          <AsOf iso={data?.asOf} staleMs={5 * 60 * 1000} />
        </div>
      }
    >
      {loading ? (
        <Loading rows={4} />
      ) : failed || chains.length === 0 ? (
        <Unavailable what="Cross-chain gas" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--text3)]">
            <span>
              pricing {num(gasUnits ?? 0, 0)} gas units
            </span>
            {/* The spread multiple is gone. The table below is sorted by cost
                and shows both ends, so a ratio between them restated what the
                first and last rows already say. */}
          </div>

          {/* A table, not cards. Every chain carries the same six figures and the
              question asked of this panel is which is cheapest, which is a
              comparison down a column. In cards the tip percentiles wrapped
              onto three lines and read as prose. */}
          <TableWrap maxHeight={420} tight>
            <thead>
              <tr>
                <th scope="col" className="ident">Chain</th>
                <th scope="col" className="num">Cost</th>
                <Th label="vs cheapest" hint="Against the cheapest chain in this list." num />
                <Th label="All-in" hint="Base fee plus the median priority tip, which is what a transaction actually pays." num />
                <th scope="col" className="num">Base</th>
                <Th label="Tip p10 / p50 / p90" hint="10th, 50th and 90th percentile priority tip over the last 20 blocks, in gwei." num />
                <th scope="col" className="num">Native</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c, i) => {
                const v = pick(c);
                const ratio = min > 0 ? v / min : 1;
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="font-mono text-[10px] text-[var(--text3)]">{i + 1}</span>
                        <span className="break-words font-semibold text-[var(--text)]">{c.name}</span>
                        {c.l2 && (
                          <span
                            className="pill shrink-0 px-1.5 py-0 text-[9px]"
                            style={{ color: "var(--violet)" }}
                            title="Rollup: L2 execution fee only, excludes the L1 data fee"
                          >
                            L2
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num font-bold" style={{ color: i === 0 ? "var(--pos)" : "var(--text)" }}>
                      {cost(v)}
                    </td>
                    <td className="num text-[var(--text2)]">
                      {ratio <= 1.001 ? "cheapest" : `${num(ratio, ratio >= 100 ? 0 : 1)}x`}
                    </td>
                    <td className="num text-[var(--text2)]">{gwei(c.effGwei)}</td>
                    <td className="num text-[var(--text3)]">{gwei(c.baseGwei)}</td>
                    <td className="num text-[var(--text3)]">
                      {gwei(c.tipP10)} / {gwei(c.tipP50)} / {gwei(c.tipP90)}
                    </td>
                    <td className="num text-[var(--text3)]">
                      {c.token} {cost(c.nativeUsd)}
                    </td>
                  </tr>
                );
              })}

              {dead.map((c) => (
                <tr key={c.id}>
                  <td className="break-words font-semibold text-[var(--text2)]">{c.name}</td>
                  <td className="num text-[var(--text3)]" colSpan={6}>
                    {c.effGwei > 0
                      ? `${gwei(c.effGwei)} gwei, but no ${c.token} price came back this cycle`
                      : "RPC did not answer this cycle"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

        </>
      )}
    </Panel>
  );
}

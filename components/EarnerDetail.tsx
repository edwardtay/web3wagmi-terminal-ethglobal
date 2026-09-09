"use client";

import { useEffect, useState } from "react";
import { Sparkline } from "./ui";
import { usdCompact, num } from "@/lib/format";

// One earner, opened up.
//
// The board says a protocol took $71m. The three things a reader wants next are
// whether that is a trend or a spike, where it actually came from, and who owns
// the thing collecting it. The first two are the fee series and the chain
// split. The third is the Token API, and it is the part no fee aggregator
// answers: earnings and ownership normally live on two different sites, and the
// question worth asking sits between them.
//
// Fetched when the row is opened rather than with the board. Ninety days of
// history and an ownership read for a hundred and nine protocols nobody has
// clicked would be a large payload and a large number of Token API calls spent
// on rows that will never be looked at.

interface Detail {
  ok: boolean;
  name: string;
  symbol: string | null;
  description: string | null;
  url: string | null;
  chart: [number, number][];
  byChain: { chain: string; feesUsd: number }[];
  ownership: {
    network: string;
    contract: string;
    holders: number | null;
    topTenSharePct: number | null;
  } | null;
  ownershipNote: string | null;
  note: string | null;
}

export function EarnerDetail({ slug, colSpan }: { slug: string; colSpan: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setD(null);
    setFailed(false);
    fetch(`/api/earner?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((j: Detail) => {
        if (live) j?.ok ? setD(j) : setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [slug]);

  return (
    <tr>
      <td colSpan={colSpan} className="bg-[var(--bg2)] p-0">
        {/*
          Pinned to the left edge of the table's scrollport and sized to the
          window, not to the table.

          A full-width cell inside a horizontally scrolling table is as wide as
          the table, so on a phone half of this sat off-screen to the right and
          had to be scrolled sideways to read. None of it is tabular: it is a
          chart, some chips and a sentence, and all of that should wrap to the
          screen the reader has. Sticky keeps it in view while the columns
          beside it scroll normally.
        */}
        <div className="sticky left-0 w-[min(100%,100vw-2rem)] px-3 py-3">
        {failed ? (
          <p className="text-[11px] text-[var(--text3)]">That detail read is unavailable right now.</p>
        ) : !d ? (
          <p className="font-mono text-[11px] text-[var(--text3)]">reading…</p>
        ) : (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <Block label="Fees, 90 days">
              <Sparkline data={d.chart.map(([, v]) => v)} width={150} height={36} />
            </Block>

            <Block label="Earns on">
              <div className="flex flex-wrap gap-1">
                {d.byChain.length === 0 ? (
                  <span className="text-[11px] text-[var(--text3)]">not broken out</span>
                ) : (
                  d.byChain.map((c) => (
                    <span
                      key={c.chain}
                      className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-px font-mono text-[10px] text-[var(--text2)]"
                    >
                      {c.chain} {usdCompact(c.feesUsd)}
                    </span>
                  ))
                )}
              </div>
            </Block>

            <Block label={d.symbol ? `Who owns ${d.symbol}` : "Ownership"}>
              {d.ownership && d.ownership.topTenSharePct != null ? (
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-[13px] font-semibold text-[var(--text)]">
                    {d.ownership.topTenSharePct.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-[var(--text3)]">
                    held by the ten largest of {num(d.ownership.holders, 0)} addresses, on{" "}
                    {d.ownership.network}, read from The Graph
                  </span>
                </div>
              ) : (
                <span className="break-words text-[11px] text-[var(--text3)]">
                  {d.ownershipNote ?? "Ownership is not available for this one."}
                </span>
              )}
            </Block>

            {d.description && (
              <p className="w-full break-words border-t border-[var(--border2)] pt-2 text-[11px] leading-relaxed text-[var(--text2)]">
                {d.description.slice(0, 320)}
                {d.url && (
                  <>
                    {" "}
                    <a
                      href={d.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-[var(--accent)] underline decoration-dotted underline-offset-2"
                    >
                      site
                    </a>
                  </>
                )}
              </p>
            )}
          </div>
        )}
        </div>
      </td>
    </tr>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[var(--text3)]">{label}</div>
      {children}
    </div>
  );
}

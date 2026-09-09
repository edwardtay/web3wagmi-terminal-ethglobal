"use client";

import { Fragment, useMemo, useState } from "react";
import { useApi } from "@/lib/useApi";
import { Section, Panel, Loading, Unavailable, AsOf, Segmented, TableWrap, Th, useSort } from "./ui";
import { usdCompact, pctPlain } from "@/lib/format";
import { brandColor } from "@/lib/brandColors";
import { EarnerDetail } from "./EarnerDetail";

// The whole path a dollar takes, and every question about it reachable.
//
// Users pay a fee. Part is the suppliers' income, the liquidity providers and
// depositors who put up the capital, and never touches the protocol. The rest
// the protocol keeps. Part of what it keeps reaches token holders. Suppliers
// plus kept equals fees exactly, which is what makes the row readable across:
// Uniswap V4 took $107m over thirty days and kept none of it, Tether took
// $480m and kept all of it, and only the split says so.
//
// Every column sorts, because "who earns the most" and "who returns the most
// to holders" and "who is earning faster than usual" are three different
// questions that were previously one answer. The route ships the leaders of
// every column on every window rather than the biggest rows by fees, so a sort
// here ranks rows that are actually present: 21 of the top 25 by holder
// revenue sit outside the top 25 by fees, and this panel used to be unable to
// name any of them.
//
// Profit is not shown. It would be revenue minus token emissions, DefiLlama
// does not publish an earnings series here, and subtracting an incentives
// figure from a different adapter would look precise and not be comparable
// between rows. What reaches holders is the honest neighbour of the question.

type Period = "d1" | "d7" | "d30" | "y1" | "all";
type View = "apps" | "chains";

const PERIODS: { value: Period; label: string }[] = [
  { value: "d1", label: "24h" },
  { value: "d7", label: "7d" },
  { value: "d30", label: "30d" },
  { value: "y1", label: "1y" },
  { value: "all", label: "all time" },
];

const VIEWS: { value: View; label: string }[] = [
  { value: "apps", label: "Apps" },
  { value: "chains", label: "Chains" },
];

interface Row {
  name: string;
  slug: string | null;
  category: string | null;
  chains: string[];
  fees: Partial<Record<Period, number | null>>;
  revenue: Partial<Record<Period, number | null>>;
  supply: Partial<Record<Period, number | null>>;
  holders: Partial<Record<Period, number | null>>;
  takeRate: number | null;
  prior: Partial<Record<Period, number | null>>;
}
interface Payload {
  ok: boolean;
  asOf?: string;
  apps: Row[];
  chains: Row[];
  note: string | null;
}

/** One row resolved to the chosen window, because useSort ranks on flat keys. */
interface Flat {
  name: string;
  slug: string | null;
  category: string | null;
  fees: number | null;
  revenue: number | null;
  supply: number | null;
  holders: number | null;
  takeRate: number | null;
  /** Percent change against the window before this one, where one exists. */
  change: number | null;
}

export function Earners() {
  const { data, loading, failed } = useApi<Payload>("/api/revenue", 3600);
  const [period, setPeriod] = useState<Period>("d30");
  const [view, setView] = useState<View>("apps");

  const flat = useMemo<Flat[]>(() => {
    const src = view === "chains" ? (data?.chains ?? []) : (data?.apps ?? []);
    return src.map((r) => ({
      name: r.name,
      slug: r.slug,
      category: r.category,
      fees: r.fees[period] ?? null,
      revenue: r.revenue[period] ?? null,
      supply: r.supply?.[period] ?? null,
      holders: r.holders[period] ?? null,
      takeRate: r.takeRate,
      // Like against like: yesterday against the day before, this week against
      // last week, this month against the month before. A year and all time
      // have no prior window, so the column is empty there rather than
      // borrowing a different comparison and calling it the same thing.
      change: growth(r.fees[period] ?? null, r.prior?.[period] ?? null),
    }));
  }, [data, view, period]);

  const { sorted, key, dir, toggle } = useSort<Flat>(flat, { key: "fees" });
  const rows = sorted.slice(0, 25);
  const sort = { key, dir, toggle };
  const [open, setOpen] = useState<string | null>(null);

  // One open at a time. Two detail reads on screen means two sparklines at two
  // scales next to each other, which invites comparing them, and they are not
  // comparable: each is drawn to its own range.
  const COLUMNS = 7;

  const body = () => {
    if (loading) return <Loading rows={8} />;
    if (failed || !data?.ok || rows.length === 0) {
      return <Unavailable what="The fee and revenue feed" />;
    }
    return (
      <TableWrap maxHeight={520}>
        <thead>
          <tr>
            <Th
              label={view === "chains" ? "Chain" : "App"}
              hint="Open a row for ninety days of its fees, the chains they actually came from, and who holds its token, which is read from The Graph rather than from the fee source."
            />
            <Th
              label="Fees"
              sortKey="fees"
              sort={sort}
              num
              hint="Everything users paid to use it over the window. Not income: on a DEX most of this is the liquidity providers' and never touches the protocol."
            />
            <Th
              label="To suppliers"
              sortKey="supply"
              sort={sort}
              num
              hint="The part of those fees paid out to whoever put up the capital: liquidity providers, depositors, stakers. This plus what the protocol kept is the whole fee, to the cent."
            />
            <Th
              label="Kept"
              sortKey="revenue"
              sort={sort}
              num
              hint="The protocol's own revenue, what is left of the fee after the suppliers are paid. Sort on this to ask who runs the largest business rather than who moves the most money."
            />
            <Th
              label="Take"
              sortKey="takeRate"
              sort={sort}
              num
              hint="What it kept as a share of what users paid, over thirty days. A DEX keeps a sliver because the rest is the liquidity providers' income; a stablecoin issuer keeps nearly all of it because there is nobody to share with. Thirty days rather than one, since a single quiet day makes the ratio meaningless."
            />
            <Th
              label="To holders"
              sortKey="holders"
              sort={sort}
              num
              hint="The part of revenue that reaches token holders, through buybacks or distributions. The closest honest reading of profit available here, since emissions are not published. Blank means none is reported, which is not the same as none reaching them."
            />
            <Th
              label={CHANGE_LABEL[period]}
              sortKey="change"
              sort={sort}
              num
              hint="Fees over this window against the window immediately before it: yesterday against the day before, this week against last week, this month against the month before. It says nothing about size, only about direction, so a small protocol doubling is still small. Empty on the year and all-time views, which have no prior window to sit beside, and empty where the earlier window was under a thousand dollars, since a percentage off almost nothing is not a statement."
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.name}>
            <tr
              onClick={() => r.slug && setOpen((v) => (v === r.slug ? null : r.slug))}
              className={r.slug ? "cursor-pointer" : undefined}
            >
              <td>
                <div className="flex items-center gap-1.5">
                  {view === "chains" && (
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: brandColor(r.name) ?? "var(--text3)" }}
                      aria-hidden
                    />
                  )}
                  <span className="break-words font-semibold text-[var(--text)]">{r.name}</span>
                </div>
                {r.category && view !== "chains" && (
                  <div className="font-mono text-[10px] text-[var(--text3)]">{r.category}</div>
                )}
                {r.slug && (
                  <div className="font-mono text-[9px] text-[var(--text3)]">
                    {open === r.slug ? "hide detail" : "detail"}
                  </div>
                )}
              </td>
              <td className="num text-[var(--text)]">{usdCompact(r.fees)}</td>
              <td className="num text-[var(--text2)]">{usdCompact(r.supply)}</td>
              <td className="num font-semibold text-[var(--text)]">{usdCompact(r.revenue)}</td>
              <td className="num" style={{ color: (r.takeRate ?? 0) > 0.8 ? "var(--gold)" : undefined }}>
                {r.takeRate == null ? "n/a" : pctPlain(r.takeRate * 100, 0)}
              </td>
              <td className="num text-[var(--text2)]">{usdCompact(r.holders)}</td>
              <td className="num" style={{ color: changeColor(r.change) }}>
                {r.change == null ? "n/a" : `${r.change > 0 ? "+" : ""}${Math.round(r.change)}%`}
              </td>
            </tr>
            {open === r.slug && r.slug && <EarnerDetail slug={r.slug} colSpan={COLUMNS} />}
            </Fragment>
          ))}
        </tbody>
      </TableWrap>
    );
  };

  return (
    <Section
      title="Who earns"
      id="earners"
      hint="Fees are what users paid. Part is the suppliers' income and never touches the protocol; the rest it keeps, and part of that reaches token holders. Every column sorts, because who earns the most and who returns the most to holders are different questions with different answers. Profit is not shown: it would be revenue minus token emissions, that series is not published here, and combining two adapters would give a figure that looks precise and is not comparable between rows."
      right={
        <>
          <Segmented<View> options={VIEWS} value={view} onChange={setView} ariaLabel="Apps or chains" />
          <Segmented<Period> options={PERIODS} value={period} onChange={setPeriod} ariaLabel="Window" />
          <AsOf iso={data?.asOf} staleMs={2 * 60 * 60 * 1000} />
        </>
      }
    >
      <Panel>{body()}</Panel>
    </Section>
  );
}

/** What the change column is actually comparing, said in the header. */
const CHANGE_LABEL: Record<Period, string> = {
  d1: "vs prev day",
  d7: "vs prev week",
  d30: "vs prev month",
  y1: "Change",
  all: "Change",
};

/**
 * Percent change, withheld where the earlier window was too small to divide by.
 *
 * The same guard every ratio on this terminal carries. A protocol that took
 * four hundred dollars last week and eleven thousand this week is up 2,650%,
 * and printing that beside Uniswap doubling on $52m says the smaller number is
 * the bigger story.
 */
function growth(now: number | null, before: number | null): number | null {
  if (now == null || before == null || before < 1_000) return null;
  return (now / before - 1) * 100;
}

/**
 * Colour only where the move is decisive.
 *
 * A row up 4% is inside its own noise and colouring it would invent a signal.
 * The thresholds are wide on purpose.
 */
function changeColor(change: number | null): string | undefined {
  if (change == null) return undefined;
  if (change >= 25) return "var(--pos)";
  if (change <= -25) return "var(--neg)";
  return undefined;
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AsOf, ChangeChip, InfoHint, LivePill, Loading, Panel, TableWrap, Unavailable } from "@/components/ui";
import { pctPlain, price, usdCompact, NA } from "@/lib/format";
import { useSymbol } from "@/lib/useSymbol";
import { ASSETS, prettyPair, type Sector } from "@/lib/symbols";
import { useApi } from "@/lib/useApi";
import { useBinanceStream } from "@/lib/useBinanceStream";

// Mirrors the /api/board row. Declared here rather than imported from the
// route so nothing in the client bundle reaches into a server-only module.
interface BoardRow {
  sym: string;
  name: string;
  sector: string;
  pair: string;
  last: number;
  changePct: number;
  quoteVol: number;
  high: number;
  low: number;
  open: number;
  trades: number;
}

interface BoardPayload {
  ok: boolean;
  rows: BoardRow[];
  asOf: string;
}

type SortKey = "sym" | "last" | "changePct" | "rangePos" | "quoteVol" | "sector";

interface Row extends BoardRow {
  /** Where last sits inside the 24h low-high band, 0 at the low, 100 at the high. */
  rangePos: number;
  live: boolean;
  dir: 1 | -1 | 0;
  seq: number;
}

const PAIRS = ASSETS.map((a) => a.pair);
const SECTORS: Sector[] = ["Majors", "L1", "L2", "DeFi", "AI", "Infra", "Meme", "Exchange"];


export function LiveBoard() {
  // The focused instrument reads as a marked row here rather than filtering the
  // table, since the ranking against everything else is the point of the panel.
  const { symbol: focus } = useSymbol();

  const { data, loading, failed } = useApi<BoardPayload>("/api/board", 60);
  const { quotes, connected, lastTick } = useBinanceStream(PAIRS);

  const [sort, setSort] = useState<SortKey>("quoteVol");
  const [desc, setDesc] = useState(true);
  const [sector, setSector] = useState<Sector | "All">("All");

  const rows = useMemo<Row[]>(() => {
    const seed = data?.rows ?? [];
    // Fall back to the ASSETS list itself so the board still lists every name
    // when the seed route is down and only the socket is feeding it.
    const base: BoardRow[] =
      seed.length > 0
        ? seed
        : ASSETS.map((a) => ({
            sym: a.sym,
            name: a.name,
            sector: a.sector,
            pair: a.pair,
            last: NaN,
            changePct: NaN,
            quoteVol: NaN,
            high: NaN,
            low: NaN,
            open: NaN,
            trades: 0,
          }));

    return base
      .map((r) => {
        const q = quotes[r.pair];
        const last = q ? q.last : r.last;
        const high = q ? q.high : r.high;
        const low = q ? q.low : r.low;
        const band = high - low;
        return {
          ...r,
          last,
          high,
          low,
          changePct: q ? q.changePct : r.changePct,
          quoteVol: q ? q.quoteVol : r.quoteVol,
          trades: q ? q.trades : r.trades,
          rangePos: band > 0 ? ((last - low) / band) * 100 : NaN,
          live: Boolean(q),
          dir: q ? q.dir : 0,
          seq: q ? q.seq : 0,
        };
      })
      .filter((r) => Number.isFinite(r.last));
  }, [data, quotes]);

  const shown = useMemo(() => {
    const f = sector === "All" ? rows : rows.filter((r) => r.sector === sector);
    const dir = desc ? -1 : 1;
    return [...f].sort((a, b) => {
      if (sort === "sym") return a.sym.localeCompare(b.sym) * dir;
      if (sort === "sector") return (a.sector.localeCompare(b.sector) || a.sym.localeCompare(b.sym)) * dir;
      const av = a[sort];
      const bv = b[sort];
      // Rows missing a metric sink to the bottom whichever way the sort runs.
      if (!Number.isFinite(av)) return 1;
      if (!Number.isFinite(bv)) return -1;
      return (av - bv) * dir;
    });
  }, [rows, sector, sort, desc]);

  function toggle(k: SortKey) {
    if (k === sort) setDesc((d) => !d);
    else {
      setSort(k);
      setDesc(k !== "sym" && k !== "sector");
    }
  }

  const ariaSort = (k: SortKey): "ascending" | "descending" | "none" =>
    sort === k ? (desc ? "descending" : "ascending") : "none";

  const advancing = shown.filter((r) => r.changePct > 0).length;

  const head = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text3)]">
        {advancing}/{shown.length} up
      </span>
      <LivePill live={connected} label={connected ? "streaming" : "rest seed"} />
      {connected && lastTick > 0 ? (
        <AsOf iso={new Date(lastTick).toISOString()} staleMs={30_000} />
      ) : (
        <AsOf iso={data?.asOf} staleMs={5 * 60_000} />
      )}
    </div>
  );

  return (
    <Panel
      right={head}
    >
      <div className="mb-3 flex flex-wrap gap-1">
        <SectorChip label="All" active={sector === "All"} onClick={() => setSector("All")} count={rows.length} />
        {SECTORS.map((s) => {
          const n = rows.filter((r) => r.sector === s).length;
          if (n === 0) return null;
          return (
            <SectorChip key={s} label={s} active={sector === s} onClick={() => setSector(s)} count={n} />
          );
        })}
      </div>

      {loading && rows.length === 0 ? (
        <Loading rows={8} />
      ) : shown.length === 0 ? (
        <Unavailable what={failed ? "The live board" : "This sector"} />
      ) : (
        <TableWrap maxHeight={560}>
          <thead>
            <tr>
              <Th k="sym" sort={sort} ariaSort={ariaSort} onClick={toggle} label="Asset" />
              <Th k="last" sort={sort} ariaSort={ariaSort} onClick={toggle} num label="Last" />
              <Th k="changePct" sort={sort} ariaSort={ariaSort} onClick={toggle} num label="24h %" />
              <Th
                k="rangePos"
                sort={sort}
                ariaSort={ariaSort}
                onClick={toggle}
                num
                label="24h range"
              />
              <Th k="quoteVol" sort={sort} ariaSort={ariaSort} onClick={toggle} num label="24h vol" />
              <Th k="sector" sort={sort} ariaSort={ariaSort} onClick={toggle} label="Sector" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.sym} style={r.sym === focus ? { boxShadow: "inset 3px 0 0 0 var(--accent2)" } : undefined}>
                <td className="min-w-0">
                  <Link href={`/s/${r.sym}`} className="flex min-w-0 flex-col gap-0.5 hover:text-[var(--accent)]">
                    <span className="font-mono text-[12px] font-bold" style={{ overflowWrap: "anywhere" }}>
                      {r.sym}
                    </span>
                    <span className="text-[10px] text-[var(--text3)]" style={{ overflowWrap: "anywhere" }}>
                      {r.name}
                    </span>
                  </Link>
                </td>
                <td className="num">
                  <span
                    key={r.seq}
                    className={`inline-block rounded px-1 font-semibold ${
                      r.seq > 0 && r.dir === 1 ? "flash-up" : r.seq > 0 && r.dir === -1 ? "flash-down" : ""
                    }`}
                    title={`${prettyPair(r.pair)} last traded`}
                  >
                    {price(r.last)}
                  </span>
                </td>
                <td className="num">
                  <ChangeChip value={r.changePct} />
                </td>
                <td className="num">
                  <RangeGauge pos={r.rangePos} low={r.low} high={r.high} />
                </td>
                <td className="num" title={`${prettyPair(r.pair)} quote volume over the last 24h`}>
                  {usdCompact(r.quoteVol, 1)}
                </td>
                <td>
                  <span className="chip-flat rounded px-1.5 py-0.5 text-[10px]" style={{ overflowWrap: "anywhere" }}>
                    {r.sector}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------- pieces -- */

function Th({
  k,
  sort,
  ariaSort,
  onClick,
  label,
  num,
  hint,
}: {
  k: SortKey;
  sort: SortKey;
  ariaSort: (k: SortKey) => "ascending" | "descending" | "none";
  onClick: (k: SortKey) => void;
  label: string;
  num?: boolean;
  hint?: string;
}) {
  const state = ariaSort(k);
  const active = sort === k;
  return (
    // The hint is a button rather than a title attribute, which has no touch
    // equivalent, and the sort target carries padding so it is not a 12px
    // line to hit on a phone.
    <th className={num ? "num" : undefined} aria-sort={state} scope="col">
      <span className={`inline-flex items-center gap-1 ${num ? "flex-row-reverse" : ""}`}>
        <button
          type="button"
          onClick={() => onClick(k)}
          className={`-my-1 inline-flex items-center gap-1 py-1 ${active ? "text-[var(--text)]" : ""}`}
          aria-label={`Sort by ${label}`}
        >
          {label}
          <span aria-hidden className="font-mono text-[9px]">
            {state === "none" ? "" : state === "descending" ? "▼" : "▲"}
          </span>
        </button>
        {hint ? <InfoHint text={hint} align={num ? "right" : "left"} /> : null}
      </span>
    </th>
  );
}

function SectorChip({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2 py-1 font-mono text-[10px] font-semibold ${
        active
          ? "border-[var(--accent)] text-[var(--text)]"
          : "border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)]"
      }`}
      style={{ background: active ? "var(--surface2)" : "transparent" }}
    >
      {label} <span className="text-[var(--text3)]">{count}</span>
    </button>
  );
}

/** Position of last inside the 24h band, as a bar plus the percentage. */
function RangeGauge({ pos, low, high }: { pos: number; low: number; high: number }) {
  if (!Number.isFinite(pos)) return <span className="text-[var(--text3)]">{NA}</span>;
  const p = Math.min(100, Math.max(0, pos));
  // Extremes carry the signal: near the low is distribution, near the high is
  // a fresh session high. The middle stays muted so the edges stand out.
  const c = p >= 75 ? "var(--pos)" : p <= 25 ? "var(--neg)" : "var(--text3)";
  return (
    <div className="flex items-center justify-end gap-2" title={`Low ${price(low)} · High ${price(high)}`}>
      <div className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--surface2)]">
        <div className="absolute top-0 h-full w-[2px] rounded" style={{ left: `${p}%`, background: c }} />
        <div className="h-full rounded-full opacity-40" style={{ width: `${p}%`, background: c }} />
      </div>
      <span className="w-10 text-right" style={{ color: c }}>
        {pctPlain(p, 0)}
      </span>
    </div>
  );
}

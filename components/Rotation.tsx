"use client";

import { BarCell, Loading, Panel, TableWrap, Th, Unavailable} from "@/components/ui";
import { pct, signColor } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { useNarrow } from "@/lib/useNarrow";

// Sector rotation over the tracked universe. Two views of the same numbers:
// a ranked median-return table, and a relative-strength quadrant that shows
// where each sector sits versus BTC and which way it is heading.

interface SectorPoint {
  x: number;
  y: number;
}

interface SectorRow {
  sector: string;
  n: number;
  m24: number | null;
  m7: number | null;
  m30: number | null;
  x: number | null;
  y: number | null;
  trail: SectorPoint[];
}

interface RotationPayload {
  ok: boolean;
  asOf: string;
  sectors: SectorRow[];
}


/**
 * Seven distinguishable theme tokens for eight sectors, so one colour repeats.
 * Every dot carries its own label, which is what actually identifies it.
 */
const SECTOR_COLOR: Record<string, string> = {
  Majors: "var(--accent)",
  L1: "var(--cyan)",
  L2: "var(--violet)",
  DeFi: "var(--pos)",
  AI: "var(--neg)",
  Meme: "var(--accent2)",
  Infra: "var(--text2)",
  Exchange: "var(--accent)",
};

function colorFor(sector: string): string {
  return SECTOR_COLOR[sector] ?? "var(--text2)";
}

function quadrant(x: number, y: number): string {
  if (x >= 0) return y >= 0 ? "leading" : "weakening";
  return y >= 0 ? "improving" : "lagging";
}

/**
 * Two shapes, for the same reason the risk scatter has two.
 *
 * This one was rendered at a fixed 540px inside a fixed width wrapper, so a
 * phone got a horizontal scrollbar under a quadrant chart. A quadrant chart is
 * read by where things sit relative to the crossing lines, which means seeing
 * all four quadrants at once, which is exactly what scrolling takes away.
 */
type Dims = { W: number; H: number; PAD: { l: number; r: number; t: number; b: number } };

const WIDE: Dims = { W: 540, H: 400, PAD: { l: 46, r: 18, t: 18, b: 36 } };
const NARROW: Dims = { W: 340, H: 340, PAD: { l: 40, r: 12, t: 14, b: 34 } };

function Quadrant({ rows }: { rows: SectorRow[] }) {
  // Square and smaller on a phone, wide on a desk.
  const D = useNarrow(640) ? NARROW : WIDE;
  const plotted = rows.filter((r) => r.x != null && r.y != null);
  if (!plotted.length) return <Unavailable what="The rotation quadrant" />;

  const all = plotted.flatMap((r) => [...r.trail, { x: r.x as number, y: r.y as number }]);
  // Symmetric domain keeps the origin dead centre, which is what makes the
  // four quadrants readable at a glance. Floor of 5pp stops a quiet tape from
  // magnifying noise into apparent rotation.
  const m = Math.max(5, Math.ceil(Math.max(...all.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 1.15));
  const pw = D.W - D.PAD.l - D.PAD.r;
  const ph = D.H - D.PAD.t - D.PAD.b;
  const sx = (v: number) => D.PAD.l + ((v + m) / (2 * m)) * pw;
  const sy = (v: number) => D.PAD.t + ((m - v) / (2 * m)) * ph;
  const cx = sx(0);
  const cy = sy(0);
  const ticks = [-m, -m / 2, 0, m / 2, m];

  const quads: { label: string; x: number; y: number; fill: string; anchor: "start" | "end" }[] = [
    { label: "LEADING", x: D.W - D.PAD.r - 6, y: D.PAD.t + 14, fill: "var(--pos)", anchor: "end" },
    { label: "WEAKENING", x: D.W - D.PAD.r - 6, y: D.H - D.PAD.b - 6, fill: "var(--gold)", anchor: "end" },
    { label: "LAGGING", x: D.PAD.l + 6, y: D.H - D.PAD.b - 6, fill: "var(--neg)", anchor: "start" },
    { label: "IMPROVING", x: D.PAD.l + 6, y: D.PAD.t + 14, fill: "var(--cyan)", anchor: "start" },
  ];

  return (
    <svg
      viewBox={`0 0 ${D.W} ${D.H}`}
      width="100%"
      role="img"
      aria-label="Sector relative strength versus BTC over 30 days, plotted against its 7 day change"
      style={{ height: "auto", maxWidth: "100%" }}
    >
      <rect
        x={D.PAD.l}
        y={D.PAD.t}
        width={pw}
        height={ph}
        fill="var(--bg2)"
        stroke="var(--border)"
        rx={8}
      />
      {/* Quadrant washes, faint enough that the dots stay the loudest thing. */}
      <rect x={cx} y={D.PAD.t} width={D.W - D.PAD.r - cx} height={cy - D.PAD.t} fill="var(--pos)" opacity={0.06} />
      <rect x={cx} y={cy} width={D.W - D.PAD.r - cx} height={D.H - D.PAD.b - cy} fill="var(--gold)" opacity={0.06} />
      <rect x={D.PAD.l} y={cy} width={cx - D.PAD.l} height={D.H - D.PAD.b - cy} fill="var(--neg)" opacity={0.06} />
      <rect x={D.PAD.l} y={D.PAD.t} width={cx - D.PAD.l} height={cy - D.PAD.t} fill="var(--cyan)" opacity={0.06} />

      {ticks.map((t) => (
        <g key={`gx${t}`}>
          <line x1={sx(t)} y1={D.PAD.t} x2={sx(t)} y2={D.H - D.PAD.b} stroke="var(--border)" strokeWidth={t === 0 ? 1.4 : 0.6} />
          <text x={sx(t)} y={D.H - D.PAD.b + 14} textAnchor="middle" fontSize={9} fill="var(--text3)" fontFamily="monospace">
            {t > 0 ? `+${t.toFixed(0)}` : t.toFixed(0)}
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={`gy${t}`}>
          <line x1={D.PAD.l} y1={sy(t)} x2={D.W - D.PAD.r} y2={sy(t)} stroke="var(--border)" strokeWidth={t === 0 ? 1.4 : 0.6} />
          <text x={D.PAD.l - 6} y={sy(t) + 3} textAnchor="end" fontSize={9} fill="var(--text3)" fontFamily="monospace">
            {t > 0 ? `+${t.toFixed(0)}` : t.toFixed(0)}
          </text>
        </g>
      ))}

      {quads.map((q) => (
        <text
          key={q.label}
          x={q.x}
          y={q.y}
          textAnchor={q.anchor}
          fontSize={9}
          fontWeight={700}
          letterSpacing="0.12em"
          fill={q.fill}
          opacity={0.75}
          fontFamily="monospace"
        >
          {q.label}
        </text>
      ))}

      {plotted.map((r) => {
        const c = colorFor(r.sector);
        const pts = [...r.trail];
        const path = pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
        const hx = sx(r.x as number);
        const hy = sy(r.y as number);
        // Nudge the label inside the frame when a sector sits near the right edge.
        const flip = hx > D.W - D.PAD.r - 62;
        return (
          <g key={r.sector}>
            {pts.length > 1 && (
              <polyline points={path} fill="none" stroke={c} strokeWidth={1.2} opacity={0.4} strokeLinejoin="round" />
            )}
            {pts.slice(0, -1).map((p, i) => (
              <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={1.8} fill={c} opacity={0.35} />
            ))}
            <circle cx={hx} cy={hy} r={5} fill={c} stroke="var(--surface)" strokeWidth={1.2} />
            <text
              x={flip ? hx - 8 : hx + 8}
              y={hy + 3.5}
              textAnchor={flip ? "end" : "start"}
              fontSize={10}
              fontWeight={700}
              fill="var(--text)"
              fontFamily="monospace"
            >
              {r.sector}
            </text>
          </g>
        );
      })}

      <text x={D.W / 2} y={D.H - 3} textAnchor="middle" fontSize={9} fill="var(--text3)" fontFamily="monospace">
        median 30d return vs BTC (pp)
      </text>
      <text
        x={12}
        y={D.H / 2}
        textAnchor="middle"
        fontSize={9}
        fill="var(--text3)"
        fontFamily="monospace"
        transform={`rotate(-90 12 ${D.H / 2})`}
      >
        7d change in that gap (pp)
      </text>
    </svg>
  );
}

export function Rotation() {
  const { data, loading, failed } = useApi<RotationPayload>("/api/breadth", 900);

  if (loading) {
    return (
      <Panel title="Sector rotation">
        <Loading rows={8} />
      </Panel>
    );
  }
  if (failed || !data?.ok || !data.sectors.length) {
    return (
      <Panel title="Sector rotation">
        <Unavailable what="Sector rotation" />
      </Panel>
    );
  }

  const rows = data.sectors;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.m7 ?? 0)));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Panel title="Sector performance" hint="Equal-weighted medians of the tracked universe, sorted by 7d. Sector labels come from this terminal's own asset list.">
        <TableWrap maxHeight={420}>
          <thead>
            <tr>
              <th scope="col">Sector</th>
              <Th label="N" hint="Members of the tracked universe in this sector" num />
              <th scope="col" className="num">
                24h
              </th>
              <th scope="col" className="num">
                7d
              </th>
              <th scope="col" className="num">
                30d
              </th>
              <th scope="col">7d rank</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sector}>
                <td className="font-semibold text-[var(--text)]">{r.sector}</td>
                <td className="num">{r.n}</td>
                <td className="num" style={{ color: signColor(r.m24) }}>
                  {pct(r.m24)}
                </td>
                <td className="num" style={{ color: signColor(r.m7) }}>
                  {pct(r.m7)}
                </td>
                <td className="num" style={{ color: signColor(r.m30) }}>
                  {pct(r.m30)}
                </td>
                <td className="w-24 min-w-[72px] align-middle">
                  <BarCell value={r.m7 ?? 0} max={maxAbs} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Panel>

      <Panel title="Relative rotation vs BTC">
        {/* No fixed width and no scroller. The chart picks a shape that fits,
            so there is nothing left to scroll to. */}
        <div className="-mx-1 px-1">
          <Quadrant rows={rows} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {rows
            .filter((r) => r.x != null && r.y != null)
            .map((r) => (
              <span key={r.sector} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: colorFor(r.sector) }}
                  aria-hidden
                />
                <span className="text-[var(--text2)]">{r.sector}</span>
                <span className="font-mono text-[var(--text3)]">{quadrant(r.x as number, r.y as number)}</span>
              </span>
            ))}
        </div>
      </Panel>
    </div>
  );
}

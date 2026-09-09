"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { pct, NA } from "@/lib/format";
import { TOKEN_ICONS, TOKEN_ICON_VERSION } from "@/lib/tokenIcons";

// The shared vocabulary every panel is built from. A module should reach for
// these before inventing its own chrome, so the terminal reads as one screen
// rather than thirty widgets.

/* ---------------------------------------------------------------- layout -- */

/** A top-level section: chip heading, optional right-hand slot, then content. */
export function Section({
  title,
  hint,
  right,
  children,
  id,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  // scroll-mt clears the stacked sticky chrome (brand + nav + header) so an
  // anchor jump does not land the heading underneath it.
  return (
    <section className="mb-6 scroll-mt-[186px] xl:scroll-mt-[145px]" id={id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="panel-h font-display text-xs font-semibold uppercase tracking-wider">{title}</h2>
          {hint && <InfoHint text={hint} />}
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** A card with an in-card sub-header. Use inside a Section. */
export function Panel({
  title,
  hint,
  right,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {title && (
              <h3 className="panel-h font-display text-[11px] font-bold uppercase tracking-[0.09em]">{title}</h3>
            )}
            {hint && <InfoHint text={hint} />}
          </div>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** What a panel shows when its upstream is unavailable. Never a blank card. */
export function Unavailable({ what = "This panel" }: { what?: string }) {
  return (
    <div className="py-6 text-center font-mono text-[11px] text-[var(--text3)]">
      {what} is unavailable right now.
    </div>
  );
}

/** Shimmer placeholder sized to the eventual content. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-[var(--surface2)]" />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ indicators -- */

/** Signed percent chip: green up, red down, muted flat. */
export function ChangeChip({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  if (value == null || !Number.isFinite(value))
    return <span className="chip-flat rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold">{NA}</span>;
  const up = value >= 0;
  return (
    <span
      className={`${up ? "chip-pos" : "chip-neg"} whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold`}
    >
      {up ? "▲" : "▼"} {pct(Math.abs(value), digits).replace("+", "")}
    </span>
  );
}

/** Live/stale status pill with a pulsing dot. */
export function LivePill({ live = true, label }: { live?: boolean; label?: string }) {
  return (
    <span className="pill" style={{ color: live ? "var(--pos)" : "var(--text3)" }}>
      <span className="pulse-dot" style={{ background: live ? "var(--pos)" : "var(--text3)" }} />
      {label ?? (live ? "live" : "delayed")}
    </span>
  );
}

/**
 * Per-panel data-age stamp. "Now" is set in an effect so server and first
 * client render agree, then ticks every 15s. Turns amber past the threshold
 * so a stale panel reads at a glance.
 */
export function AsOf({ iso, staleMs = 10 * 60 * 1000 }: { iso?: string | null; staleMs?: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (!iso || now == null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const age = now - t;
  const s = Math.max(0, Math.floor(age / 1000));
  const label =
    s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  return (
    <span
      className="whitespace-nowrap font-mono text-[11px] tabular-nums"
      style={{ color: age > staleMs ? "var(--gold)" : "var(--text3)" }}
      title={iso}
    >
      {label}
    </span>
  );
}

/**
 * Small "?" affordance revealing an explanation on hover, so panels stay dense
 * without leaving a jargon term unexplained. Pure CSS group-hover, no state.
 */
/**
 * The caveat behind a mark.
 *
 * A button rather than a hover target, because hover does not exist on a
 * phone. These carry the things a professional cannot read off the number,
 * which cadence a rate was annualised on, whether a blank is a zero or an
 * absence, and on touch every one of them was unreachable: the mark rendered,
 * invited a tap, and did nothing.
 *
 * Hover still opens it on a pointer device, so nothing is lost on a desk. The
 * tap toggles, and Escape or a press anywhere else closes it.
 */
export function InfoHint({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label="What this means"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          // The mark sits inside table headers that sort on click and inside
          // cards that link. Neither should fire when the caveat is opened.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border font-mono text-[9px] font-bold leading-none group-hover:border-[var(--accent)] group-hover:text-[var(--text)] ${
          open
            ? "border-[var(--accent)] text-[var(--text)]"
            : "border-[var(--border)] text-[var(--text3)]"
        }`}
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-1.5 w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-[var(--text2)] shadow-[var(--shadow-lg)] ${
          open ? "block" : "hidden group-hover:block"
        } ${align === "right" ? "right-0" : "left-0"}`}
      >
        {text}
      </span>
    </span>
  );
}

/** A labelled 0..100 meter. Colour follows the score unless one is given. */
export function Meter({
  label,
  score,
  caption,
  color,
}: {
  label: string;
  score: number;
  caption?: string;
  color?: string;
}) {
  const c = color ?? (score >= 60 ? "var(--pos)" : score >= 40 ? "var(--gold)" : "var(--neg)");
  const w = Math.min(100, Math.max(0, score));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">{label}</span>
        <span className="font-mono text-sm font-bold" style={{ color: c }}>
          {Number.isFinite(score) ? score.toFixed(0) : NA}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: c }} />
      </div>
      {caption && <div className="mt-1.5 text-[11px] text-[var(--text3)]">{caption}</div>}
    </div>
  );
}

/** Horizontal bar for a table cell, sized as a share of `max`. */
export function BarCell({ value, max, color }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  const c = color ?? (value >= 0 ? "var(--pos)" : "var(--neg)");
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: c }} />
    </div>
  );
}

/* ----------------------------------------------------------------- chart -- */

/** Pure inline-SVG sparkline. No chart library, no client JS beyond render. */
/**
 * A token's logo, or a lettered badge when the set has none.
 *
 * The icons are extracted from @web3icons/core, which is the set The Graph's
 * Token API names in every `icon.web3icon` field, so the logo and the data
 * agree on what the token is. They are served from `public` because the CSP
 * here is `img-src \'self\'`.
 *
 * A missing icon renders as the first letters rather than a placeholder glyph.
 * Two tokens we track have no icon in the set, and a badge that says WIF is
 * more use than a grey circle, and far more use than a wrong logo.
 */
export function TokenIcon({ sym, size = 16 }: { sym: string; size?: number }) {
  const key = (sym ?? "").toUpperCase();
  const box = { width: size, height: size };

  if (!TOKEN_ICONS.has(key)) {
    return (
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-mono font-bold text-[var(--text3)]"
        style={{ ...box, fontSize: Math.max(7, Math.round(size * 0.42)) }}
      >
        {key.slice(0, 2)}
      </span>
    );
  }

  return (
    // Plain img rather than next/image: these are tiny static SVGs already in
    // public, so the optimiser has nothing to optimise and would only add a
    // request through a resizing endpoint.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/icons/tokens/${key.toLowerCase()}.png?v=${TOKEN_ICON_VERSION}`}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      /* Round, because these are the projects' own round marks on a
         transparent ground rather than square tiles. No ring: a hairline drawn
         around a circular logo that already ends in whitespace reads as a
         second, slightly wrong edge. */
      className="shrink-0 rounded-full"
      style={box}
    />
  );
}

/**
 * Click-to-sort table headers.
 *
 * Returns the rows in order plus the props a header needs. Sorting is local to
 * the panel and resets nothing else: a reader reordering the funding board is
 * not changing what the terminal is focused on.
 *
 * Nulls always sort last whichever way the column is pointing. A missing
 * reading is not a small one, and letting it float to the top of an ascending
 * sort would put "we do not know" where "lowest" belongs.
 */
export function useSort<T>(rows: T[], initial: { key: keyof T & string; dir?: "asc" | "desc" }) {
  const [key, setKey] = useState<string>(initial.key);
  const [dir, setDir] = useState<"asc" | "desc">(initial.dir ?? "desc");

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = (a as Record<string, unknown>)[key];
      const bv = (b as Record<string, unknown>)[key];
      const an = av == null || (typeof av === "number" && !Number.isFinite(av));
      const bn = bv == null || (typeof bv === "number" && !Number.isFinite(bv));
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      const as = String(av);
      const bs = String(bv);
      return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return out;
  }, [rows, key, dir]);

  function toggle(next: string) {
    if (next === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setKey(next);
    // A new column starts descending. On this terminal the interesting end of
    // almost every column is the large one.
    setDir("desc");
  }

  return { sorted, key, dir, toggle };
}

/**
 * A sortable header cell.
 *
 * `hint` is for the caveat, not the definition. "Open interest" needs no gloss
 * for anyone reading this table, but "counted in contracts, because a USD
 * notional rises with price and would label every rally new longs" is the thing
 * a professional wants and cannot get from the number.
 */
export function Th({
  label,
  sortKey,
  sort,
  hint,
  num,
  className = "",
}: {
  label: React.ReactNode;
  /** Omit to render a plain, unsortable header. */
  sortKey?: string;
  sort?: { key: string; dir: "asc" | "desc"; toggle: (k: string) => void };
  hint?: string;
  num?: boolean;
  className?: string;
}) {
  const cls = `${num ? "num" : "ident"} ${className}`.trim();
  // A hint is a button, not a title attribute.
  //
  // The native tooltip has no touch equivalent at all: on a phone the dotted
  // underline said a caveat existed and there was no gesture that would show
  // it. These headers carry the things a number cannot say on its own, so on
  // the smaller screen the whole mechanism was decorative.
  const mark = hint ? <InfoHint text={hint} align={num ? "right" : "left"} /> : null;

  if (!sortKey || !sort) {
    return (
      <th scope="col" className={cls}>
        <span className={`inline-flex items-center gap-1 ${num ? "flex-row-reverse" : ""}`}>
          <span>{label}</span>
          {mark}
        </span>
      </th>
    );
  }

  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      className={cls}
      // The browser reads this out, so a sorted column announces itself rather
      // than only looking sorted.
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className={`inline-flex items-center gap-1 ${num ? "flex-row-reverse" : ""}`}>
        <button
          type="button"
          onClick={() => sort.toggle(sortKey)}
          // Padding rather than a bare inline button. A one line header is a
          // 12px tap target, and sorting a column on a phone meant hitting it
          // exactly.
          className={`-my-1 inline-flex items-center gap-1 py-1 font-inherit uppercase tracking-[inherit] ${
            active ? "text-[var(--text)]" : "hover:text-[var(--text2)]"
          }`}
        >
          <span>{label}</span>
          <span aria-hidden className={active ? "text-[var(--accent2)]" : "opacity-40"}>
            {active ? (sort.dir === "asc" ? "\u2191" : "\u2193") : "\u2195"}
          </span>
        </button>
        {mark}
      </span>
    </th>
  );
}

export function Sparkline({
  data,
  up,
  width = 120,
  height = 34,
  stroke,
}: {
  data: number[];
  up?: boolean;
  width?: number;
  height?: number;
  stroke?: string;
}) {
  // Per-instance id: a shared gradient id would make every sparkline on the
  // page resolve to the first definition, so a red line could sit on a green fill.
  const uid = useId();
  const clean = (data ?? []).filter((n) => Number.isFinite(n));
  if (clean.length < 2) return <div style={{ width, height }} />;
  const rising = up ?? clean[clean.length - 1] >= clean[0];
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const step = width / (clean.length - 1);
  const pts = clean.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = stroke ?? (rising ? "var(--green)" : "var(--red)");
  const gid = `sp${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      /* The width prop is the intended size, not a floor. Without max-width a
         640px sparkline is simply clipped on a 360px screen, and because the
         page sets overflow-x: clip there is not even a scrollbar to reveal it.
         preserveAspectRatio is already none, so squashing horizontally is the
         behaviour this chart wants. */
      style={{ maxWidth: "100%", height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${height} ${pts.join(" ")} ${width},${height}`} fill={`url(#${gid})`} stroke="none" />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A scrollable dense table. Long tables scroll inside a capped height with a
 * sticky header; cells wrap rather than truncate.
 */
export function TableWrap({
  children,
  maxHeight = 420,
  /**
   * Drop the identity floor on the first column. For a table whose first cell
   * is already short and fixed, such as an expiry date, the floor is dead width
   * and it shows most on a phone.
   */
  tight = false,
  /**
   * Freeze the first two columns instead of one.
   *
   * For a table that leads with a rank: the identity is in the second column,
   * so pinning only the first leaves a strip of bare numbers beside rows whose
   * names have scrolled away.
   */
  pinTwo = false,
}: {
  children: React.ReactNode;
  maxHeight?: number;
  tight?: boolean;
  pinTwo?: boolean;
}) {
  const cls = ["tbl", tight && "tbl-tight", pinTwo && "tbl-pin2"].filter(Boolean).join(" ");
  return (
    <div className="thin-scroll overflow-auto rounded-lg border border-[var(--border)]" style={{ maxHeight }}>
      <table className={cls}>{children}</table>
    </div>
  );
}

/** Segmented control for panel-local switches (timeframe, venue, mode). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly T[] | readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const items = options.map((o) => (typeof o === "string" ? { value: o as T, label: o as string } : o));
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg2)] p-0.5"
    >
      {items.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
            value === o.value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
              : "text-[var(--text3)] hover:text-[var(--text2)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

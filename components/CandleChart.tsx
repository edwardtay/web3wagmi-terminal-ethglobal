"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  IChartApi,
  ISeriesApi,
  LogicalRange,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, CandlesPayload } from "@/app/api/candles/route";
import { AsOf, ChangeChip, Loading, Panel, Segmented, Unavailable } from "@/components/ui";
import { compact, price, usd } from "@/lib/format";
import { smaSeries } from "@/lib/stats";
import { useApi } from "@/lib/useApi";
import { ASSETS, BY_SYM, prettyPair } from "@/lib/symbols";

const INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;
type Interval = (typeof INTERVALS)[number];

// Enough bars for a 200-period overlay on every timeframe without asking for
// more history than the chart can show usefully.
const LIMIT: Record<Interval, number> = { "15m": 600, "1h": 600, "4h": 500, "1d": 500, "1w": 300 };
const REFRESH: Record<Interval, number> = { "15m": 30, "1h": 60, "4h": 120, "1d": 300, "1w": 600 };

interface Theme {
  text: string;
  grid: string;
  border: string;
  pos: string;
  neg: string;
  accent: string;
  violet: string;
  surface: string;
  mono: string;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    text: v("--text2"),
    grid: v("--border2"),
    border: v("--border"),
    pos: v("--pos"),
    neg: v("--neg"),
    accent: v("--accent"),
    violet: v("--violet"),
    surface: v("--surface"),
    mono: v("--font-mono") || "monospace",
  };
}

/**
 * The library needs literal colour strings, so translucent volume bars come
 * from parsing the token rather than a second hardcoded colour.
 */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function CandleChart({
  symbol = "BTC",
  navigateOnChange = false,
  onSymbolChange,
}: {
  symbol?: string;
  /** On the per-symbol page the switcher should route instead of swapping in place. */
  navigateOnChange?: boolean;
  /**
   * Lift the switcher to the page's shared selection. When this is given the
   * chart stops owning the symbol, so picking one here also moves order flow and
   * the options desk.
   */
  onSymbolChange?: (sym: string) => void;
}) {
  const router = useRouter();
  const [sym, setSym] = useState(symbol);
  const [interval, setInterval] = useState<Interval>("1h");
  const [ma50, setMa50] = useState(true);
  const [ma200, setMa200] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const [ready, setReady] = useState(false);
  const [range, setRange] = useState<{ hi: number; lo: number } | null>(null);
  // Bumped after tokens are re-applied so the per-bar volume colours redraw.
  const [themeApplied, setThemeApplied] = useState(0);

  useEffect(() => setSym(symbol), [symbol]);

  const url = `/api/candles?symbol=${sym}&interval=${interval}&limit=${LIMIT[interval]}`;
  const { data, failed } = useApi<CandlesPayload>(url, REFRESH[interval]);
  // The hook keeps the previous response across a key change, so every reader
  // below must ignore a payload that answers a different symbol or interval.
  const fresh =
    data?.symbol === sym.toUpperCase() && data?.interval === interval ? data : undefined;
  const candles = useMemo(() => fresh?.candles ?? [], [fresh]);

  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ma200Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const roRef = useRef<ResizeObserver | null>(null);
  const fittedFor = useRef("");
  /** True while we are refitting, so our own fit is not read as a user zoom. */
  const refitting = useRef(false);
  /** Set once the reader pans or zooms. Their view is theirs after that. */
  const userMoved = useRef(false);

  candlesRef.current = candles;

  /** Fit the whole series, flagged so the range subscriber ignores it. */
  function fit(chart: IChartApi | null) {
    if (!chart) return;
    refitting.current = true;
    chart.timeScale().fitContent();
    // The range event fires synchronously, but clear on a microtask so any
    // follow-up from the same fit is covered too.
    queueMicrotask(() => {
      refitting.current = false;
    });
  }

  // Repaint on theme flips. The toggle stamps data-theme on <html>.
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((n) => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Create the chart once. The library touches window, so it is imported here
  // rather than at module scope.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const LWC = await import("lightweight-charts");
      const el = boxRef.current;
      if (disposed || !el) return;
      const t = readTheme();
      const chart = LWC.createChart(el, {
        autoSize: false,
        width: el.clientWidth,
        height: el.clientHeight,
        layout: {
          background: { type: LWC.ColorType.Solid, color: "transparent" },
          textColor: t.text,
          fontSize: 11,
          fontFamily: t.mono,
          attributionLogo: false,
          panes: { enableResize: false, separatorColor: t.border, separatorHoverColor: t.border },
        },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
        crosshair: { mode: LWC.CrosshairMode.Normal },
        localization: { priceFormatter: (p: number) => price(p) },
      });
      const candle = chart.addSeries(LWC.CandlestickSeries, {
        upColor: t.pos,
        downColor: t.neg,
        borderUpColor: t.pos,
        borderDownColor: t.neg,
        wickUpColor: t.pos,
        wickDownColor: t.neg,
      });
      const vol = chart.addSeries(
        LWC.HistogramSeries,
        { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
        1
      );
      const l50 = chart.addSeries(LWC.LineSeries, {
        color: t.accent,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const l200 = chart.addSeries(LWC.LineSeries, {
        color: t.violet,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      chart.panes()[1]?.setHeight(76);

      chart.timeScale().subscribeVisibleLogicalRangeChange((lr: LogicalRange | null) => {
        // A range change we caused is not the reader choosing a view.
        if (!refitting.current) userMoved.current = true;
        const cs = candlesRef.current;
        if (!lr || cs.length === 0) return setRange(null);
        const from = Math.max(0, Math.floor(lr.from));
        const to = Math.min(cs.length - 1, Math.ceil(lr.to));
        if (to < from) return setRange(null);
        let hi = -Infinity;
        let lo = Infinity;
        for (let i = from; i <= to; i++) {
          if (cs[i].h > hi) hi = cs[i].h;
          if (cs[i].l < lo) lo = cs[i].l;
        }
        setRange(Number.isFinite(hi) && Number.isFinite(lo) ? { hi, lo } : null);
      });

      chartRef.current = chart;
      priceRef.current = candle;
      volRef.current = vol;
      ma50Ref.current = l50;
      ma200Ref.current = l200;
      setReady(true);

      const ro = new ResizeObserver(() => {
        if (!boxRef.current) return;
        chart.resize(boxRef.current.clientWidth, boxRef.current.clientHeight);
        // Resizing keeps the bar spacing it had, so a chart first fitted in a
        // narrow container stays narrow: the candles bunch against the right
        // edge and most of a wide screen is empty. Refit unless the reader has
        // chosen their own view.
        if (!userMoved.current) fit(chart);
      });
      ro.observe(el);
      roRef.current = ro;
    })();
    return () => {
      disposed = true;
      roRef.current?.disconnect();
      roRef.current = null;
      chartRef.current?.remove();
      chartRef.current = null;
      priceRef.current = null;
      volRef.current = null;
      ma50Ref.current = null;
      ma200Ref.current = null;
      setReady(false);
    };
  }, []);

  // Re-apply tokens after a theme flip instead of rebuilding the chart.
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    const t = readTheme();
    chart.applyOptions({
      layout: {
        textColor: t.text,
        panes: { separatorColor: t.border, separatorHoverColor: t.border },
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    priceRef.current?.applyOptions({
      upColor: t.pos,
      downColor: t.neg,
      borderUpColor: t.pos,
      borderDownColor: t.neg,
      wickUpColor: t.pos,
      wickDownColor: t.neg,
    });
    ma50Ref.current?.applyOptions({ color: t.accent });
    ma200Ref.current?.applyOptions({ color: t.violet });
    // Volume bars carry their colour per point, so they are rewritten below.
    setThemeApplied((n) => n + 1);
  }, [ready, themeTick]);

  // Push data. Volume colour is per-bar, so it depends on the theme too.
  useEffect(() => {
    if (!ready || candles.length === 0) return;
    const t = readTheme();
    priceRef.current?.setData(
      candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c }))
    );
    volRef.current?.setData(
      candles.map((c) => ({
        time: c.t as UTCTimestamp,
        value: c.v,
        color: alpha(c.c >= c.o ? t.pos : t.neg, 0.42),
      }))
    );
    const key = `${sym}|${interval}`;
    if (fittedFor.current !== key) {
      // Only refit when the user changed symbol or timeframe, so a poll does
      // not yank a zoomed-in view back out. A deliberate change also hands the
      // view back to the chart.
      userMoved.current = false;
      fit(chartRef.current);
      fittedFor.current = key;
    }
  }, [ready, candles, themeApplied, sym, interval]);

  // Moving averages, computed client-side from the same bars.
  useEffect(() => {
    if (!ready) return;
    const closes = candles.map((c) => c.c);
    const apply = (s: ISeriesApi<"Line"> | null, on: boolean, n: number) => {
      if (!s) return;
      if (!on || closes.length < n) return s.setData([]);
      const line = smaSeries(closes, n);
      s.setData(
        candles
          .map((c, i) => ({ time: c.t as UTCTimestamp, value: line[i] }))
          .filter((p) => Number.isFinite(p.value))
      );
    };
    apply(ma50Ref.current, ma50, 50);
    apply(ma200Ref.current, ma200, 200);
  }, [ready, candles, ma50, ma200]);

  const asset = BY_SYM[sym];
  const last = fresh?.last ?? null;
  const totalVol = candles.reduce((a, c) => a + c.v, 0);

  function pickSymbol(next: string) {
    if (navigateOnChange) {
      router.push(`/s/${next}`);
      return;
    }
    if (onSymbolChange) {
      // The parent owns the selection; the prop effect above syncs it back.
      onSymbolChange(next);
      return;
    }
    setSym(next);
  }

  return (
    <Panel
      title="Chart"
      right={
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--text3)]">
            {asset ? prettyPair(asset.pair) : sym} spot
          </span>
          <AsOf iso={fresh?.asOf} staleMs={REFRESH[interval] * 4000} />
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="chart-symbol">
          Symbol
        </label>
        <select
          id="chart-symbol"
          value={sym}
          onChange={(e) => pickSymbol(e.target.value)}
          aria-label="Chart symbol"
          className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-2 py-1.5 font-mono text-[11px] font-semibold text-[var(--text)]"
        >
          {ASSETS.map((a) => (
            <option key={a.sym} value={a.sym}>
              {a.sym} · {a.name}
            </option>
          ))}
        </select>
        <Segmented
          options={INTERVALS}
          value={interval}
          onChange={(v) => setInterval(v)}
          ariaLabel="Chart interval"
        />
        <div className="flex items-center gap-1">
          <MaToggle on={ma50} onClick={() => setMa50((v) => !v)} label="MA50" color="var(--accent)" />
          <MaToggle on={ma200} onClick={() => setMa200((v) => !v)} label="MA200" color="var(--violet)" />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <span className="whitespace-nowrap font-mono text-lg font-bold tabular-nums text-[var(--text)]">
          {usd(last)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">24h</span>
          <ChangeChip value={fresh?.change24h ?? null} />
        </span>
        <Stat label={`visible high (${interval})`} value={usd(range?.hi ?? null)} />
        <Stat label="visible low" value={usd(range?.lo ?? null)} />
        <Stat label={`vol (${candles.length} bars)`} value={`${compact(totalVol, 1)} ${sym}`} />
      </div>

      {!fresh && !failed && <Loading rows={6} />}
      {/* Only an answer for the selected pair can say the pair has no bars. */}
      {(failed || (fresh && candles.length === 0)) && (
        <Unavailable what={failed ? "Candles" : `Candles for ${sym}`} />
      )}

      <div
        ref={boxRef}
        className="h-[340px] w-full sm:h-[420px]"
        style={{ display: candles.length === 0 ? "none" : "block" }}
        role="img"
        aria-label={`${sym} ${interval} candlestick chart with volume`}
      />
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text3)]">{label}</span>
      <span className="whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-[var(--text2)]">
        {value}
      </span>
    </span>
  );
}

function MaToggle({
  on,
  onClick,
  label,
  color,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[11px] font-semibold transition-colors"
      style={{
        borderColor: on ? color : "var(--border)",
        color: on ? "var(--text)" : "var(--text3)",
        background: on ? "var(--surface2)" : "transparent",
      }}
    >
      <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: on ? color : "var(--text3)" }} />
      {label}
    </button>
  );
}

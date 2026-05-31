"use client";
import { useEffect, useRef } from "react";

export type RegimeChartProps = {
  dates: string[];
  close: number[];
  regime: (string | null)[];
  height?: number;
};

// Stable, accessible color per regime. Match the palette used in ui.tsx.
const REGIME_COLOR: Record<string, string> = {
  bull: "#22C55E",
  chop: "#F59E0B",
  bear: "#F97316",
  crash: "#EF4444",
};

export default function RegimeChart({
  dates,
  close,
  regime,
  height = 380,
}: RegimeChartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: any;
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    (async () => {
      const lib: any = await import("lightweight-charts");
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = "";
      chart = lib.createChart(ref.current, {
        width: ref.current.clientWidth,
        height,
        layout: {
          background: { color: "#08090C" } as any,
          textColor: "#6C7388",
          fontFamily: "var(--font-mono), ui-monospace, Menlo, monospace",
          fontSize: 10,
        },
        grid: {
          vertLines: { color: "#1C2030" },
          horzLines: { color: "#1C2030" },
        },
        rightPriceScale: { borderColor: "#2A3045" },
        timeScale: { borderColor: "#2A3045", timeVisible: false },
        crosshair: {
          mode: 1,
          vertLine: { color: "#F59E0B", labelBackgroundColor: "#F59E0B" },
          horzLine: { color: "#F59E0B", labelBackgroundColor: "#F59E0B" },
        },
      });

      // Price line, neutral color. Regime is conveyed by the colored dot
      // markers under each bar plus the legend.
      const line = chart.addLineSeries({
        color: "#9CA3AF",
        lineWidth: 1.5,
        priceLineVisible: false,
      });
      line.setData(dates.map((d, i) => ({ time: d, value: close[i] })));

      // Per-bar regime markers below each candle.
      const markers = dates.map((d, i) => {
        const r = regime[i];
        if (!r) return null;
        return {
          time: d,
          position: "belowBar",
          color: REGIME_COLOR[r] || "#6C7388",
          shape: "circle",
          size: 0.6,
        };
      }).filter(Boolean);
      try {
        line.setMarkers(markers as any);
      } catch {
        // older lightweight-charts versions
      }

      chart.timeScale().fitContent();
      ro = new ResizeObserver(() => {
        if (ref.current && chart) {
          chart.applyOptions({ width: ref.current.clientWidth });
        }
      });
      if (ref.current) ro.observe(ref.current);
    })();
    return () => {
      cancelled = true;
      ro?.disconnect();
      chart?.remove?.();
    };
  }, [dates, close, regime, height]);

  return <div ref={ref} className="w-full" aria-label="Price chart with regime classification per bar" />;
}

export const REGIME_PALETTE = REGIME_COLOR;

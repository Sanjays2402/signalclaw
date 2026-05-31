"use client";
import { useEffect, useRef } from "react";

export type Series = {
  id: string;
  label: string;
  color: string;
  dates: string[];
  close: number[];
};

export type CompareChartProps = {
  series: Series[];
  height?: number;
};

// Two-series overlay normalized to 100 at first bar. Aligns by index, not date,
// so windows of different lengths still overlay cleanly for shape comparison.
export default function CompareChart({ series, height = 360 }: CompareChartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: any;
    let ro: ResizeObserver | null = null;
    let cancelled = false;

    (async () => {
      const lwc = await import("lightweight-charts");
      if (cancelled || !ref.current) return;
      chart = lwc.createChart(ref.current, {
        height,
        layout: { background: { color: "transparent" }, textColor: "#9ca3af", fontFamily: "var(--font-mono)" },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: false, secondsVisible: false },
        crosshair: { mode: 1 },
      });

      for (const s of series) {
        if (!s.close || s.close.length === 0) continue;
        const base = s.close.find((v) => Number.isFinite(v) && v !== 0);
        if (!base) continue;
        // Map by index using a synthetic monotonic time (day offsets from epoch).
        // This lets the two series share an x-axis even if their date windows differ.
        const data = s.close.map((v, i) => ({
          time: (1700000000 + i * 86400) as any,
          value: Number.isFinite(v) ? (v / base) * 100 : 100,
        }));
        const line = chart.addLineSeries({
          color: s.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: s.label,
        });
        line.setData(data);
      }

      chart.timeScale().fitContent();

      ro = new ResizeObserver(() => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      if (ref.current) ro.observe(ref.current);
    })();

    return () => {
      cancelled = true;
      try {
        ro?.disconnect();
        chart?.remove();
      } catch {}
    };
  }, [series, height]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

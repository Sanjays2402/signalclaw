"use client";
import { useEffect, useRef } from "react";

export type EquityPoint = { date: string; value: number };

export default function EquityChart({
  dates,
  values,
  height = 320,
}: {
  dates: string[];
  values: number[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let chart: any;
    let ro: ResizeObserver | null = null;
    (async () => {
      const lib: any = await import("lightweight-charts");
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const up = values.length >= 2 && values[values.length - 1] >= values[0];
      const stroke = up ? "#22C55E" : "#EF4444";
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
      const s = chart.addAreaSeries({
        topColor: stroke + "55",
        bottomColor: stroke + "00",
        lineColor: stroke,
        lineWidth: 1.5,
        priceLineVisible: true,
        priceLineColor: stroke + "80",
        priceLineStyle: 2,
      });
      s.setData(dates.map((d, i) => ({ time: d, value: values[i] })));
      chart.timeScale().fitContent();
      ro = new ResizeObserver(() => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      if (ref.current) ro.observe(ref.current);
    })();
    return () => {
      ro?.disconnect();
      chart?.remove?.();
    };
  }, [dates, values, height]);
  return <div ref={ref} className="w-full" />;
}

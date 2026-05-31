"use client";
import { useEffect, useRef } from "react";

export default function BacktestChart({
  dates,
  strategy,
  benchmark,
  position,
  height = 320,
}: {
  dates: string[];
  strategy: number[];
  benchmark?: number[] | null;
  position?: number[] | null;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: any;
    let ro: ResizeObserver | null = null;
    let cancelled = false;

    (async () => {
      const lib: any = await import("lightweight-charts");
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = "";

      const up =
        strategy.length >= 2 && strategy[strategy.length - 1] >= strategy[0];
      const stratColor = up ? "#22C55E" : "#EF4444";

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
          vertLine: {
            color: "#F59E0B",
            labelBackgroundColor: "#F59E0B",
          },
          horzLine: {
            color: "#F59E0B",
            labelBackgroundColor: "#F59E0B",
          },
        },
      });

      // Benchmark first so strategy overlays it
      if (benchmark && benchmark.length === dates.length) {
        const bh = chart.addLineSeries({
          color: "#6C7388",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          title: "Buy & hold",
        });
        bh.setData(
          dates.map((d, i) => ({ time: d, value: benchmark[i] }))
        );
      }

      const strat = chart.addAreaSeries({
        topColor: stratColor + "55",
        bottomColor: stratColor + "00",
        lineColor: stratColor,
        lineWidth: 2,
        priceLineVisible: true,
        priceLineColor: stratColor + "80",
        priceLineStyle: 2,
        title: "Strategy",
      });
      strat.setData(
        dates.map((d, i) => ({ time: d, value: strategy[i] }))
      );

      // Position markers (entries/exits)
      if (position && position.length === dates.length) {
        const markers: any[] = [];
        for (let i = 1; i < position.length; i++) {
          const prev = position[i - 1] > 0.5;
          const cur = position[i] > 0.5;
          if (cur && !prev) {
            markers.push({
              time: dates[i],
              position: "belowBar",
              color: "#22C55E",
              shape: "arrowUp",
              text: "in",
            });
          } else if (!cur && prev) {
            markers.push({
              time: dates[i],
              position: "aboveBar",
              color: "#EF4444",
              shape: "arrowDown",
              text: "out",
            });
          }
        }
        if (markers.length > 0 && markers.length <= 300) {
          try {
            strat.setMarkers(markers);
          } catch {
            // older versions may not support markers on area; ignore
          }
        }
      }

      chart.timeScale().fitContent();
      ro = new ResizeObserver(() => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      if (ref.current) ro.observe(ref.current);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      chart?.remove?.();
    };
  }, [dates, strategy, benchmark, position, height]);

  return <div ref={ref} className="w-full" />;
}

export function DrawdownPane({
  dates,
  drawdown,
  height = 140,
}: {
  dates: string[];
  drawdown: number[];
  height?: number;
}) {
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
        crosshair: { mode: 1 },
      });
      const s = chart.addAreaSeries({
        topColor: "#EF444400",
        bottomColor: "#EF4444AA",
        lineColor: "#EF4444",
        lineWidth: 1,
        priceLineVisible: false,
      });
      s.setData(dates.map((d, i) => ({ time: d, value: drawdown[i] })));
      chart.timeScale().fitContent();
      ro = new ResizeObserver(() => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      if (ref.current) ro.observe(ref.current);
    })();
    return () => {
      cancelled = true;
      ro?.disconnect();
      chart?.remove?.();
    };
  }, [dates, drawdown, height]);
  return <div ref={ref} className="w-full" />;
}

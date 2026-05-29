"use client";
import { useEffect, useRef } from "react";

export default function EquityChart({ dates, values }: { dates: string[]; values: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let chart: any;
    (async () => {
      const lib: any = await import("lightweight-charts");
      if (!ref.current) return;
      ref.current.innerHTML = "";
      chart = lib.createChart(ref.current, {
        width: ref.current.clientWidth, height: 360,
        layout: { background: { color: "#0a0a0c" } as any, textColor: "#cccccc" },
        grid: { vertLines: { color: "#1f1f24" }, horzLines: { color: "#1f1f24" } },
      });
      const s = chart.addAreaSeries({ topColor: "rgba(91,156,255,0.4)", bottomColor: "rgba(91,156,255,0.0)", lineColor: "#5b9cff" });
      s.setData(dates.map((d, i) => ({ time: d, value: values[i] })));
    })();
    return () => { chart?.remove?.(); };
  }, [dates, values]);
  return <div ref={ref} className="w-full" />;
}

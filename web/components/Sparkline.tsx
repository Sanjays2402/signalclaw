"use client";
import { useEffect, useRef } from "react";

export default function Sparkline({
  data,
  width = 120,
  height = 30,
  color,
  fill = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || data.length < 2) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Auto color from trend if not provided
    const last = data[data.length - 1];
    const first = data[0];
    const stroke = color ?? (last >= first ? "#22C55E" : "#EF4444");

    const min = Math.min(...data),
      max = Math.max(...data);
    const rng = max - min || 1;
    const pts: [number, number][] = data.map((v, i) => [
      (i / (data.length - 1)) * (width - 1) + 0.5,
      height - ((v - min) / rng) * (height - 2) - 1,
    ]);

    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, stroke + "55");
      grad.addColorStop(1, stroke + "00");
      ctx.beginPath();
      ctx.moveTo(pts[0][0], height);
      pts.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(pts[pts.length - 1][0], height);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }, [data, width, height, color, fill]);
  return <canvas ref={ref} />;
}

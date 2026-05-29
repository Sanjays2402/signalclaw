"use client";
import { useEffect, useRef } from "react";

export default function Sparkline({ data, width = 120, height = 30, color = "#5b9cff" }:
  { data: number[]; width?: number; height?: number; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c || data.length < 2) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr; c.height = height * dpr;
    c.style.width = `${width}px`; c.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const min = Math.min(...data), max = Math.max(...data);
    const rng = max - min || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.25;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / rng) * height;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [data, width, height, color]);
  return <canvas ref={ref} />;
}

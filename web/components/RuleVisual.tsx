"use client";
import { ReactNode } from "react";

/**
 * Visual rule strip used in alerts and brackets tables.
 *
 *   stop -----------|-------- entry --------|----------- target
 *        |---risk---|                       |---reward---|
 *
 * Variant "alert": single trigger marker on a price line.
 * Variant "bracket": stop / entry / target with risk and reward bands.
 */

type AlertProps = {
  kind: "alert";
  trigger: number;
  current?: number | null;
  condition: string; // e.g. "price_above" / "pct_change_below"
};

type BracketProps = {
  kind: "bracket";
  side: string;
  entry: number;
  stop: number;
  target: number;
  current?: number | null;
};

type Props = (AlertProps | BracketProps) & { width?: number; height?: number };

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) < 1) return n.toFixed(4);
  if (Math.abs(n) < 1000) return n.toFixed(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function RuleVisual(props: Props) {
  const w = props.width ?? 220;
  const h = props.height ?? 28;
  const padX = 6;
  const trackY = h / 2;

  if (props.kind === "alert") {
    const isPct = props.condition.includes("pct");
    if (isPct) {
      // Render -10% .... 0 .... +10% with trigger marker
      const trig = Math.max(-0.2, Math.min(0.2, props.trigger));
      const range = 0.2;
      const x = ((trig + range) / (2 * range)) * (w - 2 * padX) + padX;
      const zero = ((0 + range) / (2 * range)) * (w - 2 * padX) + padX;
      const fill = trig >= 0 ? "#22C55E" : "#EF4444";
      return (
        <svg width={w} height={h} style={{ display: "block" }}>
          <line x1={padX} y1={trackY} x2={w - padX} y2={trackY} stroke="#2A3045" strokeWidth={1} />
          <line x1={zero} y1={trackY - 6} x2={zero} y2={trackY + 6} stroke="#6C7388" strokeWidth={1} />
          <Marker x={x} y={trackY} color={fill} label={`${(trig * 100).toFixed(1)}%`} />
          <Tick x={padX} y={h - 2} label="-20%" />
          <Tick x={w - padX} y={h - 2} label="+20%" align="end" />
        </svg>
      );
    }
    // Price alert: anchor around current price if known, else use trigger as center
    const center = props.current ?? props.trigger;
    const span = Math.max(Math.abs(props.trigger - center) * 2.5, center * 0.08);
    const min = center - span;
    const max = center + span;
    const xOf = (v: number) => ((v - min) / (max - min)) * (w - 2 * padX) + padX;
    const above = props.condition.includes("above");
    const trigColor = above ? "#22C55E" : "#EF4444";
    return (
      <svg width={w} height={h} style={{ display: "block" }}>
        <line x1={padX} y1={trackY} x2={w - padX} y2={trackY} stroke="#2A3045" strokeWidth={1} />
        {props.current != null && (
          <>
            <line
              x1={xOf(props.current)}
              y1={trackY - 6}
              x2={xOf(props.current)}
              y2={trackY + 6}
              stroke="#F59E0B"
              strokeWidth={1}
            />
            <text
              x={xOf(props.current)}
              y={trackY - 9}
              fill="#F59E0B"
              fontSize={8}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
            >
              {fmt(props.current)}
            </text>
          </>
        )}
        <Marker x={xOf(props.trigger)} y={trackY} color={trigColor} label={fmt(props.trigger)} />
      </svg>
    );
  }

  // Bracket
  const { entry, stop, target, current, side } = props;
  const isLong = side !== "short";
  const lo = Math.min(stop, entry, target, current ?? entry);
  const hi = Math.max(stop, entry, target, current ?? entry);
  const pad = (hi - lo) * 0.08 || entry * 0.01;
  const min = lo - pad;
  const max = hi + pad;
  const xOf = (v: number) => ((v - min) / (max - min)) * (w - 2 * padX) + padX;

  const xEntry = xOf(entry);
  const xStop = xOf(stop);
  const xTarget = xOf(target);

  // Risk band: between stop and entry (red). Reward band: between entry and target (green).
  const riskLeft = Math.min(xStop, xEntry);
  const riskRight = Math.max(xStop, xEntry);
  const rewardLeft = Math.min(xEntry, xTarget);
  const rewardRight = Math.max(xEntry, xTarget);

  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {/* risk band */}
      <rect
        x={riskLeft}
        y={trackY - 3}
        width={riskRight - riskLeft}
        height={6}
        fill="#EF4444"
        opacity={0.25}
      />
      {/* reward band */}
      <rect
        x={rewardLeft}
        y={trackY - 3}
        width={rewardRight - rewardLeft}
        height={6}
        fill="#22C55E"
        opacity={0.25}
      />
      <line x1={padX} y1={trackY} x2={w - padX} y2={trackY} stroke="#2A3045" strokeWidth={1} />
      {/* stop */}
      <Marker x={xStop} y={trackY} color="#EF4444" small />
      {/* entry */}
      <line x1={xEntry} y1={trackY - 8} x2={xEntry} y2={trackY + 8} stroke="#F59E0B" strokeWidth={1.5} />
      {/* target */}
      <Marker x={xTarget} y={trackY} color="#22C55E" small />
      {/* current price */}
      {current != null && (
        <circle cx={xOf(current)} cy={trackY} r={3} fill="#FFFFFF" stroke="#08090C" strokeWidth={1} />
      )}
      <Tick x={xStop} y={h - 1} label={fmt(stop)} color="#EF4444" />
      <Tick x={xEntry} y={h - 1} label={fmt(entry)} color="#F59E0B" />
      <Tick x={xTarget} y={h - 1} label={fmt(target)} color="#22C55E" align={xTarget > w - 30 ? "end" : "middle"} />
    </svg>
  );
}

function Marker({
  x,
  y,
  color,
  label,
  small,
}: {
  x: number;
  y: number;
  color: string;
  label?: string;
  small?: boolean;
}): ReactNode {
  const r = small ? 3 : 4;
  return (
    <>
      <circle cx={x} cy={y} r={r} fill={color} />
      {label && (
        <text
          x={x}
          y={y - 7}
          fill={color}
          fontSize={8}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
        >
          {label}
        </text>
      )}
    </>
  );
}

function Tick({
  x,
  y,
  label,
  align = "middle",
  color = "#6C7388",
}: {
  x: number;
  y: number;
  label: string;
  align?: "start" | "middle" | "end";
  color?: string;
}) {
  return (
    <text
      x={x}
      y={y}
      fill={color}
      fontSize={8}
      textAnchor={align}
      fontFamily="var(--font-mono)"
    >
      {label}
    </text>
  );
}

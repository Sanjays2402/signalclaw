"use client";

/**
 * Horizontal drawdown gauge.
 *
 * 0% -------------------------------|TRIG|-------------- -2x trigger
 * Fill = current DD as fraction of trigger (clamped to 1.5x).
 */
export default function DrawdownGauge({
  value,
  trigger,
}: {
  value: number; // negative (e.g. -0.04)
  trigger: number; // positive magnitude (e.g. 0.10)
}) {
  const mag = Math.abs(value);
  const trig = Math.max(0.0001, Math.abs(trigger));
  const max = trig * 1.5;
  const fillPct = Math.min(100, (mag / max) * 100);
  const trigPct = Math.min(100, (trig / max) * 100);
  const tripped = mag >= trig;
  const fill = tripped ? "#EF4444" : mag > trig * 0.6 ? "#F59E0B" : "#22C55E";

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className={`mono text-xl font-semibold ${tripped ? "down" : ""}`}>
          {(mag * 100).toFixed(2)}%
        </span>
        <span className="muted text-[10px] uppercase tracking-widest mono">
          / {(trig * 100).toFixed(1)}% trig
        </span>
      </div>
      <div
        className="relative w-full h-2 rounded-sm overflow-hidden"
        style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
      >
        <div
          className="absolute left-0 top-0 h-full transition-all"
          style={{ width: `${fillPct}%`, background: fill, opacity: 0.85 }}
        />
        <div
          className="absolute top-0 h-full"
          style={{
            left: `${trigPct}%`,
            width: 1,
            background: "#F59E0B",
            boxShadow: "0 0 4px rgba(245,158,11,0.6)",
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-1 mono text-[9px] muted uppercase tracking-widest">
        <span>0%</span>
        <span>{(max * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

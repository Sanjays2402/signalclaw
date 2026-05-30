"use client";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid } from "recharts";

export default function DrawdownChart({
  data,
  trigger,
  height = 240,
}: {
  data: { date: string; equity: number; drawdown: number }[];
  trigger?: number;
  height?: number;
}) {
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#EF4444" stopOpacity={0.55} />
              <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1C2030" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#6C7388"
            tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
            minTickGap={48}
          />
          <YAxis
            stroke="#6C7388"
            tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            domain={[(dataMin: number) => Math.min(dataMin, -0.05), 0]}
          />
          <Tooltip
            contentStyle={{
              background: "#0F1117",
              border: "1px solid #2A3045",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
            formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
            labelStyle={{ color: "#6C7388" }}
          />
          {trigger != null && (
            <ReferenceLine
              y={trigger}
              stroke="#F59E0B"
              strokeDasharray="3 3"
              label={{ value: `trigger ${(trigger * 100).toFixed(1)}%`, fill: "#F59E0B", fontSize: 10, fontFamily: "var(--font-mono)" }}
            />
          )}
          <Area type="monotone" dataKey="drawdown" stroke="#EF4444" fill="url(#dd)" strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

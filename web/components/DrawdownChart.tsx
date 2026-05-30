"use client";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid } from "recharts";

export default function DrawdownChart({
  data,
  trigger,
}: {
  data: { date: string; equity: number; drawdown: number }[];
  trigger?: number;
}) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff4d6d" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#ff4d6d" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1f1f24" vertical={false} />
          <XAxis dataKey="date" stroke="#8a8a93" tick={{ fontSize: 11 }} minTickGap={48} />
          <YAxis
            stroke="#8a8a93"
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            domain={[(dataMin: number) => Math.min(dataMin, -0.05), 0]}
          />
          <Tooltip
            contentStyle={{ background: "#111114", border: "1px solid #1f1f24", fontSize: 12 }}
            formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
            labelStyle={{ color: "#8a8a93" }}
          />
          {trigger != null && (
            <ReferenceLine y={trigger} stroke="#ffb020" strokeDasharray="3 3" label={{ value: "trigger", fill: "#ffb020", fontSize: 11 }} />
          )}
          <Area type="monotone" dataKey="drawdown" stroke="#ff4d6d" fill="url(#dd)" strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

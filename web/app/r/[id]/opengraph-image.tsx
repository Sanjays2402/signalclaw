import { ImageResponse } from "next/og";
import { getRun } from "@/lib/runStore";
import { ogFields } from "@/lib/ogFields";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "SignalClaw shared regime run";

export default async function OG({ params }: { params: { id: string } }) {
  const run = await getRun(params.id);
  const { ticker, label, conf, vol, dd, bars, color } = ogFields(run, params.id);

  // Tiny sparkline of close prices, normalized.
  const closes = run?.payload.close ?? [];
  let spark = "";
  if (closes.length > 1) {
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = Math.max(max - min, 1e-9);
    const w = 1040;
    const h = 140;
    const step = w / (closes.length - 1);
    spark = closes
      .map((v, i) => {
        const x = (i * step).toFixed(1);
        const y = (h - ((v - min) / span) * h).toFixed(1);
        return `${i === 0 ? "M" : "L"}${x},${y}`;
      })
      .join(" ");
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0a0a0a",
          color: "#e5e5e5",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          padding: 64,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 28, color: "#a3a3a3", letterSpacing: 4 }}>SIGNAL</span>
            <span style={{ fontSize: 28, color: "#fbbf24", letterSpacing: 4, fontWeight: 700 }}>
              CLAW
            </span>
          </div>
          <span style={{ fontSize: 18, color: "#737373", letterSpacing: 3 }}>
            REGIME CLASSIFIER
          </span>
        </div>

        <div style={{ display: "flex", marginTop: 36, alignItems: "flex-end", gap: 28 }}>
          <span style={{ fontSize: 132, fontWeight: 800, letterSpacing: -2, lineHeight: 1 }}>
            {ticker}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "8px 20px",
              border: `2px solid ${color}`,
              color,
              fontSize: 32,
              fontWeight: 700,
              letterSpacing: 4,
              marginBottom: 18,
            }}
          >
            {label}
          </div>
        </div>

        <div style={{ display: "flex", gap: 64, marginTop: 28, fontSize: 22 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#737373", fontSize: 14, letterSpacing: 2 }}>CONFIDENCE</span>
            <span style={{ color: "#e5e5e5", fontSize: 36, fontWeight: 600 }}>{conf}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#737373", fontSize: 14, letterSpacing: 2 }}>REALIZED VOL</span>
            <span style={{ color: "#e5e5e5", fontSize: 36, fontWeight: 600 }}>{vol}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#737373", fontSize: 14, letterSpacing: 2 }}>DRAWDOWN</span>
            <span style={{ color: "#e5e5e5", fontSize: 36, fontWeight: 600 }}>{dd}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ color: "#737373", fontSize: 14, letterSpacing: 2 }}>BARS</span>
            <span style={{ color: "#e5e5e5", fontSize: 36, fontWeight: 600 }}>{bars}</span>
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 36, flex: 1, alignItems: "flex-end" }}>
          {spark ? (
            <svg width={1040} height={140} viewBox="0 0 1040 140">
              <path d={spark} fill="none" stroke={color} strokeWidth={3} />
            </svg>
          ) : (
            <span style={{ color: "#525252", fontSize: 16 }}>no price series</span>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 24,
            color: "#525252",
            fontSize: 14,
            letterSpacing: 2,
          }}
        >
          <span>SIGNALCLAW.AI / R / {params.id.slice(0, 12)}</span>
          <span>NOT INVESTMENT ADVICE</span>
        </div>
      </div>
    ),
    { ...size },
  );
}

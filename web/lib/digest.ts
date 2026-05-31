// Pure activity digest builder. Aggregates recent activity events + saved
// runs into a structured summary, plain-text body, and shareable HTML for
// the in-app digest preview and any future email job. Kept side-effect free
// so tests can pass synthetic inputs.

import type { ActivityEvent } from "@/lib/activityStore";
import type { SavedRun } from "@/lib/runStore";

export type DigestRange = { days: number; since: string; until: string };

export type DigestStats = {
  runs: number;
  webhook_deliveries: number;
  webhook_failures: number;
  batch_completions: number;
  alerts_fired: number;
  keys_changed: number;
};

export type DigestRunRow = {
  id: string;
  ticker: string;
  label: string;
  regime: string;
  confidence: number;
  created_at: string;
  href: string;
};

export type Digest = {
  range: DigestRange;
  generated_at: string;
  stats: DigestStats;
  top_runs: DigestRunRow[];
  by_regime: Record<string, number>;
  headline: string;
  empty: boolean;
};

export type DigestRendered = Digest & { text: string; html: string };

export function clampDays(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 7;
  return Math.min(Math.max(Math.trunc(n), 1), 90);
}

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "--";
  return `${Math.round(x * 100)}%`;
}

function regimeColor(label: string): string {
  if (label === "bull") return "#34d399";
  if (label === "chop") return "#fbbf24";
  if (label === "bear") return "#f87171";
  if (label === "crash") return "#ef4444";
  return "#a3a3a3";
}

export function buildDigest(input: {
  events: ActivityEvent[];
  runs: SavedRun[];
  days: number;
  now?: string;
}): Digest {
  const days = clampDays(input.days);
  const until = input.now ?? new Date().toISOString();
  const since = isoMinusDays(until, days);

  const inRange = (iso: string) => iso >= since && iso <= until;

  const events = (input.events ?? []).filter((e) => inRange(e.created_at));
  const runs = (input.runs ?? []).filter((r) => inRange(r.created_at));

  const stats: DigestStats = {
    runs: runs.length,
    webhook_deliveries: events.filter((e) => e.kind === "webhook.delivered").length,
    webhook_failures: events.filter((e) => e.kind === "webhook.failed").length,
    batch_completions: events.filter((e) => e.kind === "batch.completed").length,
    alerts_fired: events.filter((e) => e.kind === "alert.fired").length,
    keys_changed: events.filter(
      (e) => e.kind === "key.created" || e.kind === "key.revoked" || e.kind === "key.rotated",
    ).length,
  };

  const by_regime: Record<string, number> = {};
  for (const r of runs) {
    const label = r.payload.snapshot?.label ?? "unknown";
    by_regime[label] = (by_regime[label] ?? 0) + 1;
  }

  const ranked = [...runs]
    .filter((r) => r.payload.snapshot)
    .sort((a, b) => (b.payload.snapshot!.confidence - a.payload.snapshot!.confidence))
    .slice(0, 5)
    .map<DigestRunRow>((r) => ({
      id: r.id,
      ticker: r.ticker,
      label: r.label,
      regime: r.payload.snapshot!.label,
      confidence: r.payload.snapshot!.confidence,
      created_at: r.created_at,
      href: `/r/${r.id}`,
    }));

  const totalSignals =
    stats.runs +
    stats.webhook_deliveries +
    stats.batch_completions +
    stats.alerts_fired;
  const empty = totalSignals === 0;

  let headline: string;
  if (empty) {
    headline = `Quiet ${days}-day window. Nothing to report.`;
  } else {
    const top = ranked[0];
    const regimePart = top
      ? `Top signal ${top.ticker} ${top.regime.toUpperCase()} at ${fmtPct(top.confidence)} confidence.`
      : "";
    headline = `${stats.runs} run${stats.runs === 1 ? "" : "s"} saved over the last ${days} day${days === 1 ? "" : "s"}. ${regimePart}`.trim();
  }

  return {
    range: { days, since, until },
    generated_at: until,
    stats,
    top_runs: ranked,
    by_regime,
    headline,
    empty,
  };
}

export function renderDigestText(d: Digest): string {
  const lines: string[] = [];
  lines.push(`SignalClaw digest · last ${d.range.days} day${d.range.days === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(d.headline);
  lines.push("");
  lines.push(`Runs saved        : ${d.stats.runs}`);
  lines.push(`Webhook delivered : ${d.stats.webhook_deliveries}`);
  lines.push(`Webhook failed    : ${d.stats.webhook_failures}`);
  lines.push(`Batches completed : ${d.stats.batch_completions}`);
  lines.push(`Alerts fired      : ${d.stats.alerts_fired}`);
  lines.push(`Keys changed      : ${d.stats.keys_changed}`);
  if (Object.keys(d.by_regime).length > 0) {
    lines.push("");
    lines.push("By regime:");
    for (const [k, v] of Object.entries(d.by_regime)) {
      lines.push(`  ${k.padEnd(8)} ${v}`);
    }
  }
  if (d.top_runs.length > 0) {
    lines.push("");
    lines.push("Top runs:");
    for (const r of d.top_runs) {
      lines.push(
        `  ${r.ticker.padEnd(6)} ${r.regime.padEnd(6)} ${fmtPct(r.confidence).padStart(4)}  ${r.label}`,
      );
    }
  }
  lines.push("");
  lines.push(`Generated ${d.generated_at}`);
  return lines.join("\n");
}

export function renderDigestHtml(d: Digest): string {
  const rows = d.top_runs
    .map(
      (r) => `<tr>
  <td style="padding:8px 10px;font-family:ui-monospace,monospace;font-size:12px;color:#fafafa;">${escapeHtml(r.ticker)}</td>
  <td style="padding:8px 10px;font-family:ui-monospace,monospace;font-size:12px;color:${regimeColor(r.regime)};">${escapeHtml(r.regime.toUpperCase())}</td>
  <td style="padding:8px 10px;font-family:ui-monospace,monospace;font-size:12px;color:#fafafa;text-align:right;">${escapeHtml(fmtPct(r.confidence))}</td>
  <td style="padding:8px 10px;font-family:ui-sans-serif,system-ui;font-size:12px;color:#a3a3a3;">${escapeHtml(r.label)}</td>
</tr>`,
    )
    .join("");

  const regimeRows =
    Object.entries(d.by_regime)
      .map(
        ([k, v]) =>
          `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid #262626;border-radius:2px;font-family:ui-monospace,monospace;font-size:11px;color:${regimeColor(k)};">${escapeHtml(k)} ${v}</span>`,
      )
      .join("") || `<span style="color:#737373;font-size:12px;">No runs saved.</span>`;

  const statCard = (label: string, value: number) =>
    `<td style="padding:10px 12px;border:1px solid #262626;background:#0a0a0a;">
       <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#737373;">${escapeHtml(label)}</div>
       <div style="font-family:ui-monospace,monospace;font-size:20px;color:#fafafa;margin-top:4px;">${value}</div>
     </td>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>SignalClaw digest</title></head>
<body style="margin:0;padding:24px;background:#000;color:#fafafa;font-family:ui-sans-serif,system-ui;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">SignalClaw digest</div>
    <h1 style="font-size:18px;font-weight:600;margin:6px 0 12px 0;color:#fafafa;">Last ${d.range.days} day${d.range.days === 1 ? "" : "s"}</h1>
    <p style="color:#d4d4d4;font-size:14px;line-height:1.5;margin:0 0 18px 0;">${escapeHtml(d.headline)}</p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:6px;margin-left:-6px;">
      <tr>
        ${statCard("Runs", d.stats.runs)}
        ${statCard("Webhooks", d.stats.webhook_deliveries)}
        ${statCard("Batches", d.stats.batch_completions)}
        ${statCard("Alerts", d.stats.alerts_fired)}
      </tr>
    </table>
    <div style="margin:20px 0 8px 0;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#737373;">By regime</div>
    <div>${regimeRows}</div>
    <div style="margin:20px 0 8px 0;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#737373;">Top runs</div>
    ${
      d.top_runs.length > 0
        ? `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #262626;">${rows}</table>`
        : `<div style="color:#737373;font-size:12px;">No saved runs in this window.</div>`
    }
    <p style="color:#737373;font-size:11px;margin-top:20px;font-family:ui-monospace,monospace;">Generated ${escapeHtml(d.generated_at)}</p>
  </div>
</body></html>`;
}

export function renderDigest(d: Digest): DigestRendered {
  return { ...d, text: renderDigestText(d), html: renderDigestHtml(d) };
}

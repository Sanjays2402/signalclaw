import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@/lib/runStore";
import RegimeChart, { REGIME_PALETTE } from "@/components/RegimeChart";
import CopyLinkButton from "@/components/CopyLinkButton";
import PinToggle from "@/components/PinToggle";
import RunComments from "@/components/RunComments";
import { Card, Stat, Badge, fmtPct } from "@/components/ui";
import {
  ShieldCheck,
  LightningSlash,
  ArrowRight,
  NotePencil,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return { title: "Shared run not found · SignalClaw" };
  const label = run.payload.snapshot?.label ?? "unknown";
  const title = `${run.ticker} · ${label.toUpperCase()} · SignalClaw`;
  const description = `Regime classification for ${run.ticker} over ${run.lookback_days} trading days (${run.payload.dates.length} bars).`;
  return {
    title,
    description,
    alternates: { canonical: `/r/${id}` },
    openGraph: {
      type: "article",
      title: `${run.ticker} · ${label.toUpperCase()}`,
      description,
      url: `/r/${id}`,
    },
    twitter: {
      card: "summary_large_image",
      title: `${run.ticker} · ${label.toUpperCase()}`,
      description,
    },
  };
}

function regimeTone(label: string): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

export default async function SharePage({ params }: Params) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const data = run.payload;
  const snap = data.snapshot;
  const totalBars = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const currentLabel = snap?.label ?? "--";
  const when = new Date(run.created_at).toUTCString();

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <section className="panel p-5 md:p-7">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="muted text-[10px] uppercase tracking-widest mono">
                Shared regime run
              </span>
              <span className="mono text-[10px] muted">id {run.id}</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
              {run.label}
            </h1>
            <p className="muted text-[12px] mono">Saved {when}</p>
            {(run.tags ?? []).length > 0 && (
              <div className="flex items-center gap-1 flex-wrap pt-1">
                {run.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-[var(--border)] muted lowercase"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <PinToggle runId={run.id} initialPinned={run.pinned === true} />
            <CopyLinkButton path={`/r/${run.id}`} />
            <a
              href={`/api/runs/${run.id}/pdf`}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
              aria-label="Download PDF report for this run"
              data-testid="download-pdf"
            >
              Download PDF
            </a>
            <a
              href={`/api/runs/${run.id}/export?format=csv`}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
              aria-label="Download this run as CSV"
              data-testid="download-csv"
              title="Download bars and regime labels as CSV"
            >
              <DownloadSimple size={12} weight="bold" /> CSV
            </a>
            <a
              href={`/api/runs/${run.id}/export?format=json`}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
              aria-label="Download this run as JSON"
              data-testid="download-json"
              title="Download full run payload as JSON"
            >
              <DownloadSimple size={12} weight="bold" /> JSON
            </a>
            <Link
              href="/demo"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              Run your own <ArrowRight size={12} weight="bold" />
            </Link>
          </div>
        </div>
      </section>

      {run.notes && run.notes.trim().length > 0 && (
        <section className="panel p-4 md:p-5">
          <div className="flex items-start gap-3">
            <NotePencil
              size={18}
              weight="duotone"
              style={{ color: "var(--accent)" }}
              className="shrink-0 mt-0.5"
            />
            <div className="min-w-0">
              <div className="muted text-[10px] uppercase tracking-widest mono mb-1.5">
                Notes
              </div>
              <p className="text-[13px] whitespace-pre-wrap break-words leading-relaxed">
                {run.notes}
              </p>
            </div>
          </div>
        </section>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card title="Regime">
          {snap ? (
            <div className="flex items-center gap-2">
              <Badge tone={regimeTone(currentLabel)}>{currentLabel.toUpperCase()}</Badge>
              <span className="muted text-[10px] mono uppercase">
                conf {(snap.confidence * 100).toFixed(0)}%
              </span>
            </div>
          ) : (
            <span className="muted text-[12px]">no snapshot</span>
          )}
        </Card>
        <Stat
          label="Realized vol"
          value={snap ? fmtPct(snap.realized_vol) : "--"}
          delta="Annualized, 20d"
        />
        <Stat
          label="Trend slope"
          value={snap ? (snap.trend_slope >= 0 ? "+" : "") + snap.trend_slope.toFixed(4) : "--"}
          delta="OLS on log price"
          tone={snap ? (snap.trend_slope >= 0 ? "up" : "down") : undefined}
        />
        <Stat
          label="Drawdown"
          value={snap ? fmtPct(snap.drawdown) : "--"}
          delta="From recent high"
          tone={snap && snap.drawdown < -0.05 ? "down" : undefined}
        />
      </div>

      <Card
        title={`${run.ticker} · regime overlay`}
        right={
          <span className="mono text-[10px] muted">
            {data.dates.length} bars · {run.lookback_days}d window
          </span>
        }
      >
        <RegimeChart dates={data.dates} close={data.close} regime={data.regime} />
        <div className="flex flex-wrap gap-4 mt-3 text-[11px] mono uppercase tracking-widest">
          {(["bull", "chop", "bear", "crash"] as const).map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ background: REGIME_PALETTE[k] }}
              />
              <span>{k}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Regime mix over window">
        {totalBars > 0 ? (
          <div className="space-y-2">
            <div className="flex h-3 rounded-sm overflow-hidden border border-[var(--border)]">
              {(["bull", "chop", "bear", "crash"] as const).map((k) => {
                const v = data.counts[k] || 0;
                const pct = (v / totalBars) * 100;
                if (pct <= 0) return null;
                return (
                  <div
                    key={k}
                    title={`${k}: ${v} bars (${pct.toFixed(1)}%)`}
                    style={{ width: `${pct}%`, background: REGIME_PALETTE[k] }}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] mono uppercase tracking-widest">
              {(["bull", "chop", "bear", "crash"] as const).map((k) => {
                const v = data.counts[k] || 0;
                if (v === 0) return null;
                return (
                  <div key={k} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ background: REGIME_PALETTE[k] }}
                    />
                    <span>{k}</span>
                    <span className="muted">{((v / totalBars) * 100).toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <span className="muted text-[12px]">no bars classified</span>
        )}
      </Card>

      <RunComments runId={run.id} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="panel p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} weight="duotone" style={{ color: "var(--green)" }} />
            <div>
              <div className="text-[12px] font-semibold mb-1">Snapshot of a real run</div>
              <p className="muted text-[11px]">
                This page is a frozen view of a regime classification produced by SignalClaw.
                Data is captured at save time and will not change.
              </p>
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="flex items-start gap-3">
            <LightningSlash size={18} weight="duotone" style={{ color: "var(--amber)" }} />
            <div>
              <div className="text-[12px] font-semibold mb-1">Not financial advice</div>
              <p className="muted text-[11px]">
                {data.disclaimer ||
                  "SignalClaw is research tooling. Outputs may be wrong. Do your own work."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

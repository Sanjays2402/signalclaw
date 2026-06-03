"use client";
import useSWR from "swr";
import Link from "next/link";
import { Card, Badge, Loading, ErrorBox, Empty, Button } from "@/components/ui";
import {
  Gauge,
  Lightning,
  Rocket,
  CalendarBlank,
  ChartBar,
  ArrowClockwise,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { usageToCSV, usageToJSON, usageFilename } from "@/lib/usageExport";

type DayBucket = { date: string; count: number };
type Summary = {
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  over_quota: boolean;
  period_start: string;
  period_end: string;
  resets_at: string;
  days_remaining: number;
  by_day: DayBucket[];
  by_ticker: { ticker: string; count: number }[];
  by_regime: { regime: string; count: number }[];
  lifetime: number;
};

const fetcher = (u: string) => fetch(u).then(async (r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function DayBars({ days }: { days: DayBucket[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="flex items-end gap-[2px] h-24 w-full">
      {days.map((d) => {
        const h = Math.round((d.count / max) * 100);
        const day = new Date(d.date + "T00:00:00Z").getUTCDate();
        const tone = d.count === 0 ? "var(--border)" : "var(--accent)";
        return (
          <div
            key={d.date}
            title={`${d.date}: ${d.count} run${d.count === 1 ? "" : "s"}`}
            className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0"
          >
            <span
              className="w-full rounded-sm"
              style={{ height: `${Math.max(h, 4)}%`, background: tone, minHeight: 2 }}
            />
            {day % 5 === 0 || day === 1 ? (
              <span className="mono text-[9px] muted leading-none">{day}</span>
            ) : (
              <span className="text-[9px] leading-none opacity-0">.</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function UsagePage() {
  const { data, error, isLoading, mutate } = useSWR<Summary>("/api/usage", fetcher, {
    refreshInterval: 30_000,
  });

  if (isLoading) return <Loading label="Loading usage" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return <Empty title="No usage data" hint="Save a run from the demo or ticker page." />;

  const pct = Math.max(0, Math.min(1, data.pct));
  const tone = data.over_quota
    ? "var(--red, #f87171)"
    : pct > 0.8
      ? "var(--amber, #f59e0b)"
      : "var(--accent, #34d399)";

  return (
    <div className="max-w-5xl mx-auto space-y-5 px-1">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Gauge weight="duotone" size={22} className="text-[var(--accent)]" />
            Usage
          </h1>
          <p className="muted text-xs">
            Free tier resets monthly. Saved runs and shareable links count toward your quota.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons summary={data} />
          <Button onClick={() => mutate()}>
            <span className="inline-flex items-center gap-1">
              <ArrowClockwise weight="duotone" size={14} /> Refresh
            </span>
          </Button>
        </div>
      </header>

      <Card>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="muted text-[10px] uppercase tracking-wider">Saved runs this month</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="mono text-3xl font-semibold tabular-nums">{data.used}</span>
              <span className="muted mono text-sm tabular-nums">/ {data.limit}</span>
              {data.over_quota ? (
                <Badge tone="down">Over quota</Badge>
              ) : pct > 0.8 ? (
                <Badge tone="warn">Almost full</Badge>
              ) : (
                <Badge tone="up">Free tier</Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="muted text-[10px] uppercase tracking-wider flex items-center gap-1 justify-end">
              <CalendarBlank weight="duotone" size={12} /> Resets
            </div>
            <div className="mono text-sm mt-1">{fmtDate(data.resets_at)}</div>
            <div className="muted text-[10px]">in {data.days_remaining} day{data.days_remaining === 1 ? "" : "s"}</div>
          </div>
        </div>

        <div className="mt-4">
          <div
            className="h-2 w-full rounded-full overflow-hidden"
            style={{ background: "var(--border)" }}
          >
            <div
              className="h-full"
              style={{ width: `${pct * 100}%`, background: tone, transition: "width 200ms" }}
            />
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="muted mono text-[10px]">0</span>
            <span className="muted mono text-[10px]">
              {data.remaining} left
            </span>
            <span className="muted mono text-[10px]">{data.limit}</span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <div className="muted text-[10px] uppercase tracking-wider">Period</div>
          <div className="mono text-sm mt-1">{fmtDate(data.period_start)}</div>
          <div className="muted text-[10px]">to {fmtDate(data.period_end)}</div>
        </Card>
        <Card>
          <div className="muted text-[10px] uppercase tracking-wider">Lifetime runs</div>
          <div className="mono text-2xl font-semibold tabular-nums mt-1">{data.lifetime}</div>
          <div className="muted text-[10px]">across all months</div>
        </Card>
        <Card>
          <div className="muted text-[10px] uppercase tracking-wider">Avg per day</div>
          <div className="mono text-2xl font-semibold tabular-nums mt-1">
            {(data.used / Math.max(1, data.by_day.length)).toFixed(1)}
          </div>
          <div className="muted text-[10px]">this month</div>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <ChartBar weight="duotone" size={16} className="text-[var(--accent)]" />
            Daily activity
          </div>
          <div className="muted text-[10px]">{data.by_day.length} days</div>
        </div>
        <DayBars days={data.by_day} />
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <div className="text-sm font-semibold mb-2">Top tickers</div>
          {data.by_ticker.length === 0 ? (
            <Empty title="No runs this month" hint="Save a run to see your top tickers." />
          ) : (
            <div className="space-y-1.5">
              {data.by_ticker.map((t) => {
                const w = Math.max(0.05, t.count / Math.max(1, data.by_ticker[0].count));
                return (
                  <div key={t.ticker} className="flex items-center gap-2">
                    <span className="mono text-xs w-16 truncate">{t.ticker}</span>
                    <span
                      className="block h-1.5 rounded-full"
                      style={{
                        width: `${w * 100}%`,
                        background: "var(--accent)",
                        opacity: 0.7,
                      }}
                    />
                    <span className="mono text-[10px] muted tabular-nums ml-auto">{t.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <Card>
          <div className="text-sm font-semibold mb-2">By regime</div>
          {data.by_regime.length === 0 ? (
            <Empty title="No regime data" hint="Saved runs include their regime snapshot." />
          ) : (
            <div className="space-y-1.5">
              {data.by_regime.map((r) => (
                <div key={r.regime} className="flex items-center justify-between">
                  <Badge tone="neutral">{r.regime}</Badge>
                  <span className="mono text-xs tabular-nums">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Rocket weight="duotone" size={16} className="text-[var(--amber)]" />
              Need more runs?
            </div>
            <p className="muted text-xs mt-1 max-w-prose">
              Free tier covers {data.limit} saved runs per month. Upgrade to Pro for
              unlimited runs, longer history retention, and priority signal compute.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <Link href="/history">
              <Button>
                <span className="inline-flex items-center gap-1">
                  <Lightning weight="duotone" size={14} /> View history
                </span>
              </Button>
            </Link>
            <a
              href="mailto:hello@signalclaw.dev?subject=Upgrade%20to%20Pro"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium border border-[var(--amber)] text-[var(--amber)] hover:bg-[var(--amber)] hover:text-black transition-colors"
            >
              <Rocket weight="duotone" size={14} /> Upgrade to Pro
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ExportButtons({ summary }: { summary: Summary }) {
  const disabled = !summary.by_day || summary.by_day.length === 0;
  function download(ext: "csv" | "json") {
    const body = ext === "csv" ? usageToCSV(summary) : usageToJSON(summary);
    const mime =
      ext === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = usageFilename(summary, ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const cls =
    "text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)] uppercase tracking-widest font-semibold mono" +
    (disabled ? " opacity-40 pointer-events-none" : "");
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => download("csv")}
        disabled={disabled}
        className={cls}
        title="Download daily usage as CSV"
        data-testid="usage-export-csv"
      >
        <DownloadSimple weight="duotone" size={11} /> CSV
      </button>
      <button
        type="button"
        onClick={() => download("json")}
        disabled={disabled}
        className={cls}
        title="Download usage summary as JSON"
        data-testid="usage-export-json"
      >
        <DownloadSimple weight="duotone" size={11} /> JSON
      </button>
    </div>
  );
}

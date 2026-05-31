"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Select,
  Field,
  Badge,
} from "@/components/ui";
import {
  Envelope,
  Copy,
  ArrowSquareOut,
  ArrowsClockwise,
  Code,
  FileText,
  ChartBar,
} from "@phosphor-icons/react/dist/ssr";

type Digest = {
  range: { days: number; since: string; until: string };
  generated_at: string;
  stats: {
    runs: number;
    webhook_deliveries: number;
    webhook_failures: number;
    batch_completions: number;
    alerts_fired: number;
    keys_changed: number;
  };
  top_runs: Array<{
    id: string;
    ticker: string;
    label: string;
    regime: string;
    confidence: number;
    created_at: string;
    href: string;
  }>;
  by_regime: Record<string, number>;
  headline: string;
  empty: boolean;
  text: string;
  html: string;
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as Digest;
};

const REGIME_COLOR: Record<string, string> = {
  bull: "#34d399",
  chop: "#fbbf24",
  bear: "#f87171",
  crash: "#ef4444",
};

function regimeColor(label: string): string {
  return REGIME_COLOR[label] ?? "#a3a3a3";
}

export default function DigestPage() {
  const [days, setDays] = useState<number>(7);
  const [copied, setCopied] = useState<"" | "html" | "text">("");
  const { data, error, isLoading, mutate, isValidating } = useSWR<Digest>(
    `/api/digest/preview?days=${days}`,
    fetcher,
  );

  async function copy(kind: "html" | "text") {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(kind === "html" ? data.html : data.text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* noop */
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mono">
            Activity digest
          </div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight mt-1">
            What happened lately
          </h1>
          <p className="muted text-[12px] mt-1 max-w-xl">
            A rolling summary of runs, webhook deliveries, batches, and alerts. Use this
            to preview what an email digest would contain. Tweak the cadence in{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Window">
            <Select
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="1">Last 24 hours</option>
              <option value="3">Last 3 days</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
          </Field>
          <Button onClick={() => mutate()} disabled={isValidating}>
            <ArrowsClockwise size={14} weight="duotone" />
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </div>

      {isLoading && <Loading label="Building digest" />}
      {error && <ErrorBox err={error} />}

      {data && (
        <>
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Envelope size={12} weight="duotone" />
                Headline
              </span>
            }
            right={
              <span className="mono text-[10px] muted">
                {data.range.days} day{data.range.days === 1 ? "" : "s"}
              </span>
            }
          >
            <p className="text-[14px] leading-relaxed">{data.headline}</p>
          </Card>

          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <StatTile label="Runs" value={data.stats.runs} />
            <StatTile label="Webhooks ok" value={data.stats.webhook_deliveries} />
            <StatTile label="Webhooks fail" value={data.stats.webhook_failures} />
            <StatTile label="Batches" value={data.stats.batch_completions} />
            <StatTile label="Alerts" value={data.stats.alerts_fired} />
            <StatTile label="Keys" value={data.stats.keys_changed} />
          </div>

          <Card title="By regime">
            {Object.keys(data.by_regime).length === 0 ? (
              <Empty
                title="No runs in this window"
                hint="Run a classification from the demo to start filling the digest."
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.by_regime).map(([k, v]) => (
                  <span
                    key={k}
                    className="px-2 py-1 border border-[var(--border-strong)] rounded-sm mono text-[11px]"
                    style={{ color: regimeColor(k) }}
                  >
                    {k} · {v}
                  </span>
                ))}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <ChartBar size={12} weight="duotone" />
                Top runs by confidence
              </span>
            }
          >
            {data.top_runs.length === 0 ? (
              <Empty title="No saved runs yet" hint="Save a run to see it appear here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left muted text-[10px] uppercase tracking-widest">
                      <th className="py-1.5 pr-3">Ticker</th>
                      <th className="py-1.5 pr-3">Regime</th>
                      <th className="py-1.5 pr-3 text-right">Conf</th>
                      <th className="py-1.5 pr-3">Label</th>
                      <th className="py-1.5 pr-3">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_runs.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--border)]">
                        <td className="py-1.5 pr-3 mono">{r.ticker}</td>
                        <td
                          className="py-1.5 pr-3 mono"
                          style={{ color: regimeColor(r.regime) }}
                        >
                          {r.regime.toUpperCase()}
                        </td>
                        <td className="py-1.5 pr-3 text-right mono">
                          {Math.round(r.confidence * 100)}%
                        </td>
                        <td className="py-1.5 pr-3 truncate max-w-[260px]">{r.label}</td>
                        <td className="py-1.5 pr-3">
                          <Link
                            href={r.href}
                            className="inline-flex items-center gap-1 underline mono text-[11px]"
                          >
                            <ArrowSquareOut size={12} weight="duotone" />
                            view
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Render"
            right={
              <span className="flex items-center gap-2">
                <Button onClick={() => copy("text")}>
                  <Copy size={12} weight="duotone" />
                  <span className="ml-1">{copied === "text" ? "copied" : "Copy text"}</span>
                </Button>
                <Button onClick={() => copy("html")}>
                  <Code size={12} weight="duotone" />
                  <span className="ml-1">{copied === "html" ? "copied" : "Copy HTML"}</span>
                </Button>
                <a
                  href={`/api/digest/preview?days=${days}&format=html`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 border border-[var(--border-strong)] rounded-sm mono text-[11px] hover:bg-white/5"
                >
                  <ArrowSquareOut size={12} weight="duotone" />
                  Open HTML
                </a>
              </span>
            }
          >
            <div className="flex items-center gap-2 mb-2">
              <Badge tone="info">
                <FileText size={10} weight="duotone" />
                <span className="ml-1">text/plain preview</span>
              </Badge>
              <span className="muted text-[11px] mono">{data.text.length} chars</span>
            </div>
            <pre className="mono text-[11px] whitespace-pre-wrap bg-black/40 border border-[var(--border-strong)] rounded-sm p-3 max-h-[360px] overflow-auto">
              {data.text}
            </pre>
            <p className="muted text-[11px] mt-2">
              Generated {new Date(data.generated_at).toUTCString()}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel p-3">
      <div className="muted text-[10px] uppercase tracking-widest mono">{label}</div>
      <div className="mono text-[20px] mt-1">{value}</div>
    </div>
  );
}

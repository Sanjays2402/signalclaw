"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Stack,
  UploadSimple,
  PlayCircle,
  DownloadSimple,
  Code,
  FileCsv,
  CheckCircle,
  XCircle,
  ShareNetwork,
  ClockCounterClockwise,
  Sparkle,
} from "@phosphor-icons/react/dist/ssr";
import { Card, Badge, Loading, ErrorBox, Empty, fmtPct } from "@/components/ui";
import { parseTickers } from "@/lib/batch";

type Row = {
  ticker: string;
  ok: boolean;
  status: number;
  regime: string | null;
  confidence: number | null;
  risk_scale: number | null;
  as_of: string | null;
  run_id: string | null;
  error: string | null;
};

type Resp = {
  summary: {
    requested: number;
    ok: number;
    failed: number;
    lookback_days: number;
    saved: boolean;
  };
  rows: Row[];
};

const LOOKBACKS = [
  { days: 252, label: "1Y" },
  { days: 504, label: "2Y" },
  { days: 1260, label: "5Y" },
];

// Public demo allowlist (mirrors the backend). Used for the one-click sample.
const SAMPLE_TICKERS = ["SPY", "QQQ", "IWM", "TLT", "GLD", "BTC-USD"];

function tone(label: string | null): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

export default function BatchPage() {
  const [text, setText] = useState("");
  const [lookback, setLookback] = useState(504);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resp, setResp] = useState<Resp | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseTickers(text, 50), [text]);
  const canRun = parsed.length > 0 && !busy;

  function loadSample() {
    setText(SAMPLE_TICKERS.join(", "));
    setResp(null);
    setErr(null);
  }

  async function readFile(file: File) {
    if (file.size > 256 * 1024) {
      setErr(`File too large (${(file.size / 1024).toFixed(0)} KB). Limit 256 KB.`);
      return;
    }
    const t = await file.text();
    setText((prev) => (prev.trim() ? prev + "\n" + t : t));
    setErr(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void readFile(f);
  }

  async function run() {
    setBusy(true);
    setErr(null);
    setResp(null);
    try {
      const r = await fetch("/api/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tickers: parsed,
          lookback_days: lookback,
          save,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      setResp(j as Resp);
    } catch (e: any) {
      setErr(e?.message ?? "Batch failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    if (!resp) return;
    const url = new URL("/api/batch", window.location.origin);
    fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tickers: parsed,
        lookback_days: lookback,
        save: false,
        format: "csv",
      }),
    })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        const href = URL.createObjectURL(blob);
        a.href = href;
        a.download = `signalclaw-batch-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch((e) => setErr(e?.message ?? "Download failed"));
  }

  function downloadJson() {
    if (!resp) return;
    const blob = new Blob([JSON.stringify(resp, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `signalclaw-batch-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Stack weight="duotone" className="w-5 h-5" />
          <h1 className="text-lg font-semibold tracking-tight">Batch regime scan</h1>
        </div>
        <p className="muted text-sm">
          Paste a ticker list or drop a CSV. We classify each one against the public
          demo model, save every run to your history, and hand back a CSV or JSON
          export. Up to 50 tickers per batch.
        </p>
      </header>

      <Card>
        <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-wider muted">
                Tickers
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={loadSample}
                  className="text-[11px] uppercase tracking-wider muted hover:text-white inline-flex items-center gap-1"
                >
                  <Sparkle weight="duotone" className="w-3.5 h-3.5" />
                  Load sample
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="text-[11px] uppercase tracking-wider muted hover:text-white inline-flex items-center gap-1"
                >
                  <UploadSimple weight="duotone" className="w-3.5 h-3.5" />
                  Upload CSV
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void readFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              className={
                "rounded-md border " +
                (drag
                  ? "border-white/60 bg-white/5"
                  : "border-[var(--border)] bg-[var(--panel)]")
              }
            >
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"SPY, QQQ, IWM\nTLT\nGLD"}
                spellCheck={false}
                rows={8}
                className="w-full bg-transparent p-3 mono text-sm outline-none resize-y min-h-[140px]"
                aria-label="Tickers"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] muted">
              <span>
                {parsed.length} valid {parsed.length === 1 ? "ticker" : "tickers"}
                {parsed.length >= 50 ? " (capped at 50)" : ""}
              </span>
              <span>Drop a CSV here or paste comma or newline separated.</span>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider muted">
                Lookback
              </label>
              <div className="mt-1 inline-flex rounded-md border border-[var(--border)] overflow-hidden">
                {LOOKBACKS.map((l) => (
                  <button
                    key={l.days}
                    type="button"
                    onClick={() => setLookback(l.days)}
                    className={
                      "px-3 py-1.5 text-[12px] mono " +
                      (lookback === l.days
                        ? "bg-white text-black"
                        : "bg-transparent muted hover:text-white")
                    }
                    aria-pressed={lookback === l.days}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
                className="accent-white"
              />
              Save each run to history
            </label>
            <button
              type="button"
              disabled={!canRun}
              onClick={run}
              className={
                "w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm " +
                (canRun
                  ? "bg-white text-black hover:opacity-90"
                  : "bg-white/10 text-white/40 cursor-not-allowed")
              }
            >
              <PlayCircle weight="duotone" className="w-4 h-4" />
              {busy ? "Running..." : `Run ${parsed.length || ""} scan${parsed.length === 1 ? "" : "s"}`}
            </button>
            {resp && (
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={downloadCsv}
                  className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md border border-[var(--border)] hover:bg-white/5"
                >
                  <FileCsv weight="duotone" className="w-4 h-4" /> CSV
                </button>
                <button
                  type="button"
                  onClick={downloadJson}
                  className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md border border-[var(--border)] hover:bg-white/5"
                >
                  <Code weight="duotone" className="w-4 h-4" /> JSON
                </button>
                <Link
                  href="/history"
                  className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md border border-[var(--border)] hover:bg-white/5"
                >
                  <ClockCounterClockwise weight="duotone" className="w-4 h-4" />
                  History
                </Link>
              </div>
            )}
          </div>
        </div>
      </Card>

      {busy && <Loading label="Classifying batch" />}
      {err && <ErrorBox err={err} />}

      {resp && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="muted text-[11px] uppercase tracking-wider">
                Results
              </span>
              <span>
                <CheckCircle
                  weight="duotone"
                  className="inline w-4 h-4 mr-1 text-emerald-400"
                />
                {resp.summary.ok} ok
              </span>
              <span>
                <XCircle
                  weight="duotone"
                  className="inline w-4 h-4 mr-1 text-rose-400"
                />
                {resp.summary.failed} failed
              </span>
              <span className="muted">
                lookback {resp.summary.lookback_days}d
              </span>
            </div>
          </div>

          {resp.rows.length === 0 ? (
            <Empty title="No rows" hint="Add tickers and run again." />
          ) : (
            <div className="overflow-x-auto -mx-3 md:mx-0">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider muted border-b border-[var(--border)]">
                    <th className="px-3 py-2">Ticker</th>
                    <th className="px-3 py-2">Regime</th>
                    <th className="px-3 py-2 text-right">Confidence</th>
                    <th className="px-3 py-2 text-right">Risk scale</th>
                    <th className="px-3 py-2">As of</th>
                    <th className="px-3 py-2">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {resp.rows.map((r) => (
                    <tr
                      key={r.ticker}
                      className="border-b border-[var(--border)]/60 hover:bg-white/[0.02]"
                    >
                      <td className="px-3 py-2 mono">{r.ticker}</td>
                      <td className="px-3 py-2">
                        {r.ok ? (
                          <Badge tone={tone(r.regime)}>
                            {(r.regime ?? "unknown").toUpperCase()}
                          </Badge>
                        ) : (
                          <span className="text-rose-400 text-[12px]">
                            {r.error ?? `error ${r.status}`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right mono">
                        {r.confidence == null ? "" : fmtPct(r.confidence)}
                      </td>
                      <td className="px-3 py-2 text-right mono">
                        {r.risk_scale == null ? "" : r.risk_scale.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 mono text-[12px] muted">
                        {r.as_of ?? ""}
                      </td>
                      <td className="px-3 py-2">
                        {r.run_id ? (
                          <Link
                            href={`/r/${r.run_id}`}
                            className="inline-flex items-center gap-1 text-[12px] hover:text-white muted"
                          >
                            <ShareNetwork weight="duotone" className="w-4 h-4" />
                            {r.run_id}
                          </Link>
                        ) : (
                          <span className="muted text-[12px]">not saved</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {!resp && !busy && !err && (
        <Card>
          <Empty
            title="No batch yet"
            hint="Paste tickers above, pick a lookback, then run. Each row gets a saved, shareable result."
          />
        </Card>
      )}

      <p className="muted text-[11px]">
        SignalClaw is not financial advice. The public demo model serves a limited
        ticker allowlist; unsupported tickers will be reported as failed rows.
      </p>
    </div>
  );
}

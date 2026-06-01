"use client";
// Observability admin page. Surfaces the existing /healthz, /readyz, and
// /metrics endpoints so a buyer's SRE team can confirm they exist, see
// them live, and copy the Prometheus scrape config they need to wire up
// monitoring without reading source.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, Button, Badge } from "@/components/ui";
import {
  Pulse,
  CheckCircle,
  WarningCircle,
  Copy,
  ArrowSquareOut,
  ChartLine,
  Heartbeat,
} from "@phosphor-icons/react/dist/ssr";

type ProbeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok";
      status: number;
      durationMs: number;
      requestId: string | null;
      body: unknown;
    }
  | {
      kind: "error";
      status: number | null;
      durationMs: number;
      message: string;
    };

export default function ObservabilityPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const [healthz, setHealthz] = useState<ProbeState>({ kind: "idle" });
  const [readyz, setReadyz] = useState<ProbeState>({ kind: "idle" });
  const [metricsHead, setMetricsHead] = useState<ProbeState>({ kind: "idle" });
  const [origin, setOrigin] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const probeJson = useCallback(
    async (
      path: string,
      setter: (s: ProbeState) => void,
      acceptText = false,
    ) => {
      setter({ kind: "loading" });
      const t0 = performance.now();
      try {
        const r = await fetch(path, { cache: "no-store" });
        const requestId = r.headers.get("x-request-id");
        const dur = Math.round(performance.now() - t0);
        if (acceptText) {
          const text = await r.text();
          const preview = text.split("\n").slice(0, 40).join("\n");
          setter({
            kind: "ok",
            status: r.status,
            durationMs: dur,
            requestId,
            body: preview,
          });
          return;
        }
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          setter({
            kind: "error",
            status: r.status,
            durationMs: dur,
            message:
              (body && typeof body === "object" && "status" in body
                ? String((body as { status: unknown }).status)
                : "") || `HTTP ${r.status}`,
          });
          return;
        }
        setter({
          kind: "ok",
          status: r.status,
          durationMs: dur,
          requestId,
          body,
        });
      } catch (e: unknown) {
        setter({
          kind: "error",
          status: null,
          durationMs: Math.round(performance.now() - t0),
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [],
  );

  const runAll = useCallback(() => {
    probeJson("/healthz", setHealthz);
    probeJson("/readyz", setReadyz);
    probeJson("/metrics", setMetricsHead, true);
  }, [probeJson]);

  useEffect(() => {
    runAll();
  }, [runAll]);

  const scrapeConfig =
    `# prometheus.yml\n` +
    `scrape_configs:\n` +
    `  - job_name: signalclaw\n` +
    `    metrics_path: /metrics\n` +
    `    scheme: ${originScheme(origin)}\n` +
    `    static_configs:\n` +
    `      - targets: ["${originHost(origin) || "your-host:3000"}"]\n`;

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Operations
          </div>
          <h1 className="text-lg font-semibold mono">Observability</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/settings"
            className="text-[11px] muted hover:text-white"
          >
            Back to settings
          </Link>
          <Button onClick={runAll} variant="ghost">
            <Pulse size={14} weight="duotone" /> Re-probe
          </Button>
        </div>
      </header>

      <Card>
        <div className="text-sm font-medium mb-1 flex items-center gap-2">
          <Heartbeat size={16} weight="duotone" /> Probes
        </div>
        <p className="text-[11px] muted mb-3">
          Endpoints below are unauthenticated and safe to scrape from your
          orchestrator. Liveness should never fail. Readiness drops to 503
          when the data directory is not writable so traffic stops routing
          without taking the pod out of rotation.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ProbeCard
            label="Liveness"
            path="/healthz"
            origin={origin}
            state={healthz}
          />
          <ProbeCard
            label="Readiness"
            path="/readyz"
            origin={origin}
            state={readyz}
          />
          <ProbeCard
            label="Metrics"
            path="/metrics"
            origin={origin}
            state={metricsHead}
            contentType="text/plain"
          />
        </div>
      </Card>

      <Card>
        <div className="text-sm font-medium mb-1 flex items-center gap-2">
          <ChartLine size={16} weight="duotone" /> Prometheus scrape config
        </div>
        <p className="text-[11px] muted mb-2">
          Paste into <code className="mono">prometheus.yml</code>. Cardinality
          is bounded by design: method, status_class, and route_class only. No
          per-request paths or user ids ever become labels.
        </p>
        <CodeBlock text={scrapeConfig} />
      </Card>

      <Card>
        <div className="text-sm font-medium mb-1">Request tracing</div>
        <p className="text-[11px] muted mb-2">
          Every request gets an <code className="mono">X-Request-Id</code>
          {" "}header propagated from edge middleware through every route and
          recorded on every audit event. Clients can supply their own id by
          sending <code className="mono">X-Request-Id</code> or{" "}
          <code className="mono">X-Correlation-Id</code> on the request; we
          accept UUID v4 or any opaque token of up to 128 safe characters.
        </p>
        <div className="text-[11px] muted">
          Live probe id from the last /healthz call:{" "}
          {healthz.kind === "ok" && healthz.requestId ? (
            <code className="mono text-white">{healthz.requestId}</code>
          ) : (
            <span>n/a</span>
          )}
        </div>
      </Card>

      <Card>
        <div className="text-sm font-medium mb-1">Sample probe commands</div>
        <CodeBlock
          text={
            `curl -fsS ${origin || "http://localhost:3000"}/healthz\n` +
            `curl -fsS ${origin || "http://localhost:3000"}/readyz\n` +
            `curl -fsS ${origin || "http://localhost:3000"}/metrics | head -40\n`
          }
        />
      </Card>
    </div>
  );
}

function ProbeCard({
  label,
  path,
  origin,
  state,
  contentType,
}: {
  label: string;
  path: string;
  origin: string;
  state: ProbeState;
  contentType?: string;
}) {
  const fullUrl = (origin || "") + path;
  return (
    <div className="rounded-md border border-white/5 p-3 bg-white/[0.02]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[12px] font-medium">{label}</div>
        <StatusBadge state={state} />
      </div>
      <div className="text-[10px] muted mb-2 flex items-center gap-1.5">
        <code className="mono">{path}</code>
        <a
          href={fullUrl}
          target="_blank"
          rel="noreferrer"
          className="hover:text-white"
          aria-label={`Open ${path} in a new tab`}
        >
          <ArrowSquareOut size={12} weight="duotone" />
        </a>
      </div>
      {state.kind === "loading" && <Loading label="Probing" />}
      {state.kind === "ok" && (
        <div className="text-[10px] muted space-y-1">
          <div>
            {state.status} in {state.durationMs} ms
            {contentType ? ` (${contentType})` : ""}
          </div>
          {typeof state.body === "string" ? (
            <pre className="mono text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {state.body}
            </pre>
          ) : (
            <pre className="mono text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-auto">
              {JSON.stringify(state.body, null, 2)}
            </pre>
          )}
        </div>
      )}
      {state.kind === "error" && (
        <div className="text-[10px] text-red-300">
          {state.status ? `${state.status} ` : ""}
          {state.message}
        </div>
      )}
      {state.kind === "idle" && (
        <div className="text-[10px] muted">Idle</div>
      )}
    </div>
  );
}

function StatusBadge({ state }: { state: ProbeState }) {
  if (state.kind === "ok" && state.status >= 200 && state.status < 300) {
    return (
      <Badge tone="up">
        <CheckCircle size={11} weight="duotone" /> ok
      </Badge>
    );
  }
  if (state.kind === "ok") {
    return (
      <Badge tone="warn">
        <WarningCircle size={11} weight="duotone" /> {state.status}
      </Badge>
    );
  }
  if (state.kind === "error") {
    return (
      <Badge tone="down">
        <WarningCircle size={11} weight="duotone" /> fail
      </Badge>
    );
  }
  if (state.kind === "loading") {
    return <Badge>...</Badge>;
  }
  return <Badge>idle</Badge>;
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="relative">
      <pre className="mono text-[11px] bg-black/40 rounded-md p-3 overflow-auto whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 text-[10px] muted hover:text-white inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5"
        aria-label="Copy"
      >
        <Copy size={11} weight="duotone" /> {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function originScheme(o: string): string {
  try {
    return new URL(o).protocol.replace(":", "") || "http";
  } catch {
    return "http";
  }
}

function originHost(o: string): string {
  try {
    return new URL(o).host;
  } catch {
    return "";
  }
}

"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Gauge,
  ShieldCheck,
  Warning,
  ArrowsClockwise,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  limit: number | null;
  updated_at: string | null;
  updated_by: string | null;
  in_flight: number;
  min_limit: number;
  max_limit: number;
};

export default function ConcurrencyPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/admin/concurrency",
    swrFetcher,
    { refreshInterval: 3_000 },
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.limit == null ? "" : String(data.limit));
  }, [data?.limit]);

  if (isLoading) return <Loading label="Loading concurrency policy" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const parsed = Number.parseInt(draft, 10);
  const validDraft =
    draft.trim().length > 0 &&
    Number.isFinite(parsed) &&
    parsed >= data.min_limit &&
    parsed <= data.max_limit;
  const enforcing = data.limit != null;

  async function save() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await api("/admin/concurrency", {
        method: "PUT",
        body: JSON.stringify({ limit: parsed }),
      });
      setOk(`Limit set to ${parsed} in-flight requests.`);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await api("/admin/concurrency", { method: "DELETE" });
      setOk("Concurrency limit removed. Per-key rate limit still applies.");
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const utilPct =
    enforcing && data.limit
      ? Math.min(100, Math.round((data.in_flight / data.limit) * 100))
      : 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <Gauge size={28} weight="duotone" className="mt-1 text-indigo-500" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Workspace concurrency limit
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Cap the number of in-flight /api/v1 requests across the entire
            workspace. Blocks one noisy client from starving the rest.
            Per-key rate limits and monthly quotas still apply on top.
          </p>
        </div>
      </header>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            {enforcing ? (
              <Badge tone="up">
                <ShieldCheck size={14} weight="duotone" />
                <span className="ml-1">Enforcing</span>
              </Badge>
            ) : (
              <Badge tone="neutral">
                <Warning size={14} weight="duotone" />
                <span className="ml-1">No cap</span>
              </Badge>
            )}
            <span className="text-sm text-neutral-500">
              {enforcing
                ? `Limit ${data.limit} concurrent requests`
                : "Unlimited concurrent requests"}
            </span>
          </div>
          <div className="text-sm text-neutral-400">
            Live in-flight: <span className="font-mono">{data.in_flight}</span>
          </div>
        </div>
        {enforcing && data.limit ? (
          <div className="px-4 pb-4">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-neutral-900"
              role="progressbar"
              aria-valuenow={utilPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Concurrency utilization"
            >
              <div
                className={
                  "h-full transition-all " +
                  (utilPct >= 90
                    ? "bg-rose-500"
                    : utilPct >= 70
                      ? "bg-amber-500"
                      : "bg-emerald-500")
                }
                style={{ width: `${utilPct}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              {data.in_flight} of {data.limit} slots used ({utilPct}%)
            </div>
          </div>
        ) : null}
      </Card>

      {err ? <ErrorBox err={err} /> : null}
      {ok ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-500">
          {ok}
        </div>
      ) : null}

      <Card>
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ArrowsClockwise size={16} weight="duotone" />
            Update limit
          </div>
          <p className="text-sm text-neutral-500">
            When the workspace is at the limit, new requests are rejected
            with 429 workspace_concurrency_exceeded and Retry-After: 1.
            Headers x-concurrency-limit and x-concurrency-in-flight are
            returned on every v1 response so clients can self-throttle.
          </p>
          <Field
            label={`In-flight cap (${data.min_limit} to ${data.max_limit})`}
          >
            <input
              type="number"
              inputMode="numeric"
              min={data.min_limit}
              max={data.max_limit}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 32"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-neutral-500">
              {data.updated_at
                ? `Last changed ${data.updated_at}${
                    data.updated_by ? ` by ${data.updated_by}` : ""
                  }`
                : "Never set"}
            </div>
            <div className="flex gap-2">
              {enforcing ? (
                <Button onClick={clear} disabled={busy} variant="ghost">
                  {busy ? "Working..." : "Remove cap"}
                </Button>
              ) : null}
              <Button onClick={save} disabled={!validDraft || busy}>
                {busy ? "Saving..." : enforcing ? "Update limit" : "Set limit"}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

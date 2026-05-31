"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Input,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ArchiveBox,
  Broom,
  ClockCounterClockwise,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  runs_days: number;
  audit_days: number;
  webhook_deliveries_days: number;
  updated_at: string;
  last_sweep_at: string | null;
  last_sweep_counts: {
    runs: number;
    audit: number;
    webhook_deliveries: number;
  } | null;
};

type SweepResult = {
  ran_at: string;
  policy: Policy;
  counts: { runs: number; audit: number; webhook_deliveries: number };
};

export default function RetentionPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<{ policy: Policy }>(
    "/admin/retention",
    swrFetcher,
  );

  const [runs, setRuns] = useState<string>("0");
  const [audit, setAudit] = useState<string>("0");
  const [webhooks, setWebhooks] = useState<string>("0");
  const [saving, setSaving] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SweepResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.policy) {
      setRuns(String(data.policy.runs_days));
      setAudit(String(data.policy.audit_days));
      setWebhooks(String(data.policy.webhook_deliveries_days));
    }
  }, [data?.policy]);

  function parseDays(raw: string, name: string): number | null {
    const t = raw.trim();
    if (t === "" || t === "0") return 0;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      setFormError(`${name} must be a whole number of days. Zero means forever.`);
      return null;
    }
    if (n > 3650) {
      setFormError(`${name} cannot exceed 3650 days.`);
      return null;
    }
    return n;
  }

  async function save() {
    setFormError(null);
    setMsg(null);
    const r = parseDays(runs, "Run history");
    if (r === null) return;
    const a = parseDays(audit, "Audit log");
    if (a === null) return;
    const w = parseDays(webhooks, "Webhook deliveries");
    if (w === null) return;
    setSaving(true);
    try {
      const out = await api<{ policy: Policy }>("/admin/retention", {
        method: "PUT",
        body: JSON.stringify({
          runs_days: r,
          audit_days: a,
          webhook_deliveries_days: w,
        }),
      });
      await mutate({ policy: out.policy }, { revalidate: false });
      setMsg("Policy saved.");
    } catch (e) {
      setFormError(
        e instanceof ApiError ? e.message : "Could not save policy.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function runSweep() {
    setMsg(null);
    setFormError(null);
    if (
      !window.confirm(
        "Run retention sweep now? Records older than the policy window will be permanently deleted.",
      )
    ) {
      return;
    }
    setSweeping(true);
    try {
      const out = await api<SweepResult>("/admin/retention/run", {
        method: "POST",
      });
      setLastResult(out);
      await mutate({ policy: out.policy }, { revalidate: false });
      setMsg(
        `Sweep complete. Purged ${out.counts.runs} runs, ${out.counts.audit} audit entries, ${out.counts.webhook_deliveries} deliveries.`,
      );
    } catch (e) {
      setFormError(
        e instanceof ApiError ? e.message : "Sweep failed.",
      );
    } finally {
      setSweeping(false);
    }
  }

  if (isLoading) return <Loading label="Loading retention policy" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;
  const p = data.policy;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <ArchiveBox weight="duotone" className="h-6 w-6 text-[var(--amber)]" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Data retention
          </h1>
        </div>
        <p className="muted text-sm">
          Set how long SignalClaw retains operational data. Zero means retain
          forever. Sweeps run on a one hour throttle whenever any list endpoint
          is hit, and can also be triggered manually.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs muted">
          <Link href="/settings" className="underline-offset-4 hover:underline">
            Settings
          </Link>
          <span>·</span>
          <Link
            href="/settings/security"
            className="underline-offset-4 hover:underline"
          >
            Security
          </Link>
          <span>·</span>
          <Link
            href="/settings/network"
            className="underline-offset-4 hover:underline"
          >
            Network policy
          </Link>
        </div>
      </header>

      {msg && (
        <div className="panel p-3 flex items-start gap-2 text-[12px]">
          <CheckCircle
            weight="duotone"
            className="mt-0.5 h-4 w-4 text-[var(--green)]"
          />
          <span>{msg}</span>
        </div>
      )}
      {formError && <ErrorBox err={formError} />}

      <Card>
        <div className="space-y-4 p-4 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Run history (days)">
              <Input
                inputMode="numeric"
                value={runs}
                onChange={(e) => setRuns(e.target.value)}
                aria-label="Run history retention days"
              />
            </Field>
            <Field label="Audit log (days)">
              <Input
                inputMode="numeric"
                value={audit}
                onChange={(e) => setAudit(e.target.value)}
                aria-label="Audit log retention days"
              />
            </Field>
            <Field label="Webhook deliveries (days)">
              <Input
                inputMode="numeric"
                value={webhooks}
                onChange={(e) => setWebhooks(e.target.value)}
                aria-label="Webhook delivery retention days"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving" : "Save policy"}
            </Button>
            <Button variant="ghost" onClick={runSweep} disabled={sweeping}>
              <span className="inline-flex items-center gap-1.5">
                <Broom weight="duotone" className="h-3.5 w-3.5" />
                {sweeping ? "Sweeping" : "Run sweep now"}
              </span>
            </Button>
            <span className="text-[11px] muted">
              Updated{" "}
              {p.updated_at && p.updated_at !== new Date(0).toISOString()
                ? new Date(p.updated_at).toLocaleString()
                : "never"}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3 p-4 sm:p-6">
          <div className="flex items-center gap-2">
            <ClockCounterClockwise
              weight="duotone"
              className="h-4 w-4 text-[var(--amber)]"
            />
            <h2 className="text-[10px] uppercase tracking-widest font-semibold muted">
              Last sweep
            </h2>
          </div>
          {p.last_sweep_at ? (
            <div className="space-y-2 text-[12px]">
              <div>{new Date(p.last_sweep_at).toLocaleString()}</div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="info">
                  Runs purged: {p.last_sweep_counts?.runs ?? 0}
                </Badge>
                <Badge tone="info">
                  Audit purged: {p.last_sweep_counts?.audit ?? 0}
                </Badge>
                <Badge tone="info">
                  Deliveries purged:{" "}
                  {p.last_sweep_counts?.webhook_deliveries ?? 0}
                </Badge>
              </div>
            </div>
          ) : (
            <p className="muted text-[12px]">
              No sweep has run yet. Set a non zero policy and click Run sweep
              now, or wait for the first list request to trigger one
              automatically.
            </p>
          )}
          {lastResult && (
            <pre className="overflow-x-auto rounded-sm border border-[var(--border)] bg-black/30 p-2 text-[11px] mono">
              {JSON.stringify(lastResult, null, 2)}
            </pre>
          )}
        </div>
      </Card>

      <Card>
        <div className="space-y-3 p-4 sm:p-6 text-[12px] muted">
          <h2 className="text-[10px] uppercase tracking-widest font-semibold">
            What gets deleted
          </h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Saved runs whose created_at is older than the run policy window.
            </li>
            <li>
              Audit log lines, current and rotated, whose ts is older than the
              audit policy window. Unparseable lines are retained.
            </li>
            <li>
              Webhook delivery attempts whose delivered_at is older than the
              webhook policy window. Subscriptions themselves are never
              deleted.
            </li>
          </ul>
          <p>
            Deletion is permanent. Export anything you need to keep first from
            the export page in Settings.
          </p>
        </div>
      </Card>
    </div>
  );
}

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
  ShieldCheck,
  Broadcast,
  CheckCircle,
  XCircle,
  PaperPlaneTilt,
} from "@phosphor-icons/react/dist/ssr";

type Sink = {
  enabled: boolean;
  url: string | null;
  secret_set: boolean;
  extra_header_name: string | null;
  extra_header_set: boolean;
  timeout_ms: number;
  updated_at: string;
};

type Delivery = {
  id: string;
  ts: string;
  event_id: string;
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
};

export default function SiemPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Sink>(
    "/admin/siem",
    swrFetcher,
  );
  const deliveriesSwr = useSWR<{ deliveries: Delivery[] }>(
    "/admin/siem/deliveries",
    swrFetcher,
    { refreshInterval: 5000 },
  );

  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [timeout, setTimeoutMs] = useState(2000);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(!!data.enabled);
      setUrl(data.url ?? "");
      setHeaderName(data.extra_header_name ?? "");
      setTimeoutMs(data.timeout_ms ?? 2000);
    }
  }, [data]);

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        url: url.trim() || null,
        extra_header_name: headerName.trim() || null,
        timeout_ms: timeout,
      };
      if (secret.trim().length > 0) body.secret = secret.trim();
      if (headerValue.trim().length > 0) body.extra_header_value = headerValue.trim();
      const next = await api<Sink>("/admin/siem", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setOk("Saved.");
      setSecret("");
      setHeaderValue("");
      await mutate(next, false);
    } catch (e) {
      const msg = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setErr(null);
    setOk(null);
    try {
      const r = await api<{ attempt: Delivery }>("/admin/siem/test", { method: "POST" });
      setOk(r.attempt.ok ? `Test delivered (status ${r.attempt.status}).` : `Test failed: ${r.attempt.error ?? r.attempt.status}`);
      await deliveriesSwr.mutate();
    } catch (e) {
      const msg = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
    } finally {
      setTesting(false);
    }
  }

  if (error) {
    const msg =
      error instanceof ApiError
        ? error.status === 403
          ? "You need an admin API key with MFA to view SIEM settings."
          : error.body || error.message
        : (error as Error).message;
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorBox err={msg} />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Loading />
      </div>
    );
  }

  const deliveries = deliveriesSwr.data?.deliveries ?? [];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Broadcast size={28} weight="duotone" className="text-violet-500" />
        <div>
          <h1 className="text-2xl font-semibold">SIEM forwarder</h1>
          <p className="text-sm text-neutral-500">
            Stream every audit event to your SOC. HMAC signed, fire and forget, never blocks the API.
          </p>
        </div>
      </div>

      <Card>
        <div className="space-y-4">
          <Field label="Status">
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>Enabled</span>
              </label>
              {data.enabled ? (
                <Badge tone="up">live</Badge>
              ) : (
                <Badge tone="neutral">paused</Badge>
              )}
              {data.secret_set ? (
                <Badge tone="up">secret set</Badge>
              ) : (
                <Badge tone="down">secret missing</Badge>
              )}
            </div>
          </Field>

          <Field label="Collector URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://collector.example.com/signalclaw"
            />
          </Field>

          <Field label="HMAC secret">
            <Input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={data.secret_set ? "leave blank to keep current" : "new secret"}
              type="password"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Extra header name">
              <Input
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                placeholder="X-Tenant-Token"
              />
            </Field>
            <Field label="Extra header value">
              <Input
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
                placeholder={data.extra_header_set ? "leave blank to keep" : ""}
                type="password"
              />
            </Field>
          </div>

          <Field label="Timeout (ms)">
            <Input
              type="number"
              value={String(timeout)}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 2000)}
              min={100}
              max={10000}
            />
          </Field>

          {err && <ErrorBox err={err} />}
          {ok && (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle size={16} weight="duotone" />
              <span>{ok}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button onClick={runTest} disabled={testing || !data.enabled}>
              <PaperPlaneTilt size={16} weight="duotone" className="inline mr-1" />
              {testing ? "Sending..." : "Send test event"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Recent deliveries</h2>
            <Badge tone="neutral">{deliveries.length}</Badge>
          </div>
          {deliveries.length === 0 ? (
            <div className="text-sm text-neutral-500 py-6 text-center">
              No deliveries yet. Enable the sink and trigger an audited request.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {deliveries.map((d) => (
                <li key={d.id} className="py-2 flex items-center gap-3 text-sm">
                  {d.ok ? (
                    <CheckCircle size={16} weight="duotone" className="text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle size={16} weight="duotone" className="text-rose-500 shrink-0" />
                  )}
                  <span className="font-mono text-xs text-neutral-500 shrink-0">
                    {new Date(d.ts).toLocaleTimeString()}
                  </span>
                  <span className="font-mono text-xs shrink-0">
                    {d.status ?? "ERR"}
                  </span>
                  <span className="text-xs text-neutral-500 shrink-0">
                    {d.duration_ms}ms
                  </span>
                  <span className="font-mono text-xs truncate text-neutral-600 dark:text-neutral-400">
                    {d.error ?? d.event_id}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-2 text-sm text-neutral-500">
        <ShieldCheck size={16} weight="duotone" />
        <span>
          Every event is signed with <code className="text-xs">X-SignalClaw-Signature: sha256=...</code>.
        </span>
        <Link href="/settings/audit" className="underline">
          View audit log
        </Link>
      </div>
    </div>
  );
}

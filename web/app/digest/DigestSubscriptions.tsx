"use client";
import { useState } from "react";
import useSWR, { mutate as gMutate } from "swr";
import { Card, Loading, ErrorBox, Empty, Button, Select, Field, Badge } from "@/components/ui";
import {
  PaperPlaneTilt,
  PlusCircle,
  Trash,
  Pulse,
  CheckCircle,
  XCircle,
  Copy,
  Pause,
  Play,
  ListBullets,
} from "@phosphor-icons/react/dist/ssr";

type Sub = {
  id: string;
  label: string;
  url: string;
  cadence: "daily" | "weekly";
  days: number;
  format: "json" | "text" | "slack";
  secret: string;
  enabled: boolean;
  created_at: string;
  last_delivered_at: string | null;
  last_status: number | null;
  last_error: string | null;
};

type Delivery = {
  id: string;
  subscription_id: string;
  url: string;
  status: number | null;
  error: string | null;
  attempt: number;
  delivered_at: string;
  cadence: string;
  format: string;
  bytes: number;
};

const SUBS_KEY = "/api/digest/subscriptions";
const DELIVERIES_KEY = "/api/digest/deliveries?limit=20";

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

function statusTone(status: number | null, error: string | null): "up" | "down" | "warn" | "info" {
  if (error) return "down";
  if (status && status >= 200 && status < 300) return "up";
  if (status && status >= 400) return "down";
  return "info";
}

export default function DigestSubscriptions() {
  const { data, error, isLoading } = useSWR<{ subscriptions: Sub[] }>(SUBS_KEY, fetcher, {
    refreshInterval: 15000,
  });
  const { data: del } = useSWR<{ deliveries: Delivery[] }>(DELIVERIES_KEY, fetcher, {
    refreshInterval: 15000,
  });

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly">("weekly");
  const [format, setFormat] = useState<"json" | "text" | "slack">("json");
  const [days, setDays] = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string>("");

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const r = await fetch(SUBS_KEY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, label, cadence, format, days }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      }
      setUrl("");
      setLabel("");
      await gMutate(SUBS_KEY);
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDeliverNow(id: string) {
    setBusy(id);
    try {
      const r = await fetch(`${SUBS_KEY}/${id}/deliver`, { method: "POST" });
      await r.json().catch(() => null);
    } finally {
      setBusy(null);
      await Promise.all([gMutate(SUBS_KEY), gMutate(DELIVERIES_KEY)]);
    }
  }

  async function onToggle(s: Sub) {
    setBusy(s.id);
    try {
      await fetch(`${SUBS_KEY}/${s.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
    } finally {
      setBusy(null);
      await gMutate(SUBS_KEY);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this subscription? Delivery history is kept.")) return;
    setBusy(id);
    try {
      await fetch(`${SUBS_KEY}/${id}`, { method: "DELETE" });
    } finally {
      setBusy(null);
      await gMutate(SUBS_KEY);
    }
  }

  async function copySecret(s: Sub) {
    try {
      await navigator.clipboard.writeText(s.secret);
      setCopiedId(s.id);
      setTimeout(() => setCopiedId(""), 1500);
    } catch {
      /* noop */
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex items-center gap-1.5">
            <PaperPlaneTilt size={12} weight="duotone" />
            Subscribe to digest
          </span>
        }
      >
        <p className="muted text-[11px] mb-3 leading-relaxed">
          Get the digest pushed to a Slack incoming webhook, n8n, Zapier, or any URL you control.
          Each delivery is signed with HMAC SHA-256 in the <code className="mono">x-signalclaw-signature</code> header.
          Schedule by hitting <code className="mono">/api/digest/cron</code> from cron, protected by <code className="mono">DIGEST_CRON_TOKEN</code>.
        </p>
        <form onSubmit={onCreate} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
          <div className="md:col-span-4">
            <Field label="Webhook URL">
              <input
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2 py-1.5 mono text-[12px]"
              />
            </Field>
          </div>
          <div className="md:col-span-3">
            <Field label="Label">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Team Slack"
                className="w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2 py-1.5 text-[12px]"
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Cadence">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value as "daily" | "weekly")}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Format">
              <Select value={format} onChange={(e) => setFormat(e.target.value as "json" | "text" | "slack")}>
                <option value="slack">Slack</option>
                <option value="json">JSON</option>
                <option value="text">Text</option>
              </Select>
            </Field>
          </div>
          <div className="md:col-span-1">
            <Field label="Days">
              <input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2 py-1.5 mono text-[12px]"
              />
            </Field>
          </div>
          <div className="md:col-span-12 flex items-center justify-between gap-2 pt-1">
            {submitErr && <span className="text-[11px]" style={{ color: "var(--red)" }}>{submitErr}</span>}
            <div className="ml-auto">
              <Button type="submit" disabled={submitting || !url.trim()}>
                <PlusCircle size={14} weight="duotone" />
                <span className="ml-1">{submitting ? "Saving" : "Add subscription"}</span>
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-1.5">
            <ListBullets size={12} weight="duotone" />
            Subscriptions
          </span>
        }
        right={
          <span className="mono text-[10px] muted">
            {data?.subscriptions?.length ?? 0} total
          </span>
        }
      >
        {isLoading && <Loading label="Loading subscriptions" />}
        {error && <ErrorBox err={error} />}
        {data && data.subscriptions.length === 0 && (
          <Empty
            title="No subscriptions yet"
            hint="Add a webhook URL above to start receiving recurring digests."
          />
        )}
        {data && data.subscriptions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left muted text-[10px] uppercase tracking-widest">
                  <th className="py-1.5 pr-3">Label</th>
                  <th className="py-1.5 pr-3">URL</th>
                  <th className="py-1.5 pr-3">Cadence</th>
                  <th className="py-1.5 pr-3">Format</th>
                  <th className="py-1.5 pr-3">Last</th>
                  <th className="py-1.5 pr-3">Secret</th>
                  <th className="py-1.5 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-[var(--border)] align-top">
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        {s.enabled ? (
                          <Pulse size={12} weight="duotone" style={{ color: "var(--green)" }} />
                        ) : (
                          <Pause size={12} weight="duotone" style={{ color: "var(--amber)" }} />
                        )}
                        <span className="truncate max-w-[160px]">{s.label}</span>
                      </div>
                      <div className="mono text-[10px] muted">{s.days}d window</div>
                    </td>
                    <td className="py-1.5 pr-3 mono text-[11px] truncate max-w-[260px]" title={s.url}>
                      {s.url}
                    </td>
                    <td className="py-1.5 pr-3 mono">{s.cadence}</td>
                    <td className="py-1.5 pr-3 mono">{s.format}</td>
                    <td className="py-1.5 pr-3 mono text-[11px]">
                      {s.last_delivered_at ? (
                        <span className="flex items-center gap-1">
                          {s.last_error ? (
                            <XCircle size={12} weight="duotone" style={{ color: "var(--red)" }} />
                          ) : (
                            <CheckCircle size={12} weight="duotone" style={{ color: "var(--green)" }} />
                          )}
                          <Badge tone={statusTone(s.last_status, s.last_error)}>
                            {s.last_status ?? "ERR"}
                          </Badge>
                          <span className="muted">
                            {new Date(s.last_delivered_at).toLocaleString()}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">never</span>
                      )}
                      {s.last_error && (
                        <div className="muted text-[10px] truncate max-w-[220px]" title={s.last_error}>
                          {s.last_error}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <button
                        type="button"
                        onClick={() => copySecret(s)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--border-strong)] rounded-sm mono text-[10px] hover:bg-white/5"
                        title="Copy HMAC secret"
                      >
                        <Copy size={10} weight="duotone" />
                        {copiedId === s.id ? "copied" : "copy"}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <div className="inline-flex gap-1">
                        <Button onClick={() => onDeliverNow(s.id)} disabled={busy === s.id}>
                          <PaperPlaneTilt size={12} weight="duotone" />
                          <span className="ml-1">Send</span>
                        </Button>
                        <Button onClick={() => onToggle(s)} disabled={busy === s.id}>
                          {s.enabled ? <Pause size={12} weight="duotone" /> : <Play size={12} weight="duotone" />}
                          <span className="ml-1">{s.enabled ? "Pause" : "Resume"}</span>
                        </Button>
                        <Button onClick={() => onDelete(s.id)} disabled={busy === s.id}>
                          <Trash size={12} weight="duotone" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Recent deliveries"
        right={<span className="mono text-[10px] muted">{del?.deliveries?.length ?? 0}</span>}
      >
        {!del && <Loading label="Loading deliveries" />}
        {del && del.deliveries.length === 0 && (
          <Empty title="No deliveries yet" hint='Use "Send" above to fire one now.' />
        )}
        {del && del.deliveries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left muted text-[10px] uppercase tracking-widest">
                  <th className="py-1.5 pr-3">When</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Attempt</th>
                  <th className="py-1.5 pr-3">Format</th>
                  <th className="py-1.5 pr-3 text-right">Bytes</th>
                  <th className="py-1.5 pr-3">URL</th>
                  <th className="py-1.5 pr-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {del.deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3 mono text-[11px]">
                      {new Date(d.delivered_at).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={statusTone(d.status, d.error)}>{d.status ?? "ERR"}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 mono">{d.attempt}</td>
                    <td className="py-1.5 pr-3 mono">{d.format}</td>
                    <td className="py-1.5 pr-3 mono text-right">{d.bytes}</td>
                    <td className="py-1.5 pr-3 mono text-[11px] truncate max-w-[220px]" title={d.url}>
                      {d.url}
                    </td>
                    <td className="py-1.5 pr-3 muted text-[11px] truncate max-w-[200px]" title={d.error ?? ""}>
                      {d.error ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

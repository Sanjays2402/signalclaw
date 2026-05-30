"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Field } from "@/components/ui";
import { api, swrFetcher, type WebhookList, type WebhookIn, type WebhookDelivery } from "@/lib/api";
import { PlugsConnected as WebhooksIcon, Trash, Plus, Lightning, CheckCircle, XCircle } from "@phosphor-icons/react/dist/ssr";

const EVENT_KINDS = ["entered", "exited", "upgraded", "downgraded", "score_jump"];

export default function WebhooksPage() {
  return (
    <AuthGate>
      <Webhooks />
    </AuthGate>
  );
}

function Webhooks() {
  const { data, error, isLoading } = useSWR<WebhookList>("/webhooks", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [fireResult, setFireResult] = useState<WebhookDelivery | null>(null);
  const [fireErr, setFireErr] = useState<string | null>(null);

  async function create(body: WebhookIn) {
    setFormErr(null);
    setBusy("create");
    try {
      await api("/webhooks", { method: "POST", body: JSON.stringify(body) });
      await mutate("/webhooks");
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
      await mutate("/webhooks");
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function fireLatest() {
    setBusy("fire");
    setFireErr(null);
    setFireResult(null);
    try {
      const r = await api<WebhookDelivery>("/webhooks/fire/latest", { method: "POST" });
      setFireResult(r);
      await mutate("/webhooks");
    } catch (e) {
      setFireErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <WebhooksIcon weight="duotone" size={22} className="text-[var(--accent)]" />
            Webhooks
          </h1>
          <p className="muted text-xs">Outbound subscriptions for pick events. Signed with HMAC if a secret is set.</p>
        </div>
        <Button onClick={fireLatest} disabled={busy === "fire"}>
          <span className="inline-flex items-center gap-1">
            <Lightning weight="duotone" size={14} /> Fire latest
          </span>
        </Button>
      </header>

      <Card title="Add subscription">
        <CreateForm onSubmit={create} busy={busy === "create"} />
        {formErr && <div className="mt-3 text-xs down">{formErr}</div>}
      </Card>

      {fireErr && <ErrorBox err={fireErr} />}
      {fireResult && (
        <Card title="Last delivery">
          <div className="text-xs muted mb-2">
            {fireResult.events.length} event(s), {fireResult.deliveries.length} delivery attempt(s).
          </div>
          <ul className="space-y-1 text-xs">
            {fireResult.events.slice(0, 10).map((e, i) => (
              <li key={i} className="flex gap-2 items-center">
                <Badge tone="info">{e.kind}</Badge>
                <span className="num">{e.ticker}</span>
                <span className="muted">{e.as_of}</span>
                {e.new_label && <span className="muted">to {e.new_label}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isLoading && <Loading label="Loading webhooks" />}
      {error && <ErrorBox err={error} />}
      {data && data.subscriptions.length === 0 && (
        <Empty title="No webhooks" hint="Add an https endpoint above to receive pick events." />
      )}

      {data && data.subscriptions.length > 0 && (
        <Card title={`${data.subscriptions.length} subscriptions`}>
          <ul className="divide-y divide-[var(--border)]">
            {data.subscriptions.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {s.enabled ? (
                        <Badge tone="up">enabled</Badge>
                      ) : (
                        <Badge tone="neutral">disabled</Badge>
                      )}
                      <span className="text-sm font-mono break-all">{s.url}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.events.map((e) => (
                        <Badge key={e} tone="info">
                          {e}
                        </Badge>
                      ))}
                      {s.tickers.length > 0 &&
                        s.tickers.map((t) => (
                          <Badge key={t} tone="neutral">
                            {t}
                          </Badge>
                        ))}
                      {s.tickers.length === 0 && (
                        <span className="muted text-xs">all tickers</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs muted flex flex-wrap gap-3">
                      <span>created {new Date(s.created_at).toLocaleString()}</span>
                      {s.last_delivered_at && (
                        <span>last {new Date(s.last_delivered_at).toLocaleString()}</span>
                      )}
                      {s.last_status != null && (
                        <span className={s.last_status >= 200 && s.last_status < 300 ? "up" : "down"}>
                          {s.last_status >= 200 && s.last_status < 300 ? (
                            <CheckCircle weight="duotone" size={12} className="inline mr-1" />
                          ) : (
                            <XCircle weight="duotone" size={12} className="inline mr-1" />
                          )}
                          HTTP {s.last_status}
                        </span>
                      )}
                      {s.last_error && <span className="down">{s.last_error}</span>}
                    </div>
                  </div>
                  <Button variant="danger" disabled={busy === s.id} onClick={() => remove(s.id)}>
                    <Trash weight="duotone" size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function CreateForm({
  onSubmit,
  busy,
}: {
  onSubmit: (b: WebhookIn) => Promise<void>;
  busy: boolean;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([...EVENT_KINDS]);
  const [tickers, setTickers] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);

  function toggle(e: string) {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        await onSubmit({
          url: url.trim(),
          events,
          tickers: tickers
            .split(",")
            .map((t) => t.trim().toUpperCase())
            .filter(Boolean),
          secret: secret.trim(),
          enabled,
        });
        setUrl("");
        setTickers("");
        setSecret("");
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="URL">
          <Input
            required
            type="url"
            placeholder="https://example.com/hook"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="HMAC secret (optional)">
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <Field label="Tickers (comma, blank = all)">
          <Input value={tickers} onChange={(e) => setTickers(e.target.value)} placeholder="AAPL,MSFT" />
        </Field>
        <label className="flex items-center gap-2 text-sm pt-6">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <div>
        <div className="muted text-xs mb-2">Events</div>
        <div className="flex flex-wrap gap-2">
          {EVENT_KINDS.map((k) => {
            const on = events.includes(k);
            return (
              <button
                type="button"
                key={k}
                onClick={() => toggle(k)}
                className={`px-2 py-1 text-xs rounded border ${on ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] muted hover:text-white"}`}
              >
                {k}
              </button>
            );
          })}
        </div>
      </div>
      <Button type="submit" disabled={busy || events.length === 0}>
        <span className="inline-flex items-center gap-1">
          <Plus weight="duotone" size={14} /> Subscribe
        </span>
      </Button>
    </form>
  );
}

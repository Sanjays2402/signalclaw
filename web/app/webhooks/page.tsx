"use client";
import { useState, useEffect } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Field } from "@/components/ui";
import { api, swrFetcher, type WebhookList, type WebhookIn, type WebhookDelivery, type WebhookDeliveryLog } from "@/lib/api";
import { PlugsConnected as WebhooksIcon, Trash, Plus, Lightning, CheckCircle, XCircle, Receipt, ArrowClockwise, FunnelSimple, ShieldCheck, ShieldWarning, Globe, Lock, LockOpen } from "@phosphor-icons/react/dist/ssr";

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
  const [logFilter, setLogFilter] = useState<"all" | "ok" | "failed">("all");
  const logKey = logFilter === "all"
    ? "/webhooks/deliveries?limit=25"
    : `/webhooks/deliveries?limit=25&status=${logFilter}`;
  const { data: logData } = useSWR<WebhookDeliveryLog>(logKey, swrFetcher, { refreshInterval: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [fireResult, setFireResult] = useState<WebhookDelivery | null>(null);
  const [fireErr, setFireErr] = useState<string | null>(null);
  const [replayErr, setReplayErr] = useState<string | null>(null);

  async function replay(id: string) {
    setReplayErr(null);
    setBusy(`replay-${id}`);
    try {
      await api(`/webhooks/deliveries/${encodeURIComponent(id)}/replay`, { method: "POST" });
      await mutate(logKey);
      await mutate("/webhooks");
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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

      <EgressPolicyCard />

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

      {logData && logData.deliveries.length > 0 && (
        <Card title={`Delivery log (${logData.deliveries.length})`}>
          <div className="text-xs muted mb-2 flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-1">
              <Receipt weight="duotone" size={12} /> Most recent attempts, newest first.
            </span>
            <div className="flex items-center gap-1" role="tablist" aria-label="Filter delivery log">
              <FunnelSimple weight="duotone" size={12} className="muted" />
              {(["all", "ok", "failed"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={logFilter === f}
                  onClick={() => setLogFilter(f)}
                  className={`px-2 py-0.5 rounded-md text-[11px] mono border ${
                    logFilter === f
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border)] muted hover:text-[var(--fg)]"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          {replayErr && <ErrorBox err={replayErr} />}
          <ul className="divide-y divide-[var(--border)]">
            {logData.deliveries.slice(0, 25).map((d) => {
              const ok = d.status !== null && d.status >= 200 && d.status < 300;
              const canReplay = !ok && Array.isArray(d.events) && d.events.length > 0;
              return (
                <li key={d.id} className="py-2 flex items-center gap-3 flex-wrap text-xs">
                  {ok ? (
                    <Badge tone="up">HTTP {d.status}</Badge>
                  ) : d.status !== null ? (
                    <Badge tone="down">HTTP {d.status}</Badge>
                  ) : (
                    <Badge tone="down">no response</Badge>
                  )}
                  {d.replay_of && <Badge tone="info">replay</Badge>}
                  <span className="font-mono break-all flex-1 min-w-0">{d.url}</span>
                  <span className="muted">attempt {d.attempt}</span>
                  <span className="muted">{d.event_count} event(s)</span>
                  <span className="muted">{new Date(d.delivered_at).toLocaleString()}</span>
                  {d.error && <span className="down break-all">{d.error}</span>}
                  {!ok && (
                    <Button
                      variant="ghost"
                      disabled={!canReplay || busy === `replay-${d.id}`}
                      onClick={() => replay(d.id)}
                      title={canReplay ? "Re-deliver the same payload" : "No payload stored for this attempt"}
                      aria-label="Replay delivery"
                    >
                      <ArrowClockwise weight="duotone" size={14} />
                      <span className="ml-1">{busy === `replay-${d.id}` ? "Sending" : "Replay"}</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {logData && logData.deliveries.length === 0 && logFilter !== "all" && (
        <Card title="Delivery log">
          <div className="text-xs muted mb-2 flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-1">
              <Receipt weight="duotone" size={12} /> Filter active.
            </span>
            <div className="flex items-center gap-1" role="tablist" aria-label="Filter delivery log">
              <FunnelSimple weight="duotone" size={12} className="muted" />
              {(["all", "ok", "failed"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={logFilter === f}
                  onClick={() => setLogFilter(f)}
                  className={`px-2 py-0.5 rounded-md text-[11px] mono border ${
                    logFilter === f
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border)] muted hover:text-[var(--fg)]"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <Empty
            title={logFilter === "failed" ? "No failed deliveries" : "No successful deliveries"}
            hint="Switch the filter to see other attempts."
          />
        </Card>
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
                      {s.owner_key_id ? (
                        <span title="API key that owns this webhook">
                          owner key {s.owner_key_id.slice(0, 8)}
                        </span>
                      ) : (
                        <span title="Legacy or admin-owned subscription">
                          owner admin
                        </span>
                      )}
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

type EgressPolicyView = {
  allow_private: boolean;
  cidrs: string[];
  updated_at: string | null;
  updated_by: string | null;
  max_cidrs: number;
};

function EgressPolicyCard() {
  const { data, error, isLoading, mutate: refresh } = useSWR<EgressPolicyView>(
    "/admin/webhooks/egress-policy",
    swrFetcher,
  );
  const [cidrText, setCidrText] = useState<string>("");
  const [allowPrivate, setAllowPrivate] = useState<boolean>(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Hydrate the form when the server payload first arrives or after a save,
  // but only when the user has not started editing.
  useEffect(() => {
    if (!data || dirty) return;
    setCidrText(data.cidrs.join("\n"));
    setAllowPrivate(data.allow_private);
  }, [data, dirty]);

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const cidrs = cidrText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const next = await api<EgressPolicyView>("/admin/webhooks/egress-policy", {
        method: "PUT",
        body: JSON.stringify({ allow_private: allowPrivate, cidrs }),
      });
      setSavedAt(next.updated_at);
      setDirty(false);
      setCidrText(next.cidrs.join("\n"));
      await refresh();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const lastSaved = data?.updated_at || savedAt;
  const cidrCount = cidrText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Globe weight="duotone" size={14} /> Outbound egress policy
        </span>
      }
    >
      {isLoading && <Loading label="Loading policy" />}
      {error && <ErrorBox err={error} />}
      {data && (
        <div className="space-y-3 text-xs">
          <p className="muted leading-relaxed">
            Blocks webhook destinations that resolve to private, loopback, link-local,
            or multicast ranges (including cloud metadata endpoints) so a misconfigured
            URL cannot be used to probe internal networks. Hostnames are re-resolved
            immediately before every delivery attempt to defeat DNS rebinding. When the
            allowlist below is non-empty, every resolved IP must also fall inside one
            of its CIDRs.
          </p>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allowPrivate}
              onChange={(e) => {
                setAllowPrivate(e.target.checked);
                setDirty(true);
              }}
              className="mt-0.5"
            />
            <span>
              <span className="inline-flex items-center gap-1">
                {allowPrivate ? (
                  <LockOpen weight="duotone" size={12} />
                ) : (
                  <Lock weight="duotone" size={12} />
                )}
                Allow private destinations
              </span>
              <div className="muted">
                Off by default. Turn this on only for self-hosted dev loops where the
                webhook target lives on the same host or private network.
              </div>
            </span>
          </label>

          <div>
            <div className="muted text-[10px] mb-1 uppercase tracking-widest flex items-center justify-between">
              <span>Outbound CIDR allowlist</span>
              <span className="normal-case tracking-normal">
                {cidrCount} of {data.max_cidrs}
              </span>
            </div>
            <textarea
              value={cidrText}
              onChange={(e) => {
                setCidrText(e.target.value);
                setDirty(true);
              }}
              rows={4}
              spellCheck={false}
              placeholder={"203.0.113.0/24\n2001:db8::/32"}
              className="w-full font-mono text-[11px] px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg)] focus:border-[var(--accent)] focus:outline-none"
            />
            <div className="muted text-[10px] mt-1">
              One CIDR per line. Leave empty to allow any public IP.
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-[11px]">
              {allowPrivate ? (
                <span className="inline-flex items-center gap-1 warn">
                  <ShieldWarning weight="duotone" size={12} /> Private destinations allowed
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 up">
                  <ShieldCheck weight="duotone" size={12} /> Private destinations blocked
                </span>
              )}
              {lastSaved && (
                <span className="mono muted">
                  Updated {new Date(lastSaved).toLocaleString()}
                  {data.updated_by ? ` by ${data.updated_by.slice(0, 8)}` : ""}
                </span>
              )}
            </div>
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving" : dirty ? "Save policy" : "Saved"}
            </Button>
          </div>
          {saveErr && <ErrorBox err={saveErr} />}
        </div>
      )}
    </Card>
  );
}

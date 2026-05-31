"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Input,
  Badge,
  Empty,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldWarning,
  LockKey,
  ArrowsClockwise,
  Trash,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr";

type LockoutEntry = {
  ip: string;
  locked: boolean;
  locked_until: string | null;
  recent_failures: number;
  total_failures: number;
  first_failure_at: string | null;
  last_failure_at: string | null;
};

type Config = {
  threshold: number;
  window_seconds: number;
  cooldown_seconds: number;
  enabled: boolean;
};

type Response = {
  config: Config;
  defaults: Config;
  entries: LockoutEntry[];
  total: number;
  locked_count: number;
};

export default function Page() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "never";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Response>(
    "/admin/auth-lockout",
    swrFetcher,
    { refreshInterval: 15000 },
  );

  const [draft, setDraft] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (isLoading) return <Loading label="Loading lockout state" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const cfg = draft ?? data.config;
  const dirty = draft !== null && (
    draft.threshold !== data.config.threshold ||
    draft.window_seconds !== data.config.window_seconds ||
    draft.cooldown_seconds !== data.config.cooldown_seconds ||
    draft.enabled !== data.config.enabled
  );

  function updateDraft(patch: Partial<Config>) {
    setDraft({ ...cfg, ...patch });
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setErr(null); setOk(null);
    try {
      await api("/admin/auth-lockout", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setOk("Configuration saved.");
      setDraft(null);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function unlock(ip: string) {
    setBusy(true); setErr(null); setOk(null);
    try {
      await api(`/admin/auth-lockout?ip=${encodeURIComponent(ip)}`, {
        method: "DELETE",
      });
      setOk(`Cleared lockout for ${ip}.`);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <ShieldWarning size={28} weight="duotone" className="text-amber-600" />
          <h1 className="text-2xl font-semibold tracking-tight">Failed auth lockout</h1>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Track failed API key attempts per source IP and freeze brute force
          attempts after a configurable threshold. Successful authentication
          from the same IP clears the counter.
        </p>
      </header>

      {err && <ErrorBox err={err} />}
      {ok && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle size={16} weight="duotone" /> {ok}
        </div>
      )}

      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="text-base font-medium">Policy</div>
              <div className="text-xs text-neutral-500">
                Defaults: {data.defaults.threshold} failures in {fmtSeconds(data.defaults.window_seconds)}, cooldown {fmtSeconds(data.defaults.cooldown_seconds)}.
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={cfg.enabled}
                onChange={(e) => updateDraft({ enabled: e.target.checked })}
              />
              <span>{cfg.enabled ? "Enforcing" : "Off"}</span>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Threshold (failures)">
              <Input
                type="number" min={1} max={1000}
                value={cfg.threshold}
                onChange={(e) => updateDraft({ threshold: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field label="Window (seconds)">
              <Input
                type="number" min={10} max={86400}
                value={cfg.window_seconds}
                onChange={(e) => updateDraft({ window_seconds: Number(e.target.value) || 10 })}
              />
            </Field>
            <Field label="Cooldown (seconds)">
              <Input
                type="number" min={30} max={86400}
                value={cfg.cooldown_seconds}
                onChange={(e) => updateDraft({ cooldown_seconds: Number(e.target.value) || 30 })}
              />
            </Field>
          </div>

          <div className="flex items-center justify-end gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Discard
              </Button>
            )}
            <Button onClick={save} disabled={!dirty || busy}>
              <ArrowsClockwise size={16} weight="duotone" /> Save
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-base font-medium">Tracked source IPs</div>
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Badge tone={data.locked_count > 0 ? "warn" : "neutral"}>
                {data.locked_count} locked
              </Badge>
              <span>· {data.total} tracked</span>
            </div>
          </div>

          {data.entries.length === 0 ? (
            <Empty title="No failed authentication attempts recorded." hint={cfg.enabled ? "Counters start once a wrong key is presented." : "Enable enforcement to start tracking."} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="py-2 pr-3">Source IP</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Recent</th>
                    <th className="py-2 pr-3">Total</th>
                    <th className="py-2 pr-3">Last</th>
                    <th className="py-2 pr-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {data.entries.map((e) => (
                    <tr key={e.ip}>
                      <td className="py-2 pr-3 font-mono text-xs">{e.ip}</td>
                      <td className="py-2 pr-3">
                        {e.locked ? (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                            <LockKey size={14} weight="duotone" /> until {fmtTs(e.locked_until)}
                          </span>
                        ) : (
                          <span className="text-neutral-500">clear</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{e.recent_failures}</td>
                      <td className="py-2 pr-3 tabular-nums text-neutral-500">{e.total_failures}</td>
                      <td className="py-2 pr-3 text-xs text-neutral-500">{fmtTs(e.last_failure_at)}</td>
                      <td className="py-2 pr-3 text-right">
                        {e.locked && (
                          <Button variant="ghost" onClick={() => unlock(e.ip)} disabled={busy}>
                            <Trash size={14} weight="duotone" /> Clear
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

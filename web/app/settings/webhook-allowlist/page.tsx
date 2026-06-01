"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
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
  ShieldCheck,
  ShieldWarning,
  PaperPlaneTilt,
  Plus,
  Trash,
  Lock,
  LockOpen,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  owner_key_id: string | null;
  enabled: boolean;
  hosts: string[];
  updated_at: string | null;
  updated_by: string | null;
  max_hosts: number;
};

export default function WebhookAllowlistPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/webhooks/host-allowlist",
    swrFetcher,
  );

  const [enabled, setEnabled] = useState(false);
  const [hosts, setHosts] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(!!data.enabled);
      setHosts(Array.isArray(data.hosts) ? data.hosts : []);
    }
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (enabled !== data.enabled) return true;
    if (hosts.length !== data.hosts.length) return true;
    return hosts.some((h, i) => h !== data.hosts[i]);
  }, [data, enabled, hosts]);

  const lockoutRisk = enabled && hosts.length === 0;

  function addDraft() {
    const v = draft.trim().toLowerCase().replace(/\.+$/, "");
    if (!v) return;
    if (hosts.includes(v)) {
      setDraft("");
      return;
    }
    setHosts([...hosts, v]);
    setDraft("");
    setOk(null);
    setErr(null);
  }

  function remove(i: number) {
    setHosts(hosts.filter((_, j) => j !== i));
    setOk(null);
    setErr(null);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const next = await api<Policy>("/webhooks/host-allowlist", {
        method: "PUT",
        body: JSON.stringify({ enabled, hosts }),
      });
      setOk("Saved.");
      await mutate(next, false);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    const msg =
      error instanceof ApiError
        ? error.status === 401 || error.status === 403
          ? "You need a valid API key to view your webhook allowlist."
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
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Loading label="Loading webhook allowlist" />
        <div className="h-24 rounded border border-white/10 bg-white/[0.02] animate-pulse" />
        <div className="h-40 rounded border border-white/10 bg-white/[0.02] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Webhooks
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <PaperPlaneTilt size={18} weight="duotone" /> Outbound host allowlist
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Restrict which external hosts your webhooks may deliver to.
            Applies to subscribe and to every delivery attempt, including
            replays. Composes with the global SSRF gate.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/webhooks"
            className="text-[11px] muted hover:text-white"
          >
            Webhooks
          </Link>
          <Link
            href="/settings"
            className="text-[11px] muted hover:text-white"
          >
            Settings
          </Link>
        </div>
      </header>

      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-medium inline-flex items-center gap-2">
              {enabled ? (
                <Lock size={14} weight="duotone" />
              ) : (
                <LockOpen size={14} weight="duotone" />
              )}
              Enforcement
            </div>
            <div className="muted text-xs mt-1">
              {enabled
                ? "Only listed hosts may receive webhook deliveries."
                : "Open. Any public host may receive webhook deliveries."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{enabled ? "enforcing" : "open"}</Badge>
            <Button
              onClick={() => {
                setEnabled(!enabled);
                setOk(null);
                setErr(null);
              }}
            >
              {enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Allowlisted hosts{" "}
              <span className="muted text-[11px]">
                ({hosts.length}/{data.max_hosts})
              </span>
            </div>
            {data.updated_at ? (
              <div className="muted text-[11px]">
                last change {data.updated_at}
                {data.updated_by ? ` by ${data.updated_by}` : ""}
              </div>
            ) : null}
          </div>

          <Field label="Add host">
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDraft();
                  }
                }}
                placeholder="hooks.slack.com"
                className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm mono focus:outline-none focus:border-white/30"
                aria-label="Host to allowlist"
              />
              <Button onClick={addDraft} disabled={!draft.trim()}>
                <Plus size={12} weight="duotone" /> Add
              </Button>
            </div>
          </Field>

          {hosts.length === 0 ? (
            <div className="muted text-xs border border-dashed border-white/10 rounded p-4 text-center">
              No hosts yet. Add at least one before enforcing. Subdomain
              entries match any deeper subdomain.
            </div>
          ) : (
            <ul className="divide-y divide-white/5 border border-white/10 rounded">
              {hosts.map((h, i) => (
                <li
                  key={`${h}-${i}`}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span className="mono break-all">{h}</span>
                  <button
                    onClick={() => remove(i)}
                    className="muted hover:text-red-400 inline-flex items-center gap-1 text-[11px]"
                    aria-label={`Remove ${h}`}
                  >
                    <Trash size={12} weight="duotone" /> Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lockoutRisk ? (
            <div className="text-xs text-amber-300 border border-amber-400/30 bg-amber-400/5 rounded px-3 py-2 inline-flex items-center gap-2">
              <ShieldWarning size={14} weight="duotone" />
              Enforcing with no hosts would block every webhook delivery.
              The server will reject this.
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
            <div className="text-[11px] muted inline-flex items-center gap-1.5">
              <ShieldCheck size={12} weight="duotone" />
              Changes are written to the audit log.
            </div>
            <div className="flex items-center gap-2">
              {ok ? (
                <span className="text-[11px] text-emerald-400">{ok}</span>
              ) : null}
              {err ? (
                <span
                  className="text-[11px] text-red-400 max-w-[220px] truncate"
                  title={err}
                >
                  {err}
                </span>
              ) : null}
              <Button
                onClick={save}
                disabled={!dirty || saving || lockoutRisk}
              >
                {saving ? "Saving" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

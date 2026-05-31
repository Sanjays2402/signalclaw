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
  Globe,
  Plus,
  Trash,
  Lock,
  LockOpen,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  enabled: boolean;
  cidrs: string[];
  updated_at: string | null;
  updated_by: string | null;
  max_cidrs: number;
};

export default function NetworkPolicyPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Policy>(
    "/admin/network-policy",
    swrFetcher,
  );

  const [enabled, setEnabled] = useState(false);
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(!!data.enabled);
      setCidrs(Array.isArray(data.cidrs) ? data.cidrs : []);
    }
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (enabled !== data.enabled) return true;
    if (cidrs.length !== data.cidrs.length) return true;
    return cidrs.some((c, i) => c !== data.cidrs[i]);
  }, [data, enabled, cidrs]);

  const lockoutRisk = enabled && cidrs.length === 0;

  function addDraft() {
    const v = draft.trim();
    if (!v) return;
    if (cidrs.includes(v)) {
      setDraft("");
      return;
    }
    setCidrs([...cidrs, v]);
    setDraft("");
    setOk(null);
    setErr(null);
  }

  function remove(i: number) {
    setCidrs(cidrs.filter((_, j) => j !== i));
    setOk(null);
    setErr(null);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const next = await api<Policy>("/admin/network-policy", {
        method: "PUT",
        body: JSON.stringify({ enabled, cidrs }),
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
        ? error.status === 403
          ? "You need an admin API key with MFA to view network policy."
          : error.body || error.message
        : (error as Error).message;
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorBox message={msg} />
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Loading label="Loading network policy" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Admin
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <Globe size={18} weight="duotone" /> Network policy
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Restrict API and dashboard access to a known set of CIDRs.
            Loopback and health endpoints are always allowed so liveness
            checks keep working.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="text-[11px] muted hover:text-white"
          >
            Settings
          </Link>
          <Link
            href="/settings/security"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ShieldWarning size={14} weight="duotone" /> Security
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
                ? "Only listed CIDRs may reach the API."
                : "Open access. Any IP may reach the API after auth."}
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
              Allowlisted CIDRs{" "}
              <span className="muted text-[11px]">
                ({cidrs.length}/{data.max_cidrs})
              </span>
            </div>
            {data.updated_at ? (
              <div className="muted text-[11px]">
                last change {data.updated_at}
                {data.updated_by ? ` by ${data.updated_by}` : ""}
              </div>
            ) : null}
          </div>

          <Field label="Add CIDR or IP">
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
                placeholder="10.0.0.0/8 or 203.0.113.42"
                className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm mono focus:outline-none focus:border-white/30"
                aria-label="CIDR or IP to allowlist"
              />
              <Button onClick={addDraft} disabled={!draft.trim()}>
                <Plus size={12} weight="duotone" /> Add
              </Button>
            </div>
          </Field>

          {cidrs.length === 0 ? (
            <div className="muted text-xs border border-dashed border-white/10 rounded p-3 text-center">
              No CIDRs yet. Add at least one before enforcing.
            </div>
          ) : (
            <ul className="divide-y divide-white/5 border border-white/10 rounded">
              {cidrs.map((c, i) => (
                <li
                  key={`${c}-${i}`}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span className="mono">{c}</span>
                  <button
                    onClick={() => remove(i)}
                    className="muted hover:text-red-400 inline-flex items-center gap-1 text-[11px]"
                    aria-label={`Remove ${c}`}
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
              Enforcing with no CIDRs would lock everyone out. The server
              will reject this.
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <div className="text-[11px] muted inline-flex items-center gap-1.5">
              <ShieldCheck size={12} weight="duotone" />
              Changes are written to the audit log.
            </div>
            <div className="flex items-center gap-2">
              {ok ? (
                <span className="text-[11px] text-emerald-400">{ok}</span>
              ) : null}
              {err ? (
                <span className="text-[11px] text-red-400 max-w-[220px] truncate" title={err}>
                  {err}
                </span>
              ) : null}
              <Button onClick={save} disabled={!dirty || saving || lockoutRisk}>
                {saving ? "Saving" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

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
  ArrowsClockwise,
  ShieldCheck,
  Warning,
  XCircle,
  CheckCircle,
  Key,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  max_age_days: number;
  warn_days: number;
  updated_at: string;
  updated_by: string | null;
};

type KeySnap = {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  age_days: number;
  status: "ok" | "warning" | "stale" | "disabled";
  days_until_rotation: number | null;
  rotate_by: string | null;
};

type Resp = { policy: Policy; keys: KeySnap[] };

export default function RotationPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function StatusBadge({ status }: { status: KeySnap["status"] }) {
  if (status === "stale") {
    return (
      <Badge tone="down">
        <XCircle size={11} weight="duotone" /> stale
      </Badge>
    );
  }
  if (status === "warning") {
    return (
      <Badge tone="warn">
        <Warning size={11} weight="duotone" /> rotate soon
      </Badge>
    );
  }
  if (status === "ok") {
    return (
      <Badge tone="up">
        <CheckCircle size={11} weight="duotone" /> ok
      </Badge>
    );
  }
  return <Badge tone="neutral">no policy</Badge>;
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    "/admin/rotation-policy",
    swrFetcher,
  );

  const [maxAge, setMaxAge] = useState<string>("0");
  const [warn, setWarn] = useState<string>("7");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.policy) {
      setMaxAge(String(data.policy.max_age_days));
      setWarn(String(data.policy.warn_days));
    }
  }, [data?.policy]);

  function parseDays(raw: string, name: string): number | null {
    const t = raw.trim();
    if (t === "") {
      setFormError(`${name} is required. Use 0 to disable.`);
      return null;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > 3650) {
      setFormError(
        `${name} must be a whole number between 0 and 3650.`,
      );
      return null;
    }
    return n;
  }

  async function save() {
    setFormError(null);
    setMsg(null);
    const m = parseDays(maxAge, "Max key age");
    if (m == null) return;
    const w = parseDays(warn, "Warning window");
    if (w == null) return;
    if (m > 0 && w > m) {
      setFormError("Warning window cannot exceed max key age.");
      return;
    }
    setSaving(true);
    try {
      await api("/admin/rotation-policy", {
        method: "PUT",
        body: JSON.stringify({ max_age_days: m, warn_days: w }),
      });
      setMsg(m === 0 ? "Rotation policy disabled." : "Rotation policy updated.");
      await mutate();
    } catch (e: any) {
      const body = e instanceof ApiError ? e.body : String(e?.message || e);
      setFormError(`Save failed: ${body}`);
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const policy = data.policy;
  const enforcing = policy.max_age_days > 0;
  const staleCount = data.keys.filter((k) => k.status === "stale").length;
  const warnCount = data.keys.filter((k) => k.status === "warning").length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Security
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <ArrowsClockwise size={18} weight="duotone" /> Key rotation policy
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Enforce a maximum age for every API key in this workspace. Stale
            keys are blocked with a structured 403 on every /v1 request and a
            warning header ships during the rotation window.
          </p>
        </div>
        <Link
          href="/settings"
          className="text-[11px] muted hover:text-white"
        >
          Back to settings
        </Link>
      </header>

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={14} weight="duotone" />
          <h2 className="text-sm font-medium">Policy</h2>
          {enforcing ? (
            <Badge tone="up">enforcing</Badge>
          ) : (
            <Badge tone="neutral">disabled</Badge>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Field label="Max key age (days)">
              <Input
                type="number"
                min={0}
                max={3650}
                step={1}
                value={maxAge}
                onChange={(e) => setMaxAge(e.target.value)}
              />
            </Field>
            <div className="text-[10px] muted mt-1">0 disables enforcement.</div>
          </div>
          <div>
            <Field label="Warning window (days)">
              <Input
                type="number"
                min={0}
                max={3650}
                step={1}
                value={warn}
                onChange={(e) => setWarn(e.target.value)}
              />
            </Field>
            <div className="text-[10px] muted mt-1">Days before cutoff that warning headers appear.</div>
          </div>
        </div>
        {formError && (
          <div className="text-[11px] text-red-400 mt-2">{formError}</div>
        )}
        {msg && (
          <div className="text-[11px] text-emerald-400 mt-2 inline-flex items-center gap-1">
            <CheckCircle size={12} weight="duotone" /> {msg}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <div className="muted text-[10px]">
            Last updated {policy.updated_at === "1970-01-01T00:00:00.000Z"
              ? "never"
              : new Date(policy.updated_at).toLocaleString()}
            {policy.updated_by ? ` by ${policy.updated_by}` : ""}
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving" : "Save policy"}
          </Button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Key size={14} weight="duotone" />
            <h2 className="text-sm font-medium">Active keys</h2>
          </div>
          <div className="flex items-center gap-2">
            {staleCount > 0 && (
              <Badge tone="down">{staleCount} stale</Badge>
            )}
            {warnCount > 0 && (
              <Badge tone="warn">{warnCount} rotate soon</Badge>
            )}
          </div>
        </div>
        {data.keys.length === 0 ? (
          <div className="text-[11px] muted py-6 text-center">
            No active API keys.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-left muted">
                <tr>
                  <th className="py-1.5 pr-3">Label</th>
                  <th className="py-1.5 pr-3">Prefix</th>
                  <th className="py-1.5 pr-3">Age</th>
                  <th className="py-1.5 pr-3">Rotate by</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 mono">{k.label}</td>
                    <td className="py-1.5 pr-3 mono muted">{k.prefix}</td>
                    <td className="py-1.5 pr-3 mono">{k.age_days}d</td>
                    <td className="py-1.5 pr-3 mono muted">
                      {k.rotate_by
                        ? new Date(k.rotate_by).toLocaleDateString()
                        : "no policy"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={k.status} />
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <Link
                        href="/settings/keys"
                        className="muted hover:text-white"
                      >
                        Rotate
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}

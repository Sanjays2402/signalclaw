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
  Shield,
  ShieldCheck,
  ShieldWarning,
  Plus,
  Trash,
  Eye,
  EyeSlash,
  Warning,
} from "@phosphor-icons/react/dist/ssr";

type CspMode = "off" | "report" | "enforce";

type Effective = {
  mode: CspMode;
  header_name: string | null;
  header_value: string | null;
  extra_hosts_env: string;
  source: "env";
};

type Resp = {
  policy: {
    mode: CspMode;
    extra_hosts: string[];
    reporting_enabled: boolean;
    updated_at: string | null;
    updated_by: string | null;
  };
  effective: Effective;
  max_hosts: number;
  drift: boolean;
};

export default function CspPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    "/admin/csp",
    swrFetcher,
  );

  const [mode, setMode] = useState<CspMode>("off");
  const [reporting, setReporting] = useState(true);
  const [hosts, setHosts] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(false);

  useEffect(() => {
    if (data) {
      setMode(data.policy.mode);
      setReporting(data.policy.reporting_enabled);
      setHosts(data.policy.extra_hosts);
    }
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (mode !== data.policy.mode) return true;
    if (reporting !== data.policy.reporting_enabled) return true;
    if (hosts.length !== data.policy.extra_hosts.length) return true;
    return hosts.some((h, i) => h !== data.policy.extra_hosts[i]);
  }, [data, mode, reporting, hosts]);

  function addDraft() {
    const v = draft.trim();
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
      const next = await api<Resp>("/admin/csp", {
        method: "PUT",
        body: JSON.stringify({
          mode,
          extra_hosts: hosts,
          reporting_enabled: reporting,
        }),
      });
      setOk("Saved. Effective policy updates on next deploy.");
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
          ? "You need an admin API key with MFA to view CSP."
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
        <Loading label="Loading CSP policy" />
      </div>
    );
  }

  const eff = data.effective;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Admin
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <Shield size={18} weight="duotone" /> Content Security Policy
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Tell browsers what the dashboard is allowed to load. Roll out
            in report mode, watch the audit log for violations, then flip
            to enforce when the report stream is quiet.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/settings" className="text-[11px] muted hover:text-white">
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

      {data.drift ? (
        <div className="text-xs text-amber-300 border border-amber-400/30 bg-amber-400/5 rounded px-3 py-2 inline-flex items-start gap-2">
          <Warning size={14} weight="duotone" className="mt-0.5 shrink-0" />
          <div>
            The saved policy differs from the effective policy. The
            edge middleware reads CSP from environment variables. Update
            <code className="mono px-1">SIGNALCLAW_CSP_MODE</code> and
            <code className="mono px-1">SIGNALCLAW_CSP_EXTRA_HOSTS</code>
            in your deploy config to match, then redeploy.
          </div>
        </div>
      ) : null}

      <Card>
        <div className="space-y-3">
          <div className="text-sm font-medium inline-flex items-center gap-2">
            <ShieldCheck size={14} weight="duotone" /> Mode
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(["off", "report", "enforce"] as CspMode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setOk(null);
                  setErr(null);
                }}
                className={`text-left rounded border px-3 py-2 text-xs transition ${
                  mode === m
                    ? "border-white/40 bg-white/5"
                    : "border-white/10 hover:border-white/25"
                }`}
                aria-pressed={mode === m}
              >
                <div className="text-sm mono">{m}</div>
                <div className="muted text-[11px] mt-1">
                  {m === "off"
                    ? "No CSP header sent."
                    : m === "report"
                      ? "Send Report-Only. Browsers warn but never block."
                      : "Send enforcing header. Browsers block violations."}
                </div>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Trusted source hosts{" "}
              <span className="muted text-[11px]">
                ({hosts.length}/{data.max_hosts})
              </span>
            </div>
            {data.policy.updated_at ? (
              <div className="muted text-[11px]">
                last change {data.policy.updated_at}
                {data.policy.updated_by ? ` by ${data.policy.updated_by}` : ""}
              </div>
            ) : null}
          </div>
          <Field label="Add host or source expression">
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
                placeholder="cdn.example.com or *.intercom.io"
                className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm mono focus:outline-none focus:border-white/30"
                aria-label="CSP host to allow"
              />
              <Button onClick={addDraft} disabled={!draft.trim()}>
                <Plus size={12} weight="duotone" /> Add
              </Button>
            </div>
          </Field>
          {hosts.length === 0 ? (
            <div className="muted text-xs border border-dashed border-white/10 rounded p-3 text-center">
              No extra hosts. Only the dashboard origin will be allowed.
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
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-medium">Violation reporting</div>
            <div className="muted text-xs mt-1 max-w-md">
              When on, the browser POSTs CSP violations to
              <code className="mono px-1">/api/csp-report</code>. Each
              violation lands in the tamper-evident audit log so SOC
              operators can spot stored XSS attempts.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{reporting ? "on" : "off"}</Badge>
            <Button
              onClick={() => {
                setReporting(!reporting);
                setOk(null);
                setErr(null);
              }}
            >
              {reporting ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Effective header{" "}
              <span className="muted text-[11px]">
                ({eff.mode === "off" ? "not sent" : eff.header_name})
              </span>
            </div>
            {eff.header_value ? (
              <button
                onClick={() => setShowHeader(!showHeader)}
                className="muted hover:text-white text-[11px] inline-flex items-center gap-1"
              >
                {showHeader ? (
                  <>
                    <EyeSlash size={12} weight="duotone" /> Hide
                  </>
                ) : (
                  <>
                    <Eye size={12} weight="duotone" /> Show
                  </>
                )}
              </button>
            ) : null}
          </div>
          {eff.header_value && showHeader ? (
            <pre className="text-[11px] mono bg-black/30 border border-white/10 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {eff.header_value}
            </pre>
          ) : null}
          <div className="muted text-[11px]">
            The dashboard middleware reads CSP from env. The persisted
            policy above is the source of truth for documentation and
            audit, but environment variables drive the live header.
          </div>
        </div>
      </Card>

      {err ? <ErrorBox err={err} /> : null}
      {ok ? (
        <div className="text-xs text-emerald-300 border border-emerald-400/30 bg-emerald-400/5 rounded px-3 py-2 inline-flex items-center gap-2">
          <ShieldCheck size={14} weight="duotone" /> {ok}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => {
            if (!data) return;
            setMode(data.policy.mode);
            setReporting(data.policy.reporting_enabled);
            setHosts(data.policy.extra_hosts);
            setOk(null);
            setErr(null);
          }}
          disabled={!dirty || saving}
        >
          Reset
        </Button>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

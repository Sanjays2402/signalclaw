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
  Input,
  Select,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Key,
  ShieldWarning,
  Clock,
  Lifebuoy,
  ArrowCounterClockwise,
  Lock,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr";

type Grant = {
  id: string;
  granted_at: string;
  expires_at: string;
  granted_by: string | null;
  reason: string;
  ttl_seconds: number;
  uses: number;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  expired: boolean;
  seconds_remaining: number;
};

type State = {
  active: Grant | null;
  history: Grant[];
  limits: {
    min_reason_len: number;
    max_reason_len: number;
    default_ttl_seconds: number;
    max_ttl_seconds: number;
  };
};

function fmtRemaining(s: number): string {
  if (s <= 0) return "0s";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTs(s: string | null): string {
  if (!s) return "never";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export default function BreakGlassPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<State>(
    "/admin/breakglass",
    swrFetcher,
    { refreshInterval: 5000 },
  );

  const limits = data?.limits;
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState<string>("1800");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (limits && ttl === "1800") {
      setTtl(String(limits.default_ttl_seconds));
    }
    // only on first load of limits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limits?.default_ttl_seconds]);

  const reasonTooShort = useMemo(
    () =>
      (limits && reason.trim().length < limits.min_reason_len) || !reason.trim(),
    [reason, limits],
  );

  async function onGrant() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const body = { reason: reason.trim(), ttl_seconds: Number(ttl) };
      await api("/admin/breakglass", { method: "POST", body: JSON.stringify(body) });
      setOk("Break-glass grant issued. Use it sparingly.");
      setReason("");
      await mutate();
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await api("/admin/breakglass", { method: "DELETE" });
      setOk("Active grant revoked.");
      await mutate();
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Loading label="Loading break-glass state" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const active = data.active && !data.active.expired ? data.active : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs muted">
          <Link href="/settings" className="hover:text-white">Settings</Link>
          <span aria-hidden>/</span>
          <span>Break glass</span>
        </div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Lifebuoy size={20} weight="duotone" /> Break-glass emergency access
        </h1>
        <p className="text-sm muted leading-relaxed">
          Time-boxed override that lets an admin reach the workspace from an IP
          outside the network allowlist during an incident. Only the workspace
          IP allowlist is bypassed. Admin MFA, per-key IP allowlists, scope and
          rate-limit checks remain in force. Every grant, use and revoke is
          written to the tamper-evident audit chain.
        </p>
      </header>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Key size={16} weight="duotone" /> Active grant
          </h2>
          {active ? (
            <Badge tone="warn">Active</Badge>
          ) : (
            <Badge tone="up">None</Badge>
          )}
        </div>
        {active ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <KV label="Expires in" value={fmtRemaining(active.seconds_remaining)} icon={<Clock size={14} weight="duotone" />} />
              <KV label="Expires at" value={fmtTs(active.expires_at)} />
              <KV label="Granted at" value={fmtTs(active.granted_at)} />
              <KV label="Granted by" value={active.granted_by ?? "local"} />
              <KV label="Uses so far" value={String(active.uses)} />
              <KV label="Last used" value={fmtTs(active.last_used_at)} />
            </div>
            <div className="rounded border border-white/10 bg-white/5 p-3">
              <div className="text-[11px] muted uppercase tracking-wide">Reason</div>
              <div className="text-sm mt-1 break-words whitespace-pre-wrap">{active.reason}</div>
            </div>
            <div className="flex justify-end">
              <Button onClick={onRevoke} disabled={busy} variant="danger">
                <ArrowCounterClockwise size={14} weight="duotone" /> Revoke now
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm muted flex items-center gap-2">
            <CheckCircle size={16} weight="duotone" />
            No active grant. The network allowlist is fully enforced.
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
          <ShieldWarning size={16} weight="duotone" /> Issue a new grant
        </h2>
        <p className="text-xs muted mb-4 leading-relaxed">
          Issuing a new grant immediately supersedes any existing one. Use only
          to recover from a real incident. The reason is stored verbatim in the
          audit log and shown on every settings load.
        </p>
        <div className="space-y-3">
          <Field label="Reason (required)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={limits?.max_reason_len ?? 500}
              rows={3}
              className="w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-sm focus:outline-none focus:border-white/40"
              placeholder="e.g. on-call rotation from offsite IP, revoking compromised key sk_live_..."
            />
            <div className="text-[11px] muted mt-1 flex items-center justify-between">
              <span>
                {reason.trim().length} / {limits?.max_reason_len ?? 500}
              </span>
              <span>
                min {limits?.min_reason_len ?? 10} characters
              </span>
            </div>
          </Field>
          <Field label="Duration">
            <Select value={ttl} onChange={(e) => setTtl(e.target.value)}>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="2700">45 minutes</option>
              <option value="3600">60 minutes (max)</option>
            </Select>
          </Field>
          {err && <ErrorBox err={err} />}
          {ok && (
            <div className="text-xs text-emerald-300 flex items-center gap-1.5">
              <CheckCircle size={14} weight="duotone" /> {ok}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              onClick={onGrant}
              disabled={busy || reasonTooShort}
              variant="primary"
            >
              <Lifebuoy size={14} weight="duotone" /> Grant break-glass
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Lock size={16} weight="duotone" /> Recent history
        </h2>
        {data.history.length === 0 ? (
          <div className="text-sm muted">No prior grants recorded.</div>
        ) : (
          <div className="space-y-2">
            {data.history.slice(0, 10).map((g) => (
              <div
                key={g.id}
                className="rounded border border-white/10 bg-white/5 p-3 text-sm space-y-1"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="font-mono text-[11px] muted truncate">{g.id}</div>
                  <Badge tone={g.revoked_at || g.expired ? "neutral" : "warn"}>
                    {g.revoked_at ? "revoked" : g.expired ? "expired" : "active"}
                  </Badge>
                </div>
                <div className="text-[11px] muted">
                  granted {fmtTs(g.granted_at)} by {g.granted_by ?? "local"} ·{" "}
                  {g.uses} use{g.uses === 1 ? "" : "s"} · revoked {fmtTs(g.revoked_at)}
                </div>
                <div className="text-xs break-words whitespace-pre-wrap">
                  {g.reason}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function KV({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] muted uppercase tracking-wide flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className="text-sm mt-0.5 font-mono break-words">{value}</div>
    </div>
  );
}

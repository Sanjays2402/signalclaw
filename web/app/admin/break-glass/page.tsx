"use client";
// Admin: break-glass emergency admin elevation.
//
// SOC2 CC6.1 and ISO 27001 A.9.2.3 require a documented, audited,
// time-bound process for granting emergency elevated access. This page
// is the human surface for that process: an admin pastes a non-admin
// API key, types the incident ticket as the reason, picks a TTL, and
// the FastAPI route /admin/break-glass mints a time-boxed grant. While
// the grant is live the target key picks up the ``admin`` scope on
// every middleware check; the moment the TTL expires or the grant is
// revoked the target drops straight back to its baseline role.
//
// The screen makes the procurement evidence trivial: active grants on
// top with countdown timers, history below with status, reason, and
// who issued and who revoked. Empty / loading / error states wired.
// Responsive at 375 and 1440.
import useSWR from "swr";
import { useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
  Button,
  Input,
  Select,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Key,
  Warning,
  ShieldCheck,
  Timer,
  Lock,
  ArrowSquareOut,
  Siren,
} from "@phosphor-icons/react/dist/ssr";

type Grant = {
  id: string;
  target_key_hash: string;
  target_label: string;
  reason: string;
  granted_at: string;
  expires_at: string;
  granted_by_hash: string;
  revoked_at: string | null;
  revoked_by_hash: string | null;
  used_count: number;
  last_used_at: string | null;
  status: "active" | "revoked" | "expired";
  remaining_seconds: number;
};

type Resp = {
  max_ttl_seconds: number;
  min_ttl_seconds: number;
  grants: Grant[];
};

const TTL_OPTIONS: Array<[string, number]> = [
  ["15 minutes", 15 * 60],
  ["30 minutes", 30 * 60],
  ["1 hour", 60 * 60],
  ["2 hours", 2 * 60 * 60],
  ["4 hours", 4 * 60 * 60],
];

function fmtRemaining(s: number): string {
  if (s <= 0) return "00:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function statusBadge(g: Grant) {
  if (g.status === "active")
    return <Badge tone="warn">active</Badge>;
  if (g.status === "revoked")
    return <Badge tone="down">revoked</Badge>;
  return <Badge tone="info">expired</Badge>;
}

export default function AdminBreakGlassPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    "/admin/break-glass?include_inactive=true",
    swrFetcher,
    { refreshInterval: 5000 },
  );

  const [targetKey, setTargetKey] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState(60 * 60);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setOkMsg(null);
    if (!targetKey.trim()) {
      setSubmitError("Paste the API key that needs elevation.");
      return;
    }
    if (reason.trim().length < 8) {
      setSubmitError("Reason must be at least 8 characters (use the incident ticket id).");
      return;
    }
    setSubmitting(true);
    try {
      await api("/admin/break-glass", {
        method: "POST",
        body: JSON.stringify({
          target_api_key: targetKey.trim(),
          target_label: targetLabel.trim() || undefined,
          reason: reason.trim(),
          ttl_seconds: ttl,
        }),
      });
      setTargetKey("");
      setTargetLabel("");
      setReason("");
      setOkMsg("Grant issued. The target key now has admin scope.");
      await mutate();
    } catch (e) {
      const msg =
        e instanceof ApiError ? safeDetail(e.body) || e.message : String(e);
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/admin/break-glass/${id}/revoke`, { method: "POST" });
      await mutate();
    } catch (e) {
      const msg =
        e instanceof ApiError ? safeDetail(e.body) || e.message : String(e);
      setSubmitError(msg);
    }
  }

  const active = (data?.grants || []).filter((g) => g.status === "active");
  const history = (data?.grants || []).filter((g) => g.status !== "active");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Siren size={28} weight="duotone" className="text-amber-500" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Break-glass access
            </h1>
            <p className="text-sm text-neutral-500 max-w-prose">
              Grant a non-admin API key the {`"admin"`} scope for a bounded
              window. Every grant is audited, capped at {data ? `${data.max_ttl_seconds / 3600}h` : "4h"},
              and expires automatically. Required for SOC2 CC6.1 emergency
              access.
            </p>
          </div>
        </div>
        <Link
          href="/admin"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 inline-flex items-center gap-1"
        >
          Admin console <ArrowSquareOut size={14} />
        </Link>
      </header>

      <Card>
        <form onSubmit={submit} className="space-y-4 p-4">
          <div className="flex items-center gap-2">
            <Lock size={18} weight="duotone" className="text-neutral-500" />
            <h2 className="text-sm font-medium">Issue new grant</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-neutral-600 dark:text-neutral-400">
                Target API key
              </span>
              <Input
                value={targetKey}
                onChange={(e) => setTargetKey(e.target.value)}
                placeholder="sc_live_..."
                autoComplete="off"
                type="password"
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-neutral-600 dark:text-neutral-400">
                Label (optional)
              </span>
              <Input
                value={targetLabel}
                onChange={(e) => setTargetLabel(e.target.value)}
                placeholder="on-call shift, ingest-worker"
                maxLength={64}
              />
            </label>
            <label className="text-sm space-y-1 sm:col-span-2">
              <span className="text-neutral-600 dark:text-neutral-400">
                Reason (incident ticket required for audit)
              </span>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="SC-1234: ingest worker wedged, need /admin/keys"
                maxLength={512}
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-neutral-600 dark:text-neutral-400">
                Window
              </span>
              <Select
                value={String(ttl)}
                onChange={(e) => setTtl(parseInt(e.target.value, 10))}
              >
                {TTL_OPTIONS.map(([label, secs]) => (
                  <option key={secs} value={secs}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {submitError ? (
            <div className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
              <Warning size={14} weight="duotone" />
              {submitError}
            </div>
          ) : null}
          {okMsg ? (
            <div className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <ShieldCheck size={14} weight="duotone" />
              {okMsg}
            </div>
          ) : null}
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Issuing..." : "Issue grant"}
            </Button>
          </div>
        </form>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
          <Timer size={16} weight="duotone" /> Active grants
        </h2>
        {isLoading ? (
          <Loading label="Loading grants" />
        ) : error ? (
          <ErrorBox err={error} />
        ) : active.length === 0 ? (
          <Empty
            title="No active break-glass grants"
            hint="Nothing is currently elevated. Healthy default state."
          />
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <GrantRow key={g.id} g={g} onRevoke={() => revoke(g.id)} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
          <Key size={16} weight="duotone" /> History
        </h2>
        {isLoading ? null : history.length === 0 ? (
          <Empty
            title="No prior grants"
            hint="Issued and revoked grants appear here for the audit trail."
          />
        ) : (
          <ul className="space-y-2">
            {history.slice(0, 50).map((g) => (
              <GrantRow key={g.id} g={g} historical />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GrantRow({
  g,
  onRevoke,
  historical,
}: {
  g: Grant;
  onRevoke?: () => void;
  historical?: boolean;
}) {
  return (
    <li>
      <Card>
        <div className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {statusBadge(g)}
                <span className="font-mono text-xs text-neutral-500 truncate">
                  {g.target_key_hash}
                </span>
                {g.target_label ? (
                  <span className="text-sm">{g.target_label}</span>
                ) : null}
              </div>
              <p className="text-sm text-neutral-700 dark:text-neutral-300 break-words">
                {g.reason}
              </p>
              <p className="text-xs text-neutral-500">
                granted {new Date(g.granted_at).toLocaleString()} by{" "}
                <span className="font-mono">{g.granted_by_hash}</span>
                {g.revoked_at ? (
                  <>
                    {" "}
                    · revoked {new Date(g.revoked_at).toLocaleString()} by{" "}
                    <span className="font-mono">
                      {g.revoked_by_hash || "-"}
                    </span>
                  </>
                ) : null}
                {" · "}used {g.used_count}x
              </p>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              {g.status === "active" ? (
                <span
                  className="font-mono text-base text-amber-600 dark:text-amber-400"
                  aria-label="time remaining"
                >
                  {fmtRemaining(g.remaining_seconds)}
                </span>
              ) : null}
              {!historical && onRevoke ? (
                <Button onClick={onRevoke}>Revoke</Button>
              ) : null}
            </div>
          </div>
        </div>
      </Card>
    </li>
  );
}

function safeDetail(body: string): string | null {
  try {
    const j = JSON.parse(body);
    if (typeof j?.detail === "string") return j.detail;
    if (typeof j?.error?.message === "string") return j.error.message;
  } catch {
    /* fall through */
  }
  return null;
}

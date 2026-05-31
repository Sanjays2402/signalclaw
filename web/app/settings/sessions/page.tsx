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
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  SignOut,
  UserMinus,
  Lightning,
  Warning,
  ClockCounterClockwise,
  Monitor,
} from "@phosphor-icons/react/dist/ssr";

type SessionRow = {
  jti: string;
  sub: string;
  email: string;
  iss: string;
  iat: number;
  exp: number;
  ip_hash: string;
  user_agent: string;
  last_seen_at: number | null;
  last_seen_ip_hash: string;
  revoked_at: number | null;
  revoked_by: string | null;
  revoked_reason: string | null;
};

type ListResponse = {
  sessions: SessionRow[];
  global_epoch: number;
  active_count: number;
};

export default function SessionsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function fmtAgo(unixSec: number): string {
  if (!unixSec) return "unknown";
  const d = new Date(unixSec * 1000);
  const diff = Math.max(0, Date.now() - d.getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortenUa(ua: string): string {
  if (!ua) return "unknown client";
  // Cheap heuristic: pick the first parenthesized bit + first product token.
  const m = ua.match(/^([A-Za-z]+\/[\d.]+)/);
  const parens = ua.match(/\(([^)]+)\)/);
  if (m && parens) return `${m[1]} (${parens[1].split(";")[0].trim()})`;
  if (m) return m[1];
  return ua.slice(0, 64);
}

function Inner() {
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [emailFilter, setEmailFilter] = useState("");
  const qs = new URLSearchParams();
  if (includeRevoked) qs.set("include_revoked", "1");
  if (emailFilter.trim()) qs.set("email", emailFilter.trim().toLowerCase());
  const url = `/admin/sessions${qs.toString() ? `?${qs.toString()}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(url, swrFetcher);

  const [revokeEmail, setRevokeEmail] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [bumpReason, setBumpReason] = useState("");
  const [bumpConfirm, setBumpConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function callApi(label: string, run: () => Promise<unknown>) {
    setBusy(label);
    setOkMsg(null);
    setErrMsg(null);
    try {
      await run();
      await mutate();
    } catch (e) {
      setErrMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revokeOne(row: SessionRow) {
    await callApi(`del:${row.jti}`, async () => {
      await api(`/admin/sessions/${encodeURIComponent(row.jti)}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "admin-console" }),
      });
      setOkMsg(`Revoked session for ${row.email}.`);
    });
  }

  async function revokeByEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    const email = revokeEmail.trim().toLowerCase();
    if (!email) return;
    await callApi("email", async () => {
      const res: { revoked: number; email: string } = await api("/admin/sessions/revoke-by-email", {
        method: "POST",
        body: JSON.stringify({ email, reason: revokeReason.trim() || "offboarded" }),
      });
      setOkMsg(`Revoked ${res.revoked} session${res.revoked === 1 ? "" : "s"} for ${res.email}.`);
      setRevokeEmail("");
      setRevokeReason("");
    });
  }

  async function bumpEpoch(e: React.FormEvent) {
    e.preventDefault();
    if (bumpConfirm.trim() !== "FORCE LOGOUT ALL") return;
    await callApi("bump", async () => {
      const res: { epoch: number; revoked: number } = await api("/admin/sessions/bump-epoch", {
        method: "POST",
        body: JSON.stringify({ reason: bumpReason.trim() || "global-force-logout" }),
      });
      setOkMsg(`Global epoch bumped. Revoked ${res.revoked} active session${res.revoked === 1 ? "" : "s"}.`);
      setBumpReason("");
      setBumpConfirm("");
    });
  }

  if (isLoading) return <Loading label="Loading sessions" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const rows = data.sessions;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <ShieldCheck size={28} weight="duotone" className="mt-1 text-sky-500" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">SSO sessions</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Every signed-in browser session minted by the SSO callback is
            tracked here. Revoke individually, kill every session for a
            departed user, or force every device through the IdP again.
            IPs are stored only as SHA-256 hashes.
          </p>
        </div>
      </header>

      {errMsg ? <ErrorBox err={errMsg} /> : null}
      {okMsg ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-500">
          {okMsg}
        </div>
      ) : null}

      <Card>
        <div className="space-y-3 p-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 text-sm">
              <Badge tone="up">
                <Monitor size={14} weight="duotone" />
                <span className="ml-1">{data.active_count} active</span>
              </Badge>
              {data.global_epoch ? (
                <span className="muted text-[11px]">
                  Global epoch bumped {fmtAgo(data.global_epoch)}
                </span>
              ) : (
                <span className="muted text-[11px]">No global force-logout on file</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="search"
                value={emailFilter}
                onChange={(e) => setEmailFilter(e.target.value)}
                placeholder="Filter by email"
                className="w-56 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[12px] focus:border-neutral-600 focus:outline-none"
              />
              <label className="inline-flex items-center gap-2 text-[11px] muted">
                <input
                  type="checkbox"
                  checked={includeRevoked}
                  onChange={(e) => setIncludeRevoked(e.target.checked)}
                />
                Show revoked
              </label>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              No sessions to show. They appear here as soon as users sign in via SSO.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {rows.map((r) => {
                const revoked = r.revoked_at !== null;
                return (
                  <li key={r.jti} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium">{r.email}</span>
                        {revoked ? (
                          <Badge tone="down">
                            <span className="text-[10px]">revoked</span>
                          </Badge>
                        ) : (
                          <Badge tone="up">
                            <span className="text-[10px]">active</span>
                          </Badge>
                        )}
                      </div>
                      <div className="muted mt-0.5 truncate text-[11px]">
                        {shortenUa(r.user_agent)} {"\u00b7"} signed in {fmtAgo(r.iat)} {"\u00b7"} {r.last_seen_at ? `last seen ${fmtAgo(r.last_seen_at)}` : "never used"} {"\u00b7"} expires {fmtAgo(r.exp).replace(" ago", "")} from now
                      </div>
                      <div className="muted mt-0.5 truncate font-mono text-[10px]">
                        jti {r.jti.slice(0, 12)} {"\u00b7"} ip# {r.ip_hash ? r.ip_hash.slice(0, 12) : "none"}
                        {revoked && r.revoked_by ? ` \u00b7 killed by ${r.revoked_by}` : ""}
                      </div>
                    </div>
                    {!revoked ? (
                      <Button
                        onClick={() => revokeOne(r)}
                        disabled={busy === `del:${r.jti}`}
                        variant="danger"
                      >
                        <SignOut size={14} weight="duotone" className="mr-1.5" />
                        {busy === `del:${r.jti}` ? "Revoking..." : "Revoke"}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card title="Offboard a user">
        <form onSubmit={revokeByEmailSubmit} className="space-y-3 p-1">
          <p className="text-sm text-neutral-500">
            Kill every active session for one email address. Use this the
            moment HR deactivates the account in the IdP.
          </p>
          <Field label="Email">
            <input
              type="email"
              value={revokeEmail}
              onChange={(e) => setRevokeEmail(e.target.value)}
              placeholder="alice@example.com"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
              required
            />
          </Field>
          <Field label="Reason (optional, shown in audit log)">
            <input
              type="text"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value.slice(0, 280))}
              placeholder="Offboarded 2026-05-31"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy === "email" || !revokeEmail.trim()}>
              <UserMinus size={14} weight="duotone" className="mr-1.5" />
              {busy === "email" ? "Revoking..." : "Revoke all sessions"}
            </Button>
          </div>
        </form>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            <Warning size={14} weight="duotone" className="text-amber-500" />
            Global force-logout
          </span>
        }
      >
        <form onSubmit={bumpEpoch} className="space-y-3 p-1">
          <p className="text-sm text-neutral-500">
            Invalidate every SSO session at once. Use after a suspected key
            compromise, lost laptop, or any time the safest answer is
            send everyone back through the IdP right now.
          </p>
          <Field label="Reason">
            <input
              type="text"
              value={bumpReason}
              onChange={(e) => setBumpReason(e.target.value.slice(0, 280))}
              placeholder="Suspected HMAC key leak in CI logs"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </Field>
          <Field label="Type FORCE LOGOUT ALL to confirm">
            <input
              type="text"
              value={bumpConfirm}
              onChange={(e) => setBumpConfirm(e.target.value)}
              placeholder="FORCE LOGOUT ALL"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="muted inline-flex items-center gap-1.5 text-[11px]">
              <ClockCounterClockwise size={12} weight="duotone" />
              You will be signed out too.
            </span>
            <Button
              type="submit"
              variant="danger"
              disabled={busy === "bump" || bumpConfirm.trim() !== "FORCE LOGOUT ALL"}
            >
              <Lightning size={14} weight="duotone" className="mr-1.5" />
              {busy === "bump" ? "Bumping..." : "Force logout everyone"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

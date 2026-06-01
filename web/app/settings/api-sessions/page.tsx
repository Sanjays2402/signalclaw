"use client";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Badge,
  Empty,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Monitor,
  ShieldCheck,
  SignOut,
  UserCircle,
  ClockCounterClockwise,
} from "@phosphor-icons/react/dist/ssr";
import { useState } from "react";

type SessionRow = {
  id: string;
  key_id: string;
  key_label: string;
  source_ip: string;
  user_agent: string;
  first_seen: string;
  last_seen: string;
  request_count: number;
  revoked: boolean;
  current: boolean;
};

type ListResponse = {
  key_id: string;
  current_session_id: string;
  sessions: SessionRow[];
};

export default function ApiSessionsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function fmtAgo(iso: string): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortenUa(ua: string): string {
  if (!ua) return "unknown client";
  const m = ua.match(/^([A-Za-z]+\/[\d.]+)/);
  const parens = ua.match(/\(([^)]+)\)/);
  if (m && parens) return `${m[1]} (${parens[1].split(";")[0].trim()})`;
  if (m) return m[1];
  return ua.slice(0, 64);
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(
    "/me/sessions",
    swrFetcher,
    { refreshInterval: 15000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function revokeOne(id: string) {
    if (busy) return;
    setBusy(id);
    setFlash(null);
    try {
      const res = await api<{ revoked: string; self_logged_out: boolean }>(
        `/me/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setFlash({
        kind: "ok",
        msg: res.self_logged_out
          ? "Signed out. Other clients using this key are unaffected."
          : "Session revoked.",
      });
      await mutate();
    } catch (e) {
      const m = e instanceof ApiError ? e.body || e.message : String(e);
      setFlash({ kind: "err", msg: m });
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    if (busy) return;
    if (!confirm("Sign out every other session for this API key?")) return;
    setBusy("__others__");
    setFlash(null);
    try {
      const res = await api<{ count: number }>(
        "/me/sessions/revoke-others",
        { method: "POST" },
      );
      setFlash({
        kind: "ok",
        msg: `Revoked ${res.count} other session${res.count === 1 ? "" : "s"}.`,
      });
      await mutate();
    } catch (e) {
      const m = e instanceof ApiError ? e.body || e.message : String(e);
      setFlash({ kind: "err", msg: m });
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return <Loading label="Loading your sessions" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return <Loading label="Loading your sessions" />;

  const sessions = data.sessions;
  const others = sessions.filter((s) => !s.current && !s.revoked);

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <UserCircle size={20} weight="duotone" className="text-violet-300" />
          <h1 className="text-lg font-semibold">Your API sessions</h1>
        </div>
        <p className="text-[12px] muted">
          Every IP and client that has called the API with your key in the
          last 14 days. Revoke any session that looks unfamiliar; the
          underlying API key stays valid.
        </p>
        <p className="text-[11px] muted">
          Scope: key <code className="px-1 rounded bg-white/5">{data.key_id || "unknown"}</code>
        </p>
      </header>

      {flash && (
        <div
          role="status"
          className={`text-[12px] rounded-md px-3 py-2 border ${
            flash.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-200"
          }`}
        >
          {flash.msg}
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Monitor size={16} weight="duotone" className="text-blue-300" />
            <span className="text-sm font-medium">
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </span>
          </div>
          <Button
            onClick={revokeOthers}
            disabled={others.length === 0 || busy !== null}
          >
            <SignOut size={14} weight="duotone" />
            <span className="ml-1">
              {busy === "__others__"
                ? "Revoking..."
                : `Sign out other sessions (${others.length})`}
            </span>
          </Button>
        </div>

        {sessions.length === 0 ? (
          <Empty
            title="No active sessions"
            hint="Sessions appear here after your first API call."
          />
        ) : (
          <ul className="divide-y divide-white/5">
            {sessions.map((s) => (
              <li key={s.id} className="py-3 flex items-start gap-3">
                <Monitor
                  size={18}
                  weight="duotone"
                  className={s.current ? "text-emerald-300" : "text-zinc-400"}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm truncate">
                      {shortenUa(s.user_agent)}
                    </span>
                    {s.current && (
                      <Badge tone="up">
                        <ShieldCheck size={11} weight="duotone" />
                        <span className="ml-1">This session</span>
                      </Badge>
                    )}
                    {s.revoked && <Badge tone="down">Revoked</Badge>}
                  </div>
                  <div className="text-[11px] muted mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{s.source_ip || "unknown ip"}</span>
                    <span>&middot;</span>
                    <span className="inline-flex items-center gap-1">
                      <ClockCounterClockwise size={11} weight="duotone" />
                      {fmtAgo(s.last_seen)}
                    </span>
                    <span>&middot;</span>
                    <span>{s.request_count} requests</span>
                  </div>
                </div>
                <Button
                  onClick={() => revokeOne(s.id)}
                  disabled={s.revoked || busy !== null}
                  title={
                    s.current
                      ? "Sign out this session (you will need to refresh)"
                      : "Revoke this session"
                  }
                >
                  {busy === s.id ? "..." : s.current ? "Sign out" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[11px] muted">
        Operators with the admin scope can see and revoke every session
        from the admin console. This page only shows yours.
      </p>
    </div>
  );
}

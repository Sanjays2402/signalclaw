"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  Handshake,
  Hourglass,
  Prohibit,
  Key,
  Copy,
} from "@phosphor-icons/react/dist/ssr";

type ApprovalRow = {
  id: string;
  action: string;
  target: string;
  reason: string;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  status: "pending" | "approved" | "consumed" | "cancelled" | "expired";
  approved_by: string | null;
  approved_at: string | null;
  approval_token_expires_at: string | null;
  consumed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

type ListResp = { requests: ApprovalRow[] };

export default function ApprovalsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function statusTone(s: ApprovalRow["status"]): "warn" | "info" | "up" | "neutral" {
  if (s === "pending") return "warn";
  if (s === "approved") return "info";
  if (s === "consumed") return "up";
  return "neutral";
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 1) return ms >= 0 ? "in <1m" : "<1m ago";
  if (min < 60) return ms >= 0 ? `in ${min}m` : `${min}m ago`;
  const h = Math.round(min / 60);
  return ms >= 0 ? `in ${h}h` : `${h}h ago`;
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    "/admin/approvals",
    swrFetcher,
    { refreshInterval: 10_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: string; token: string; expires_at: string | null } | null>(null);

  if (isLoading) return <Loading label="Loading approval queue" />;
  if (error) return <ErrorBox err={error} />;

  const rows = data?.requests ?? [];
  const pending = rows.filter((r) => r.status === "pending");
  const approved = rows.filter((r) => r.status === "approved");
  const history = rows.filter((r) => !["pending", "approved"].includes(r.status));

  async function approve(id: string) {
    setBusy(id);
    setErr(null);
    setIssued(null);
    try {
      const resp: any = await api(`/admin/approvals/${id}/approve`, { method: "POST" });
      setIssued({
        id,
        token: resp.approval_token,
        expires_at: resp.approval_token_expires_at,
      });
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.status}: ${e.body || e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancel(id: string) {
    setBusy(id);
    setErr(null);
    try {
      await api(`/admin/approvals/${id}/cancel`, { method: "POST" });
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.status}: ${e.body || e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8 space-y-6">
      <header className="flex items-start gap-3">
        <Handshake size={28} weight="duotone" className="text-zinc-700 mt-1" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dual-control approvals</h1>
          <p className="text-sm text-zinc-600 mt-1">
            Destructive admin actions require a second admin to approve before
            they execute. Maker submits the request. Checker approves and a
            one-time token is minted. The maker retries the original call with
            <code className="mx-1 text-xs bg-zinc-100 rounded px-1 py-0.5">x-approval-token</code>.
          </p>
        </div>
      </header>

      {err && <ErrorBox err={err} />}

      {issued && (
        <Card>
          <div className="flex items-start gap-3">
            <ShieldCheck size={22} weight="duotone" className="text-emerald-600 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">One-time approval token</div>
              <div className="text-xs text-zinc-600 mt-1">
                Hand this to the requester. It is shown once and expires {issued.expires_at ? relTime(issued.expires_at) : "shortly"}.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all text-xs bg-zinc-100 rounded px-2 py-1.5 font-mono">{issued.token}</code>
                <Button
                  onClick={() => navigator.clipboard?.writeText(issued.token).catch(() => {})}
                  aria-label="Copy approval token"
                >
                  <Copy size={16} weight="duotone" /> Copy
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 mb-2 flex items-center gap-2">
          <Hourglass size={16} weight="duotone" /> Pending
          <Badge tone="warn">{pending.length}</Badge>
        </h2>
        {pending.length === 0 ? (
          <Card>
            <div className="text-sm text-zinc-500 py-2">No pending requests.</div>
          </Card>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <Card key={r.id}>
                <RowHeader r={r} />
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={() => approve(r.id)}
                    disabled={busy === r.id}
                    aria-label={`Approve ${r.id}`}
                  >
                    <ShieldCheck size={16} weight="duotone" /> Approve
                  </Button>
                  <Button
                    onClick={() => cancel(r.id)}
                    disabled={busy === r.id}
                    aria-label={`Cancel ${r.id}`}
                  >
                    <Prohibit size={16} weight="duotone" /> Cancel
                  </Button>
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  You cannot approve a request you filed yourself.
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 mb-2 flex items-center gap-2">
          <Key size={16} weight="duotone" /> Approved, awaiting execution
          <Badge tone="info">{approved.length}</Badge>
        </h2>
        {approved.length === 0 ? (
          <Card>
            <div className="text-sm text-zinc-500 py-2">No approved requests waiting to be redeemed.</div>
          </Card>
        ) : (
          <div className="space-y-2">
            {approved.map((r) => (
              <Card key={r.id}>
                <RowHeader r={r} />
                <p className="mt-2 text-xs text-zinc-500">
                  Token expires {relTime(r.approval_token_expires_at)}.
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-700 mb-2">History</h2>
        {history.length === 0 ? (
          <Card>
            <div className="text-sm text-zinc-500 py-2">No closed requests yet.</div>
          </Card>
        ) : (
          <div className="space-y-2">
            {history.slice(0, 25).map((r) => (
              <Card key={r.id}>
                <RowHeader r={r} />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RowHeader({ r }: { r: ApprovalRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
      <code className="text-xs font-mono bg-zinc-100 rounded px-1.5 py-0.5">{r.action}</code>
      <span className="text-zinc-500">on</span>
      <code className="text-xs font-mono bg-zinc-100 rounded px-1.5 py-0.5 truncate max-w-[200px]">{r.target}</code>
      <span className="text-xs text-zinc-500 ml-auto">
        by {r.requested_by} · {relTime(r.requested_at)}
      </span>
      {r.status === "pending" && (
        <span className="text-xs text-amber-700">expires {relTime(r.expires_at)}</span>
      )}
      {r.approved_by && (
        <span className="text-xs text-zinc-500 w-full">
          approved by {r.approved_by} {r.approved_at ? relTime(r.approved_at) : ""}
        </span>
      )}
      {r.reason && (
        <p className="w-full text-xs text-zinc-700 mt-1 bg-zinc-50 rounded px-2 py-1">
          {r.reason}
        </p>
      )}
    </div>
  );
}

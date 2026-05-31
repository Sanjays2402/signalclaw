"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import { swrFetcher } from "@/lib/api";
import {
  ShieldCheck,
  Funnel,
  ArrowsClockwise,
  CheckCircle,
  XCircle,
  Key,
  Clock,
} from "@phosphor-icons/react/dist/ssr";

type AuditEvent = {
  id: string;
  ts: string;
  key_id: string;
  key_label: string;
  key_prefix: string;
  scopes: string[];
  route: string;
  method: string;
  status: number;
  ok: boolean;
  ip_hash: string | null;
  user_agent: string | null;
  reason: string | null;
};

type AuditResp = {
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v.trim().length > 0) sp.set(k, v.trim());
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default function AuditPage() {
  const [keyId, setKeyId] = useState("");
  const [method, setMethod] = useState("");
  const [route, setRoute] = useState("");
  const [okFilter, setOkFilter] = useState<"" | "1" | "0">("");
  const [limit, setLimit] = useState(100);

  const url = `/audit${qs({
    key_id: keyId,
    method,
    route,
    ok: okFilter,
    limit: String(limit),
  })}`;

  const { data, error, isLoading, mutate, isValidating } = useSWR<AuditResp>(
    url,
    swrFetcher,
    { refreshInterval: 0 },
  );

  const events = data?.events ?? [];
  const stats = useMemo(() => {
    const total = events.length;
    const denied = events.filter((e) => !e.ok).length;
    const distinctKeys = new Set(events.map((e) => e.key_id)).size;
    return { total, denied, distinctKeys };
  }, [events]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} weight="duotone" className="text-[var(--amber)]" />
            <h1 className="text-lg font-semibold tracking-tight">Audit Log</h1>
          </div>
          <p className="text-[12px] muted mt-1 max-w-2xl">
            Immutable, append-only log of every authenticated API call. Records
            the key, route, method, status, hashed caller IP, and reason on
            failures. Stored in <code className="mono">.data/audit.jsonl</code>.
            Querying this page is itself audited.
          </p>
        </div>
        <button
          type="button"
          onClick={() => mutate()}
          className="btn-ghost text-[11px] uppercase tracking-wider inline-flex items-center gap-1"
          disabled={isValidating}
        >
          <ArrowsClockwise size={14} weight="duotone" /> Refresh
        </button>
      </header>

      <Card title="Filters">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <label className="text-[11px] muted uppercase tracking-wider">
            Key id
            <input
              className="input mt-1"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="any"
              maxLength={64}
            />
          </label>
          <label className="text-[11px] muted uppercase tracking-wider">
            Method
            <select
              className="input mt-1"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="">any</option>
              <option>GET</option>
              <option>POST</option>
              <option>PATCH</option>
              <option>DELETE</option>
            </select>
          </label>
          <label className="text-[11px] muted uppercase tracking-wider md:col-span-2">
            Route contains
            <input
              className="input mt-1"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              placeholder="/api/v1/"
              maxLength={200}
            />
          </label>
          <label className="text-[11px] muted uppercase tracking-wider">
            Outcome
            <select
              className="input mt-1"
              value={okFilter}
              onChange={(e) => setOkFilter(e.target.value as "" | "1" | "0")}
            >
              <option value="">any</option>
              <option value="1">success</option>
              <option value="0">denied / error</option>
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3 mt-3 text-[11px] muted">
          <Funnel size={14} weight="duotone" />
          <span>
            Showing {stats.total} event{stats.total === 1 ? "" : "s"} · {stats.denied} denied · {stats.distinctKeys} distinct key{stats.distinctKeys === 1 ? "" : "s"}
          </span>
        </div>
      </Card>

      <Card title="Events" right={
        <span className="text-[10px] muted mono">
          total {data?.total ?? 0}{data?.has_more ? " (truncated)" : ""}
        </span>
      }>
        {isLoading ? (
          <Loading label="Loading audit events" />
        ) : error ? (
          <ErrorBox err={error} />
        ) : events.length === 0 ? (
          <Empty
            title="No audit events match"
            hint="Call any /api/v1/* endpoint to record one, or clear filters."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest muted border-b border-[var(--border)]">
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Key</th>
                  <th className="py-1 pr-3">Method</th>
                  <th className="py-1 pr-3">Route</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-[var(--border)] hover:bg-[var(--bg-elev)]"
                  >
                    <td className="py-1.5 pr-3 mono text-[11px] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={12} weight="duotone" />
                        {new Date(e.ts).toLocaleString()}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1">
                        <Key size={12} weight="duotone" />
                        <span className="mono">{e.key_id === "anon" ? "anon" : e.key_label || e.key_id}</span>
                      </div>
                      {e.scopes.length > 0 && (
                        <div className="flex gap-1 mt-0.5">
                          {e.scopes.map((s) => (
                            <Badge key={s} tone="neutral">{s}</Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 mono text-[11px]">{e.method}</td>
                    <td className="py-1.5 pr-3 mono text-[11px] break-all">{e.route}</td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1 mono text-[11px]">
                        {e.ok ? (
                          <CheckCircle size={14} weight="duotone" className="text-[var(--up)]" />
                        ) : (
                          <XCircle size={14} weight="duotone" className="text-[var(--down)]" />
                        )}
                        {e.status}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 muted text-[11px]">
                      {e.reason ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

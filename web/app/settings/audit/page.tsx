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
  LinkSimple,
  Warning,
  DownloadSimple,
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

  type VerifyResp = {
    ok: boolean;
    checked: number;
    skipped_legacy: number;
    first_chained_index: number | null;
    last_hash: string | null;
    break_at_index: number | null;
    break_event_id: string | null;
    reason: string | null;
    verified_at: string;
  };
  const [verify, setVerify] = useState<VerifyResp | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  async function runVerify() {
    setVerifying(true);
    setVerifyErr(null);
    try {
      const r = await fetch("/api/audit/verify");
      if (!r.ok) throw new Error(`verify failed: ${r.status}`);
      const j = (await r.json()) as VerifyResp;
      setVerify(j);
    } catch (e: any) {
      setVerifyErr(e?.message ?? "verify failed");
    } finally {
      setVerifying(false);
    }
  }

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
        <a
          href={`/api/audit/export.csv${qs({
            key_id: keyId,
            method,
            route,
            ok: okFilter,
            limit: String(Math.max(limit, 1000)),
          })}`}
          download
          className="btn-ghost text-[11px] uppercase tracking-wider inline-flex items-center gap-1"
          aria-label="Download filtered audit log as CSV"
        >
          <DownloadSimple size={14} weight="duotone" /> Export CSV
        </a>
        <a
          href={`/api/audit/export.jsonl${qs({
            key_id: keyId,
            method,
            route,
            ok: okFilter,
            limit: String(Math.max(limit, 1000)),
          })}`}
          download
          className="btn-ghost text-[11px] uppercase tracking-wider inline-flex items-center gap-1"
          aria-label="Download filtered audit log as NDJSON for SIEM ingest"
          title="NDJSON for Splunk / Datadog / Elastic ingest. Preserves details JSON and hash chain."
        >
          <DownloadSimple size={14} weight="duotone" /> Export JSONL
        </a>
      </header>

      <Card title="Chain Integrity">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="text-[12px] muted max-w-xl">
            Each event is linked to the prior one with an HMAC-SHA256 over
            its canonical payload. If a row on disk is edited or removed,
            verification fails and points at the first broken link. Useful
            for SOC2 reviewers and forensic checks.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {verify ? (
              verify.ok ? (
                <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--green,#22c55e)]">
                  <CheckCircle size={14} weight="duotone" /> Chain intact
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--red,#ef4444)]">
                  <Warning size={14} weight="duotone" /> Chain broken
                </span>
              )
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider muted">
                <LinkSimple size={14} weight="duotone" /> Not verified
              </span>
            )}
            <button
              type="button"
              onClick={runVerify}
              disabled={verifying}
              className="btn-ghost text-[11px] uppercase tracking-wider inline-flex items-center gap-1"
            >
              <ShieldCheck size={14} weight="duotone" />
              {verifying ? "Verifying" : "Verify chain"}
            </button>
          </div>
        </div>
        {verify && (
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
            <div>
              <div className="muted text-[11px] uppercase tracking-wider">Events checked</div>
              <div className="mono">{verify.checked}</div>
            </div>
            <div>
              <div className="muted text-[11px] uppercase tracking-wider">Pre-chain (legacy)</div>
              <div className="mono">{verify.skipped_legacy}</div>
            </div>
            <div>
              <div className="muted text-[11px] uppercase tracking-wider">Last hash</div>
              <div className="mono truncate" title={verify.last_hash ?? ""}>
                {verify.last_hash ? verify.last_hash.slice(0, 16) + "\u2026" : "none"}
              </div>
            </div>
            <div>
              <div className="muted text-[11px] uppercase tracking-wider">Verified at</div>
              <div className="mono">{new Date(verify.verified_at).toLocaleTimeString()}</div>
            </div>
            {!verify.ok && (
              <div className="col-span-2 md:col-span-4 text-[12px] text-[var(--red,#ef4444)]">
                Break at index {verify.break_at_index} (event id {verify.break_event_id ?? "unknown"}): {verify.reason}
              </div>
            )}
          </div>
        )}
        {verifyErr && (
          <div className="mt-2 text-[12px] text-[var(--red,#ef4444)]">{verifyErr}</div>
        )}
      </Card>

      <AnomaliesCard />

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

type Finding = {
  kind: "auth_burst" | "key_burst" | "key_ip_fanout" | "offhours_admin";
  severity: "low" | "medium" | "high";
  summary: string;
  subject: string;
  count: number;
  first_ts: string;
  last_ts: string;
  request_ids: string[];
  extra: Record<string, unknown>;
};

type AnomalyResp = {
  window_min: number;
  scanned: number;
  generated_at: string;
  thresholds: Record<string, unknown>;
  findings: Finding[];
};

const SEV_BADGE: Record<Finding["severity"], string> = {
  high: "bg-[var(--down)]/15 text-[var(--down)]",
  medium: "bg-[var(--warn,#f59e0b)]/15 text-[var(--warn,#f59e0b)]",
  low: "bg-[var(--muted,#94a3b8)]/15 muted",
};

const KIND_LABEL: Record<Finding["kind"], string> = {
  auth_burst: "Auth burst",
  key_burst: "Key burst",
  key_ip_fanout: "Key fan-out",
  offhours_admin: "Off-hours admin",
};

function AnomaliesCard() {
  const [windowMin, setWindowMin] = useState(60);
  const url = `/audit/anomalies?window_min=${windowMin}`;
  const { data, error, isLoading, isValidating, mutate } = useSWR<AnomalyResp>(
    url,
    swrFetcher,
    { refreshInterval: 0 },
  );

  return (
    <Card
      title="Anomaly detection"
      right={
        <div className="flex items-center gap-2">
          <select
            className="input text-[11px] py-0.5"
            value={windowMin}
            onChange={(e) => setWindowMin(Number(e.target.value))}
            aria-label="Detection window"
          >
            <option value={15}>15m</option>
            <option value={60}>1h</option>
            <option value={240}>4h</option>
            <option value={1440}>24h</option>
          </select>
          <button
            type="button"
            onClick={() => mutate()}
            disabled={isValidating}
            className="btn-ghost text-[11px] uppercase tracking-wider inline-flex items-center gap-1"
          >
            <ArrowsClockwise size={14} weight="duotone" />
            {isValidating ? "Scanning" : "Rescan"}
          </button>
        </div>
      }
    >
      <p className="text-[12px] muted mb-3">
        Pattern-matches the live audit log for credential bursts, fan-out across IPs, and admin mutations
        outside business hours. Findings link to the matching request ids you can pivot into below.
      </p>
      {isLoading ? (
        <Loading label="Scanning recent audit log" />
      ) : error ? (
        <ErrorBox err={error} />
      ) : !data || data.findings.length === 0 ? (
        <Empty
          title="No anomalies in window"
          hint={`Scanned ${data?.scanned ?? 0} events in the last ${windowMin} minutes.`}
        />
      ) : (
        <ul className="space-y-2">
          {data.findings.map((f, i) => (
            <li
              key={`${f.kind}-${f.subject}-${i}`}
              className="flex flex-col gap-1 rounded border border-[var(--border,#27272a)] p-2"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 ${SEV_BADGE[f.severity]}`}
                  >
                    {f.severity}
                  </span>
                  <span className="text-[11px] uppercase tracking-wider muted">
                    {KIND_LABEL[f.kind]}
                  </span>
                  <span className="text-[12px]">{f.summary}</span>
                </div>
                <span className="text-[11px] muted mono">
                  <Clock size={12} weight="duotone" className="inline mr-1" />
                  {new Date(f.last_ts).toLocaleTimeString()}
                </span>
              </div>
              {f.request_ids.length > 0 && (
                <div className="text-[11px] muted mono truncate" title={f.request_ids.join(", ")}>
                  req: {f.request_ids.slice(0, 3).join(" ")}
                  {f.request_ids.length > 3 ? ` +${f.request_ids.length - 3}` : ""}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

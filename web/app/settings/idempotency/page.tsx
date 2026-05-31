"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
} from "@/components/ui";
import { swrFetcher } from "@/lib/api";
import {
  ArrowsClockwise,
  Key as KeyIcon,
  ArrowLeft,
  Clock,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

type StoredKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  revoked: boolean;
};
type KeysResp = { keys: StoredKey[] };

type Record = {
  header: string;
  fingerprint_prefix: string;
  status: number;
  created_at: string;
  expires_at: string;
  bytes: number;
};
type RecordsResp = { key_id: string; count: number; records: Record[] };

function relTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusTone(status: number): "up" | "warn" | "neutral" {
  if (status >= 200 && status < 300) return "up";
  if (status >= 400 && status < 500) return "warn";
  return "neutral";
}

export default function Page() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const keys = useSWR<KeysResp>("/api/admin/keys", swrFetcher);
  const liveKeys = useMemo(
    () => (keys.data?.keys ?? []).filter((k) => !k.revoked),
    [keys.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const effectiveId = selected ?? liveKeys[0]?.id ?? null;

  const records = useSWR<RecordsResp>(
    effectiveId ? `/api/admin/keys/${effectiveId}/idempotency?limit=100` : null,
    swrFetcher,
    { refreshInterval: 0 },
  );

  if (keys.isLoading) return <Loading label="Loading API keys" />;
  if (keys.error) return <ErrorBox err={keys.error} />;

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1 inline-flex items-center gap-1.5">
            <ArrowsClockwise size={12} weight="duotone" /> Idempotency
          </div>
          <h1 className="text-lg font-semibold mono">Recent retried requests</h1>
          <p className="muted text-xs mt-1 max-w-prose">
            Mutating <code className="mono">/api/v1/*</code> endpoints accept an
            <code className="mono"> Idempotency-Key</code> header. Same key with
            the same request returns the original response. Same key with a
            different request returns 409 conflict. Cache lives for 24 hours.
          </p>
        </div>
        <Link
          href="/settings"
          className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
        >
          <ArrowLeft size={14} weight="duotone" /> Settings
        </Link>
      </header>

      {liveKeys.length === 0 ? (
        <Card>
          <Empty
            title="No API keys yet"
            hint="Mint a key on the API keys page to start recording idempotency entries."
          />
          <div className="mt-3">
            <Link
              href="/settings/keys"
              className="text-[11px] inline-flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 hover:bg-white/5"
            >
              <KeyIcon size={14} weight="duotone" /> Manage API keys
            </Link>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex items-center flex-wrap gap-2">
              <div className="text-[10px] uppercase tracking-widest muted">Key</div>
              {liveKeys.map((k) => {
                const active = k.id === effectiveId;
                return (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setSelected(k.id)}
                    className={`text-[11px] mono px-2 py-1 rounded border transition-colors ${
                      active
                        ? "border-white/30 bg-white/10 text-white"
                        : "border-white/10 hover:bg-white/5 muted"
                    }`}
                    aria-pressed={active}
                  >
                    {k.prefix}… · {k.label || "unnamed"}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium">Cached responses</h2>
              {records.data ? (
                <Badge tone="neutral">
                  {records.data.count} {records.data.count === 1 ? "entry" : "entries"}
                </Badge>
              ) : null}
            </div>
            {records.isLoading ? (
              <Loading label="Loading idempotency cache" />
            ) : records.error ? (
              <ErrorBox err={records.error} />
            ) : !records.data || records.data.records.length === 0 ? (
              <Empty
                title="No retried requests yet"
                hint='Send the Idempotency-Key header on a POST or DELETE to /api/v1/* and the entry appears here.'
              />
            ) : (
              <div className="overflow-x-auto -mx-3">
                <table className="w-full text-[11px] mono">
                  <thead className="muted text-[10px] uppercase tracking-widest">
                    <tr className="border-b border-white/5">
                      <th className="text-left px-3 py-2">Key</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Bytes</th>
                      <th className="text-left px-3 py-2">Created</th>
                      <th className="text-left px-3 py-2">Expires</th>
                      <th className="text-left px-3 py-2">Fingerprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.data.records.map((r) => {
                      const tone = statusTone(r.status);
                      return (
                        <tr
                          key={`${r.header}-${r.created_at}`}
                          className="border-b border-white/5 last:border-0"
                        >
                          <td className="px-3 py-2 truncate max-w-[180px]" title={r.header}>
                            {r.header}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={tone}>
                              {tone === "up" ? (
                                <CheckCircle size={10} weight="duotone" />
                              ) : (
                                <WarningCircle size={10} weight="duotone" />
                              )}
                              {r.status}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 muted">{r.bytes}</td>
                          <td className="px-3 py-2 muted inline-flex items-center gap-1">
                            <Clock size={10} weight="duotone" /> {relTime(r.created_at)}
                          </td>
                          <td className="px-3 py-2 muted">{relTime(r.expires_at)}</td>
                          <td className="px-3 py-2 muted">{r.fingerprint_prefix}…</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

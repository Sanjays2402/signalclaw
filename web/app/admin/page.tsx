"use client";
// Admin console landing. One screen that answers an enterprise buyer's first
// three questions: who has access, is the audit log intact, what's burning
// in the last 24h. Every datapoint links to the surface that lets you change
// it (keys, audit log, SSO, seats, retention, etc.) so a security reviewer
// can pivot without hunting through the settings tree.
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
  Button,
} from "@/components/ui";
import { swrFetcher } from "@/lib/api";
import {
  ShieldCheck,
  ShieldWarning,
  Key,
  Users,
  LinkSimple,
  Clock,
  ArrowsClockwise,
  Lock,
  Globe,
  Warning,
  Gauge,
  ArrowRight,
} from "@phosphor-icons/react/dist/ssr";

type Overview = {
  generated_at: string;
  keys: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
    admin_scoped: number;
    suspended: number;
  };
  audit_chain: {
    ok: boolean;
    checked: number;
    skipped_legacy: number;
    break_at_index: number | null;
    reason: string | null;
  };
  audit_window: { total_24h: number; denied_24h: number };
  seats: { used: number; limit: number };
  sso: { enabled: boolean; enforce: boolean; allowed_domains: string[] };
  admin_mode: "local" | "production";
  recent_events: Array<{
    id: string;
    ts: string;
    key_id: string;
    key_label: string;
    route: string;
    method: string;
    status: number;
    ok: boolean;
    reason: string | null;
  }>;
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const dt = Date.now() - t;
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

function Tile({
  icon,
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "neutral" | "up" | "down";
}) {
  const toneClass =
    tone === "down"
      ? "text-red-500"
      : tone === "up"
      ? "text-emerald-500"
      : "text-zinc-100";
  const inner = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint ? <div className="text-xs text-zinc-500">{hint}</div> : null}
      {href ? (
        <div className="mt-1 text-xs text-zinc-400 flex items-center gap-1">
          Open <ArrowRight size={12} weight="duotone" />
        </div>
      ) : null}
    </div>
  );
  return (
    <Card>
      {href ? (
        <Link href={href} className="block hover:opacity-90">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </Card>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge tone={ok ? "up" : "down"}>
      {ok ? <ShieldCheck size={12} weight="duotone" /> : <ShieldWarning size={12} weight="duotone" />}
      <span className="ml-1">{label}</span>
    </Badge>
  );
}

export default function AdminConsole() {
  const { data, error, isLoading, mutate } = useSWR<Overview>(
    "/api/admin/overview?recent=25",
    swrFetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );

  return (
    <AuthGate>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <ShieldCheck size={24} weight="duotone" className="text-emerald-400" />
              Admin console
            </h1>
            <p className="text-sm text-zinc-400 mt-1">
              Workspace security posture and recent audited activity.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data ? (
              <Badge tone={data.admin_mode === "production" ? "up" : "warn"}>
                {data.admin_mode === "production" ? "Production posture" : "Local mode"}
              </Badge>
            ) : null}
            <Button onClick={() => mutate()} aria-label="Refresh">
              <ArrowsClockwise size={14} weight="duotone" />
              <span className="ml-1">Refresh</span>
            </Button>
          </div>
        </header>

        {isLoading ? <Loading label="Loading workspace posture" /> : null}
        {error ? <ErrorBox err={error} /> : null}

        {data ? (
          <>
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
              <Tile
                icon={<Key size={14} weight="duotone" />}
                label="Active API keys"
                value={data.keys.active}
                hint={`${data.keys.admin_scoped} admin, ${data.keys.revoked} revoked, ${data.keys.expired} expired`}
                href="/settings/keys"
              />
              <Tile
                icon={<Users size={14} weight="duotone" />}
                label="Seats used"
                value={`${data.seats.used}${data.seats.limit > 0 ? ` / ${data.seats.limit}` : ""}`}
                hint={data.seats.limit === 0 ? "Unlimited" : `${Math.max(0, data.seats.limit - data.seats.used)} available`}
                href="/settings/invites"
              />
              <Tile
                icon={<Lock size={14} weight="duotone" />}
                label="SSO"
                value={data.sso.enabled ? (data.sso.enforce ? "Enforced" : "Enabled") : "Off"}
                hint={data.sso.allowed_domains.length > 0 ? data.sso.allowed_domains.join(", ") : "No domain allowlist"}
                tone={data.sso.enabled ? "up" : "neutral"}
                href="/settings/sso"
              />
              <Tile
                icon={<LinkSimple size={14} weight="duotone" />}
                label="SCIM provisioning"
                value="/scim/v2"
                hint="Okta, Azure AD, Google Workspace lifecycle sync"
                href="/settings/scim"
              />
              <Tile
                icon={<Gauge size={14} weight="duotone" />}
                label="Denied 24h"
                value={data.audit_window.denied_24h}
                hint={`${data.audit_window.total_24h} total audited calls`}
                tone={data.audit_window.denied_24h > 0 ? "down" : "up"}
                href="/settings/audit"
              />
            </section>

            <section className="grid grid-cols-1 gap-3 lg:grid-cols-2 mb-6">
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-zinc-400 mb-2 flex items-center gap-2">
                      <ShieldCheck size={14} weight="duotone" /> Audit chain integrity
                    </div>
                    <StatusBadge ok={data.audit_chain.ok} label={data.audit_chain.ok ? "Intact" : "Broken"} />
                    <div className="mt-3 text-sm text-zinc-300">
                      {data.audit_chain.checked} events verified
                      {data.audit_chain.skipped_legacy > 0
                        ? `, ${data.audit_chain.skipped_legacy} legacy pre-chain`
                        : ""}
                      .
                    </div>
                    {!data.audit_chain.ok ? (
                      <div className="mt-2 text-sm text-red-400 flex items-start gap-1">
                        <Warning size={14} weight="duotone" className="mt-0.5" />
                        <span>
                          Break at index {data.audit_chain.break_at_index}: {data.audit_chain.reason}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <Link href="/settings/audit" className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                    Audit log <LinkSimple size={12} weight="duotone" />
                  </Link>
                </div>
              </Card>
              <Card>
                <div className="text-xs uppercase tracking-wide text-zinc-400 mb-2 flex items-center gap-2">
                  <Globe size={14} weight="duotone" /> Admin surfaces
                </div>
                <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {[
                    ["API keys", "/settings/keys"],
                    ["SSO", "/settings/sso"],
                    ["Sessions", "/settings/sessions"],
                    ["Admin MFA", "/settings/admin-mfa"],
                    ["Invites", "/settings/invites"],
                    ["Webhooks", "/webhooks"],
                    ["CORS", "/settings/cors"],
                    ["CSP", "/settings/security/csp"],
                    ["Network policy", "/settings/network"],
                    ["Retention", "/settings/retention"],
                    ["Legal hold", "/settings/legal-hold"],
                    ["SIEM", "/settings/siem"],
                    ["Privacy", "/settings/privacy"],
                    ["Freeze", "/settings/freeze"],
                  ].map(([label, href]) => (
                    <li key={href}>
                      <Link href={href} className="text-zinc-300 hover:text-zinc-100 flex items-center gap-1">
                        <ArrowRight size={10} weight="duotone" className="text-zinc-500" />
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>

            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm uppercase tracking-wide text-zinc-400 flex items-center gap-2">
                  <Clock size={14} weight="duotone" /> Recent audited activity
                </h2>
                <Link href="/settings/audit" className="text-xs text-zinc-400 hover:text-zinc-200">
                  Full log
                </Link>
              </div>
              <Card>
                {data.recent_events.length === 0 ? (
                  <Empty title="No audited activity yet" hint="Calls through /api/v1/* and /api/admin/* will appear here." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase tracking-wide text-zinc-500">
                        <tr className="text-left">
                          <th className="py-2 pr-3 font-medium">When</th>
                          <th className="py-2 pr-3 font-medium">Key</th>
                          <th className="py-2 pr-3 font-medium">Route</th>
                          <th className="py-2 pr-3 font-medium">Status</th>
                          <th className="py-2 pr-3 font-medium">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/80">
                        {data.recent_events.map((e) => (
                          <tr key={e.id} className="align-top">
                            <td className="py-2 pr-3 text-zinc-400 whitespace-nowrap">{relTime(e.ts)}</td>
                            <td className="py-2 pr-3 text-zinc-300">
                              {e.key_label || e.key_id}
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs text-zinc-200">
                              <span className="text-zinc-500">{e.method}</span> {e.route}
                            </td>
                            <td className="py-2 pr-3">
                              <Badge tone={e.ok ? "up" : "down"}>{e.status}</Badge>
                            </td>
                            <td className="py-2 pr-3 text-zinc-400">{e.reason || ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>
          </>
        ) : null}
      </main>
    </AuthGate>
  );
}

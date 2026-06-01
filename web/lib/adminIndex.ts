// Framework-free admin control index.
//
// Procurement reality: an enterprise security reviewer wants ONE screen
// that enumerates every control, says whether it is on/off/configured,
// and links to the surface that lets them change it. The admin landing
// page only highlights the top-5 daily-driver controls (keys, invites,
// SSO, SCIM, audit). A buyer's auditor needs the full inventory in one
// place so they can tick boxes without spelunking through the sidebar.
//
// This module is the aggregator behind /api/admin/index and the
// /admin/index UI page. It calls the existing policy getters and
// returns a normalized list of {key, label, href, category, status,
// summary} rows. No NextRequest here so it stays unit-testable.

import { getResidencyPolicy } from "./residencyStore.ts";
import { getPolicy as getCorsPolicy } from "./corsPolicy.ts";
import { getPolicy as getNetworkPolicy } from "./networkPolicyStore.ts";
import { getPolicy as getRetentionPolicy } from "./retentionStore.ts";
import { getFreezeState } from "./freezeStore.ts";
import { getSsoPolicy } from "./ssoPolicyStore.ts";
import { getPolicy as getEgressPolicy } from "./egressPolicy.ts";
import { getRotationPolicy } from "./rotationPolicy.ts";
import { getCspPolicy } from "./cspPolicyStore.ts";
import { getSettings } from "./settingsStore.ts";
import { getSink as getSiemSink } from "./siemSinkStore.ts";
import { getConfig as getLockoutConfig } from "./authLockoutStore.ts";
import { getConcurrencyPolicy, getInFlight } from "./concurrencyStore.ts";
import { listHolds } from "./legalHoldStore.ts";
import { getState as getDpaState } from "./dpaStore.ts";
import { getState as getSlaState } from "./slaStore.ts";
import { listSessions } from "./ssoSessionRegistry.ts";
import { getPolicy as getSessionTimeoutPolicy } from "./sessionTimeoutPolicy.ts";

export type ControlStatus = "enforcing" | "monitoring" | "configured" | "off" | "warning";

export type ControlCategory =
  | "identity"
  | "data"
  | "network"
  | "operations"
  | "observability";

export type ControlRow = {
  key: string;
  label: string;
  href: string;
  category: ControlCategory;
  status: ControlStatus;
  summary: string;
};

export type AdminIndex = {
  generated_at: string;
  admin_mode: "local" | "production";
  controls: ControlRow[];
  counts: Record<ControlStatus, number>;
};

function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  return fn().catch(() => null);
}

export async function buildAdminIndex(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminIndex> {
  const [
    residency,
    network,
    retention,
    freeze,
    sso,
    egress,
    rotation,
    csp,
    settings,
    siem,
    lockout,
    concurrency,
    holds,
    dpa,
    sla,
    sessions,
    sessionTimeout,
  ] = await Promise.all([
    safe(() => getResidencyPolicy()),
    safe(() => getNetworkPolicy()),
    safe(() => getRetentionPolicy()),
    safe(() => getFreezeState()),
    safe(() => getSsoPolicy()),
    safe(() => getEgressPolicy()),
    safe(() => getRotationPolicy()),
    safe(() => getCspPolicy()),
    safe(() => getSettings()),
    safe(() => getSiemSink()),
    safe(() => getLockoutConfig()),
    safe(() => getConcurrencyPolicy()),
    safe(() => listHolds()),
    safe(() => getDpaState()),
    safe(() => getSlaState()),
    safe(() => listSessions({ limit: 1 })),
    safe(() => getSessionTimeoutPolicy()),
  ]);

  const cors = (() => {
    try {
      return getCorsPolicy(env);
    } catch {
      return null;
    }
  })();
  const inFlight = (() => {
    try {
      return getInFlight();
    } catch {
      return 0;
    }
  })();

  const controls: ControlRow[] = [];

  // Identity
  controls.push({
    key: "sso",
    label: "Single sign-on",
    href: "/settings/sso",
    category: "identity",
    status: sso?.enabled ? (sso.enforce ? "enforcing" : "configured") : "off",
    summary: sso?.enabled
      ? sso.enforce
        ? `Required for ${sso.allowed_domains.length || "all"} domain${(sso.allowed_domains.length || 0) === 1 ? "" : "s"}`
        : `Optional, ${sso.allowed_domains.length} domain${sso.allowed_domains.length === 1 ? "" : "s"} on file`
      : "Not configured",
  });
  controls.push({
    key: "scim",
    label: "SCIM provisioning",
    href: "/settings/scim",
    category: "identity",
    status: env.SIGNALCLAW_SCIM_TOKEN ? "configured" : "off",
    summary: env.SIGNALCLAW_SCIM_TOKEN
      ? "Bearer token set, /scim/v2 live"
      : "No SCIM token, manual invites only",
  });
  controls.push({
    key: "invites",
    label: "Seat invites",
    href: "/settings/invites",
    category: "identity",
    status: "configured",
    summary: "Invite by email with role assignment",
  });
  controls.push({
    key: "admin-mfa",
    label: "Admin MFA",
    href: "/settings/admin-mfa",
    category: "identity",
    status: env.SIGNALCLAW_ADMIN_MFA_REQUIRED === "1" ? "enforcing" : "configured",
    summary:
      env.SIGNALCLAW_ADMIN_MFA_REQUIRED === "1"
        ? "TOTP required on every admin mutation"
        : "TOTP available, not required",
  });
  controls.push({
    key: "auth-lockout",
    label: "Auth lockout",
    href: "/settings/auth-lockout",
    category: "identity",
    status: lockout?.enabled ? "enforcing" : "off",
    summary: lockout
      ? lockout.enabled
        ? `${lockout.threshold} failures over ${lockout.window_seconds}s, ${lockout.cooldown_seconds}s cooldown`
        : "Disabled, default open"
      : "Default policy",
  });
  controls.push({
    key: "sessions",
    label: "SSO sessions",
    href: "/settings/sessions",
    category: "identity",
    status: (sessions?.active_count ?? 0) > 0 ? "configured" : "off",
    summary: sessions
      ? `${sessions.active_count} active, force-logout available`
      : "Ledger empty",
  });
  controls.push({
    key: "session-timeout",
    label: "Session idle + absolute timeout",
    href: "/settings/sessions",
    category: "identity",
    status: sessionTimeout?.enforce ? "enforcing" : "off",
    summary: sessionTimeout
      ? sessionTimeout.enforce
        ? `Idle ${Math.round(sessionTimeout.idle_timeout_s / 60)}m, absolute ${Math.round(sessionTimeout.absolute_timeout_s / 3600)}h`
        : `Configured (idle ${Math.round(sessionTimeout.idle_timeout_s / 60)}m, absolute ${Math.round(sessionTimeout.absolute_timeout_s / 3600)}h) but not enforcing`
      : "Default policy",
  });
  controls.push({
    key: "keys",
    label: "API keys",
    href: "/settings/keys",
    category: "identity",
    status: "configured",
    summary: "Scopes, rotation, suspension, per-key IP allowlist",
  });

  // Data
  controls.push({
    key: "residency",
    label: "Data residency",
    href: "/settings/security/residency",
    category: "data",
    status: residency
      ? residency.mode === "enforce"
        ? "enforcing"
        : residency.mode === "monitor"
          ? "monitoring"
          : "off"
      : "off",
    summary: residency
      ? `Region ${residency.region.toUpperCase()}, mode ${residency.mode}`
      : "Unknown",
  });
  controls.push({
    key: "retention",
    label: "Retention policy",
    href: "/settings/retention",
    category: "data",
    status: retention && retention.audit_days > 0 ? "enforcing" : "off",
    summary: retention
      ? `Audit ${retention.audit_days}d, runs ${retention.runs_days}d, webhooks ${retention.webhook_deliveries_days}d`
      : "No TTL set",
  });
  controls.push({
    key: "legal-hold",
    label: "Legal hold",
    href: "/settings/legal-hold",
    category: "data",
    status: (holds?.length ?? 0) > 0 ? "enforcing" : "off",
    summary: holds && holds.length > 0
      ? `${holds.length} active hold${holds.length === 1 ? "" : "s"} block deletion`
      : "No holds in effect",
  });
  controls.push({
    key: "dpa",
    label: "Data Processing Agreement",
    href: "/settings/dpa",
    category: "data",
    status: dpa && dpa.active && !dpa.needs_re_acceptance ? "enforcing" : "off",
    summary: dpa && dpa.active
      ? (dpa.needs_re_acceptance
          ? `v${dpa.active.dpa_version} accepted (re-accept v${dpa.current.version})`
          : `v${dpa.current.version} accepted by ${dpa.active.signatory_name}`)
      : `v${dpa?.current?.version ?? "current"} not accepted yet`,
  });
  controls.push({
    key: "sla",
    label: "Service Level Agreement",
    href: "/settings/sla",
    category: "data",
    status: sla && sla.current ? "enforcing" : "off",
    summary: sla && sla.current
      ? `v${sla.current.version}, ${(sla.current.uptime_target_bps / 100).toFixed(2)}% monthly uptime`
      : "No SLA published yet",
  });
  controls.push({
    key: "privacy",
    label: "Export and erase",
    href: "/settings/privacy",
    category: "data",
    status: "configured",
    summary: "GDPR/CCPA workspace export plus hard-delete",
  });
  controls.push({
    key: "audit",
    label: "Audit log",
    href: "/settings/audit",
    category: "data",
    status: "enforcing",
    summary: "Tamper-evident HMAC chain on every mutation",
  });

  // Network
  controls.push({
    key: "network",
    label: "API IP allowlist",
    href: "/settings/network",
    category: "network",
    status: network && network.cidrs.length > 0 ? "enforcing" : "off",
    summary: network
      ? network.cidrs.length > 0
        ? `${network.cidrs.length} CIDR${network.cidrs.length === 1 ? "" : "s"} permitted`
        : "Open to all source IPs"
      : "Unknown",
  });
  controls.push({
    key: "cors",
    label: "CORS posture",
    href: "/settings/cors",
    category: "network",
    status: cors
      ? cors.production
        ? cors.origins.length > 0
          ? "enforcing"
          : "warning"
        : "configured"
      : "off",
    summary: cors
      ? cors.production
        ? cors.origins.length > 0
          ? `${cors.origins.length} origin${cors.origins.length === 1 ? "" : "s"} permitted`
          : "Production with no origin allowlist, server-to-server only"
        : "Local dev, loopback default"
      : "Unknown",
  });
  controls.push({
    key: "csp",
    label: "Content security policy",
    href: "/settings/csp",
    category: "network",
    status: csp && csp.mode !== "off" ? (csp.mode === "enforce" ? "enforcing" : "monitoring") : "off",
    summary: csp ? `Mode ${csp.mode}` : "Off",
  });
  controls.push({
    key: "egress",
    label: "Webhook egress",
    href: "/settings/webhooks",
    category: "network",
    status: egress
      ? egress.allow_private
        ? "warning"
        : egress.cidrs.length > 0
          ? "enforcing"
          : "configured"
      : "off",
    summary: egress
      ? egress.allow_private
        ? "Private ranges allowed, dev only"
        : egress.cidrs.length > 0
          ? `Default-deny private + ${egress.cidrs.length} CIDR allowlist`
          : "Default-deny private, no CIDR allowlist"
      : "Unknown",
  });
  controls.push({
    key: "key-ip",
    label: "Per-key IP policy",
    href: "/settings/keys",
    category: "network",
    status: "configured",
    summary: "Owner-scoped CIDR allowlist per API key",
  });

  // Operations
  controls.push({
    key: "freeze",
    label: "Workspace freeze",
    href: "/settings/freeze",
    category: "operations",
    status: freeze?.frozen ? "enforcing" : "off",
    summary: freeze?.frozen
      ? `Frozen ${freeze.frozen_at} by ${freeze.frozen_by ?? "unknown"}`
      : "Not frozen",
  });
  controls.push({
    key: "rotation",
    label: "Key rotation policy",
    href: "/settings/security/rotation",
    category: "operations",
    status: rotation && rotation.max_age_days > 0 ? "enforcing" : "off",
    summary: rotation
      ? `Rotate every ${rotation.max_age_days}d, ${rotation.warn_days}d warning`
      : "No rotation deadline",
  });
  controls.push({
    key: "concurrency",
    label: "Concurrency cap",
    href: "/settings/concurrency",
    category: "operations",
    status: concurrency?.limit != null ? "enforcing" : "off",
    summary: concurrency?.limit != null
      ? `Limit ${concurrency.limit}, ${inFlight} in flight`
      : `Unlimited, ${inFlight} in flight`,
  });
  controls.push({
    key: "idempotency",
    label: "Idempotency",
    href: "/settings/idempotency",
    category: "operations",
    status: "enforcing",
    summary: "Mutating v1 routes accept Idempotency-Key",
  });
  controls.push({
    key: "settings",
    label: "Workspace defaults",
    href: "/settings",
    category: "operations",
    status: settings ? "configured" : "off",
    summary: settings ? "Defaults applied" : "Defaults pending",
  });

  // Observability
  controls.push({
    key: "observability",
    label: "Health and metrics",
    href: "/settings/observability",
    category: "observability",
    status: "enforcing",
    summary: "/healthz, /readyz, /metrics live",
  });
  controls.push({
    key: "siem",
    label: "SIEM sink",
    href: "/settings/siem",
    category: "observability",
    status: siem && siem.url ? "enforcing" : "off",
    summary: siem && siem.url
      ? `Forwarding ${new URL(siem.url).host}`
      : "No external log sink configured",
  });
  controls.push({
    key: "alerts-tenants",
    label: "Tenant isolation tests",
    href: "/settings/alerts-tenants",
    category: "observability",
    status: "enforcing",
    summary: "Per-tenant row scoping verified by store-level tests",
  });

  controls.push({
    key: "evidence-pack",
    label: "SOC2 evidence pack",
    href: "/settings/evidence-pack",
    category: "observability",
    status: "enforcing",
    summary: "On-demand signed bundle of every policy + audit chain proof",
  });

  const counts: Record<ControlStatus, number> = {
    enforcing: 0,
    monitoring: 0,
    configured: 0,
    off: 0,
    warning: 0,
  };
  for (const c of controls) counts[c.status] += 1;

  return {
    generated_at: new Date().toISOString(),
    admin_mode: env.SIGNALCLAW_ADMIN_KEY ? "production" : "local",
    controls,
    counts,
  };
}

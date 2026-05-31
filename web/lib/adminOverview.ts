// Framework-free admin overview aggregator. Used by /api/admin/overview
// and the /admin console page. Kept free of NextRequest so it can be
// unit-tested directly against the file-backed stores.
//
// Returns a snapshot of the workspace security posture: how many API
// keys exist (active vs revoked), audit chain health (tamper-evident
// HMAC chain status), seat usage, SSO posture, and the last N audit
// events so an admin can spot a 4xx storm without leaving the page.
import { listKeys, publicView, isExpired, type StoredKey } from "./keyStore.ts";
import { verifyChain, queryAudit, type AuditEvent } from "./auditStore.ts";
import { getSeatUsage } from "./seats.ts";
import { getSsoPolicy } from "./ssoPolicyStore.ts";

export type KeyPosture = {
  total: number;
  active: number;
  revoked: number;
  expired: number;
  admin_scoped: number;
  suspended: number;
};

export type ChainPosture = {
  ok: boolean;
  checked: number;
  skipped_legacy: number;
  break_at_index: number | null;
  reason: string | null;
};

export type AdminOverview = {
  generated_at: string;
  keys: KeyPosture;
  audit_chain: ChainPosture;
  audit_window: {
    total_24h: number;
    denied_24h: number;
  };
  seats: { used: number; limit: number };
  sso: {
    enabled: boolean;
    enforce: boolean;
    allowed_domains: string[];
  };
  admin_mode: "local" | "production";
  recent_events: AuditEvent[];
};

function summarizeKeys(keys: StoredKey[]): KeyPosture {
  const now = new Date();
  let active = 0;
  let revoked = 0;
  let expired = 0;
  let admin_scoped = 0;
  let suspended = 0;
  for (const k of keys) {
    const pub = publicView(k) as any;
    if (pub.revoked) revoked++;
    else if (isExpired(k, now)) expired++;
    else active++;
    if (pub.suspended) suspended++;
    if ((k.scopes || []).includes("admin")) admin_scoped++;
  }
  return { total: keys.length, active, revoked, expired, admin_scoped, suspended };
}

export async function buildAdminOverview(opts: { recent?: number } = {}): Promise<AdminOverview> {
  const recent = Math.min(Math.max(opts.recent ?? 25, 1), 200);
  const [keys, chain, seats, sso] = await Promise.all([
    listKeys(),
    verifyChain(),
    getSeatUsage(),
    getSsoPolicy(),
  ]);
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [recentQ, deniedQ] = await Promise.all([
    queryAudit({ limit: recent }),
    queryAudit({ ok: false, since: sinceIso, limit: 1000 }),
  ]);
  const window24 = await queryAudit({ since: sinceIso, limit: 1000 });
  return {
    generated_at: new Date().toISOString(),
    keys: summarizeKeys(keys),
    audit_chain: {
      ok: chain.ok,
      checked: chain.checked,
      skipped_legacy: chain.skipped_legacy,
      break_at_index: chain.break_at_index,
      reason: chain.reason,
    },
    audit_window: {
      total_24h: window24.total,
      denied_24h: deniedQ.total,
    },
    seats: { used: seats.used, limit: seats.limit },
    sso: {
      enabled: !!sso.enabled,
      enforce: !!sso.enforce,
      allowed_domains: Array.isArray(sso.allowed_domains) ? sso.allowed_domains : [],
    },
    admin_mode: process.env.SIGNALCLAW_ADMIN_KEY ? "production" : "local",
    recent_events: recentQ.events,
  };
}

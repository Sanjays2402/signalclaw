"use client";
import { useState } from "react";
import useSWR from "swr";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Key,
  Plus,
  Copy,
  Check,
  Trash,
  WarningCircle,
  Eye,
  EyeSlash,
  Terminal,
  ArrowsClockwise,
  Gauge,
  ChartLineUp,
  Hourglass,
  Clock,
} from "@phosphor-icons/react/dist/ssr";

type StoredKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  effective_scopes?: string[];
  role?: string;
  created_at: string;
  last_used_at: string | null;
  last_used_ip?: string | null;
  last_used_user_agent?: string | null;
  revoked: boolean;
  ip_allowlist?: string[];
  route_allowlist?: string[];
  expires_at?: string | null;
  expired?: boolean;
  suspended?: boolean;
  suspended_at?: string | null;
  suspended_reason?: string | null;
};

type KeyList = { keys: StoredKey[] };

type Created = StoredKey & { secret: string };

export default function ApiKeysPage() {
  const { data, error, isLoading, mutate } = useSWR<KeyList>(
    "/admin/keys",
    swrFetcher,
    { refreshInterval: 0 },
  );

  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  // RBAC role. Defaults to ``member`` so the key gets read + trade but
  // never lands with admin unless an operator explicitly picks owner
  // or admin (those carry the admin scope automatically).
  const [role, setRole] = useState<"owner" | "admin" | "member" | "viewer">("member");
  const [changingRole, setChangingRole] = useState<string | null>(null);
  // Hard expiry on a new key. "0" means never expires. SOC2 hygiene
  // strongly prefers credentials with a bounded lifetime; the default
  // here is a 90-day key so the secure path is the easy path.
  const [expirySeconds, setExpirySeconds] = useState<number>(90 * 24 * 3600);
  const [created, setCreated] = useState<Created | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [suspending, setSuspending] = useState<string | null>(null);
  const [editingAllowlist, setEditingAllowlist] = useState<string | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [allowlistErr, setAllowlistErr] = useState<string | null>(null);
  const [savingAllowlist, setSavingAllowlist] = useState(false);
  const [editingRoutes, setEditingRoutes] = useState<string | null>(null);
  const [routesDraft, setRoutesDraft] = useState("");
  const [routesErr, setRoutesErr] = useState<string | null>(null);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState("");
  const [rateErr, setRateErr] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [rateInfo, setRateInfo] = useState<Record<string, { limit_per_minute: number; default_per_minute: number; window_seconds: number; is_override: boolean }>>({});
  const [editingQuota, setEditingQuota] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState("");
  const [quotaErr, setQuotaErr] = useState<string | null>(null);
  const [savingQuota, setSavingQuota] = useState(false);
  type QuotaInfo = {
    key_id: string;
    monthly_quota: number;
    default_monthly_quota: number;
    is_override: boolean;
    unlimited: boolean;
    period: string;
    used: number;
    remaining: number | null;
    resets_at: string;
  };
  const [quotaInfo, setQuotaInfo] = useState<Record<string, QuotaInfo>>({});

  async function openQuotaEditor(id: string) {
    setQuotaErr(null);
    setEditingQuota(id);
    try {
      const info = await api<QuotaInfo>(`/admin/keys/${id}/monthly-quota`);
      setQuotaInfo((m) => ({ ...m, [id]: info }));
      setQuotaDraft(String(info.monthly_quota));
    } catch (err) {
      setQuotaErr(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveQuota(id: string) {
    setQuotaErr(null);
    setSavingQuota(true);
    try {
      const n = Number.parseInt(quotaDraft, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error("Enter 0 (unlimited) or a positive integer");
      const info = await api<QuotaInfo>(`/admin/keys/${id}/monthly-quota`, {
        method: "PUT",
        body: JSON.stringify({ quota: n }),
      });
      setQuotaInfo((m) => ({ ...m, [id]: info }));
      setEditingQuota(null);
    } catch (err) {
      setQuotaErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingQuota(false);
    }
  }

  async function onResetQuota(id: string) {
    setQuotaErr(null);
    setSavingQuota(true);
    try {
      const info = await api<QuotaInfo>(`/admin/keys/${id}/monthly-quota`, {
        method: "PUT",
        body: JSON.stringify({ quota: null }),
      });
      setQuotaInfo((m) => ({ ...m, [id]: info }));
      setQuotaDraft(String(info.monthly_quota));
    } catch (err) {
      setQuotaErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingQuota(false);
    }
  }

  async function openRateEditor(id: string) {
    setRateErr(null);
    setEditingRate(id);
    try {
      const info = await api<{ key_id: string; limit_per_minute: number; default_per_minute: number; window_seconds: number; is_override: boolean }>(
        `/admin/keys/${id}/rate-limit`,
      );
      setRateInfo((m) => ({ ...m, [id]: info }));
      setRateDraft(String(info.limit_per_minute));
    } catch (err) {
      setRateErr(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveRate(id: string) {
    setRateErr(null);
    setSavingRate(true);
    try {
      const n = Number.parseInt(rateDraft, 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("Enter a positive integer");
      const info = await api<{ key_id: string; limit_per_minute: number; default_per_minute: number; window_seconds: number; is_override: boolean }>(
        `/admin/keys/${id}/rate-limit`,
        { method: "PUT", body: JSON.stringify({ limit: n }) },
      );
      setRateInfo((m) => ({ ...m, [id]: info }));
      setEditingRate(null);
    } catch (err) {
      setRateErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRate(false);
    }
  }

  async function onResetRate(id: string) {
    setRateErr(null);
    setSavingRate(true);
    try {
      const info = await api<{ key_id: string; limit_per_minute: number; default_per_minute: number; window_seconds: number; is_override: boolean }>(
        `/admin/keys/${id}/rate-limit`,
        { method: "PUT", body: JSON.stringify({ limit: null }) },
      );
      setRateInfo((m) => ({ ...m, [id]: info }));
      setRateDraft(String(info.limit_per_minute));
    } catch (err) {
      setRateErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRate(false);
    }
  }

  async function onSaveAllowlist(id: string) {
    setAllowlistErr(null);
    setSavingAllowlist(true);
    try {
      const cidrs = allowlistDraft
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api(`/admin/keys/${id}/ip-allowlist`, {
        method: "PUT",
        body: JSON.stringify({ ip_allowlist: cidrs }),
      });
      setEditingAllowlist(null);
      setAllowlistDraft("");
      mutate();
    } catch (err) {
      setAllowlistErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAllowlist(false);
    }
  }

  async function onSaveRoutes(id: string) {
    setRoutesErr(null);
    setSavingRoutes(true);
    try {
      const routes = routesDraft
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api(`/admin/keys/${id}/route-allowlist`, {
        method: "PUT",
        body: JSON.stringify({ route_allowlist: routes }),
      });
      setEditingRoutes(null);
      setRoutesDraft("");
      mutate();
    } catch (err) {
      setRoutesErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRoutes(false);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    setBusy(true);
    try {
      const out = await api<Created>("/admin/keys", {
        method: "POST",
        body: JSON.stringify({
          label: label.trim(),
          scopes,
          role,
          expires_in_seconds: expirySeconds > 0 ? expirySeconds : null,
        }),
      });
      setCreated(out);
      setLabel("");
      setScopes(["read"]);
      setRole("member");
      setCreating(false);
      mutate();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setCreateErr(
          "Your current API key lacks the admin scope. Use an admin key to manage keys.",
        );
      } else {
        setCreateErr(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onChangeRole(id: string, currentRole: string, displayLabel: string) {
    const choices = ["owner", "admin", "member", "viewer"] as const;
    const ans = window.prompt(
      `Change role for "${displayLabel}".\n\nCurrent role: ${currentRole}\n\nEnter one of: ${choices.join(", ")}.\n\nowner / admin   read + trade + admin (manage keys, audit, members)\nmember          read + trade (cannot manage keys or admin)\nviewer          read only (cannot mutate anything)`,
      currentRole,
    );
    if (ans === null) return;
    const next = ans.trim().toLowerCase();
    if (!choices.includes(next as typeof choices[number])) {
      window.alert(`Role must be one of: ${choices.join(", ")}`);
      return;
    }
    if (next === currentRole) return;
    setChangingRole(id);
    try {
      await api(`/admin/keys/${id}/role`, {
        method: "PUT",
        body: JSON.stringify({ role: next }),
      });
      mutate();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingRole(null);
    }
  }

  async function onRevoke(id: string, displayLabel: string) {
    if (!window.confirm(`Revoke "${displayLabel}"? This cannot be undone.`)) return;
    setRevoking(id);
    try {
      await api(`/admin/keys/${id}`, { method: "DELETE" });
      mutate();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(null);
    }
  }

  async function onToggleSuspend(
    id: string,
    displayLabel: string,
    currentlySuspended: boolean,
  ) {
    let reason: string | null = null;
    if (!currentlySuspended) {
      const ans = window.prompt(
        `Suspend "${displayLabel}"?\n\nThis blocks all authentication until you lift the hold.\nOptional reason for the audit trail (200 chars max):`,
        "",
      );
      if (ans === null) return;
      reason = ans.trim() || null;
    } else {
      if (
        !window.confirm(`Lift suspension on "${displayLabel}"? The key can authenticate again immediately.`)
      )
        return;
    }
    setSuspending(id);
    try {
      await api(`/admin/keys/${id}/suspend`, {
        method: "PUT",
        body: JSON.stringify({ suspended: !currentlySuspended, reason }),
        headers: { "Content-Type": "application/json" },
      });
      mutate();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSuspending(null);
    }
  }

  async function onRotate(id: string, displayLabel: string) {
    const ans = window.prompt(
      `Rotate "${displayLabel}"?\n\nEnter grace seconds to keep the old secret valid during cutover (0..604800).\nLeave empty or 0 for immediate rotation.`,
      "0",
    );
    if (ans === null) return;
    const grace = Math.max(0, Math.min(7 * 24 * 3600, parseInt(ans || "0", 10) || 0));
    setRotating(id);
    try {
      const out = await api<Created>(`/admin/keys/${id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ grace_seconds: grace }),
      });
      setCreated(out);
      mutate();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(null);
    }
  }

  const visibleKeys = (data?.keys ?? []).filter((k) => !k.revoked);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Key size={20} weight="duotone" className="text-[var(--amber)]" />
            <h1 className="text-lg font-semibold tracking-tight">API Keys</h1>
          </div>
          <p className="text-[12px] muted mt-1 max-w-xl">
            Mint scoped keys for the SignalClaw HTTP API. Keys are shown once at
            creation. Store them in a secret manager and rotate when compromised.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setCreated(null);
              setCreateErr(null);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium border border-[var(--border-strong)] bg-white/[0.03] hover:bg-white/[0.08] rounded-sm"
          >
            <Plus size={14} weight="bold" />
            New key
          </button>
        )}
      </header>

      <ExpiryWatch />

      {created && <RevealedSecret created={created} onDismiss={() => setCreated(null)} />}

      {creating && (
        <Card title="Create key">
          <form onSubmit={onCreate} className="space-y-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest muted mb-1">
                Label
              </label>
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My laptop, prod webhook, etc."
                maxLength={80}
                className="w-full bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[13px] focus:outline-none focus:border-[var(--amber)]"
              />
            </div>
            <fieldset>
              <legend className="block text-[10px] uppercase tracking-widest muted mb-1">
                Role
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {([
                  { id: "viewer", title: "Viewer", desc: "Read only. Cannot mutate." },
                  { id: "member", title: "Member", desc: "Read and trade. No admin." },
                  { id: "admin", title: "Admin", desc: "Manage keys, MFA, audit." },
                  { id: "owner", title: "Owner", desc: "Workspace owner. Same as admin." },
                ] as const).map((opt) => (
                  <label
                    key={opt.id}
                    className={`flex items-start gap-2 px-2 py-1.5 border rounded-sm cursor-pointer text-[12px] ${
                      role === opt.id
                        ? "border-[var(--amber)] bg-white/[0.04]"
                        : "border-[var(--border)] hover:bg-white/[0.03]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      className="mt-0.5"
                      checked={role === opt.id}
                      onChange={() => setRole(opt.id)}
                    />
                    <span>
                      <span className="font-medium">{opt.title}</span>
                      <span className="block text-[11px] muted">{opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] muted mt-2">
                Role caps what the key can do. Selected scopes are intersected
                with the role allow list. Admin and owner pick up the admin
                scope automatically.
              </p>
            </fieldset>
            <fieldset>
              <legend className="block text-[10px] uppercase tracking-widest muted mb-1">
                Scopes
              </legend>
              <div className="flex gap-2 flex-wrap">
                <ScopeToggle
                  scope="read"
                  checked={scopes.includes("read")}
                  onChange={(c) => toggle(setScopes, scopes, "read", c)}
                  desc="Fetch picks, portfolio, regime, backtests"
                />
                <ScopeToggle
                  scope="trade"
                  checked={scopes.includes("trade")}
                  onChange={(c) => toggle(setScopes, scopes, "trade", c)}
                  desc="Add or modify watchlist, alerts, trades"
                />
              </div>
              <p className="text-[11px] muted mt-2">
                The admin scope is granted by the Admin or Owner role above,
                not from this list. Member and Viewer roles never receive it.
              </p>
            </fieldset>
            <div>
              <label className="block text-[10px] uppercase tracking-widest muted mb-1">
                Expires
              </label>
              <select
                value={String(expirySeconds)}
                onChange={(e) => setExpirySeconds(Number(e.target.value))}
                className="w-full bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[13px] focus:outline-none focus:border-[var(--amber)]"
              >
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
                <option value="7776000">90 days (recommended)</option>
                <option value="15552000">180 days</option>
                <option value="31536000">1 year (max)</option>
                <option value="0">Never (not recommended)</option>
              </select>
              <p className="text-[11px] muted mt-1">
                Expired keys are rejected at the gateway. Rotate before the
                deadline to avoid downtime.
              </p>
            </div>
            {createErr && (
              <div className="flex items-start gap-2 p-2 border border-red-500/40 bg-red-500/10 rounded-sm text-[12px]">
                <WarningCircle size={16} weight="duotone" className="text-red-400 shrink-0 mt-0.5" />
                <span>{createErr}</span>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setCreateErr(null);
                }}
                className="px-3 py-1.5 text-[12px] muted hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || scopes.length === 0}
                className="px-3 py-1.5 text-[12px] font-medium bg-[var(--amber)] text-black rounded-sm disabled:opacity-50"
              >
                {busy ? "Creating..." : "Create key"}
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card
        title={`Active keys (${visibleKeys.length})`}
        right={<span className="text-[10px] muted mono">SHA-256 hashed at rest</span>}
      >
        {error && <ErrorBox err={error} />}
        {!error && isLoading && <Loading label="Loading keys" />}
        {!error && !isLoading && visibleKeys.length === 0 && (
          <Empty
            title="No active keys"
            hint="Click New key above to mint your first one."
          />
        )}
        {!error && !isLoading && visibleKeys.length > 0 && (
          <ul className="divide-y divide-[var(--border)]">
            {visibleKeys.map((k) => (
              <li key={k.id} className="py-2.5 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium truncate">{k.label || "unnamed"}</span>
                    {k.role && (
                      <Badge tone={k.role === "owner" || k.role === "admin" ? "warn" : "neutral"}>
                        {k.role}
                      </Badge>
                    )}
                    {(k.effective_scopes ?? k.scopes).map((s) => (
                      <Badge key={s} tone={s === "admin" ? "warn" : s === "trade" ? "warn" : "neutral"}>
                        {s}
                      </Badge>
                    ))}
                    {k.ip_allowlist && k.ip_allowlist.length > 0 && (
                      <Badge tone="neutral">
                        IP allowlist · {k.ip_allowlist.length}
                      </Badge>
                    )}
                    {k.route_allowlist && k.route_allowlist.length > 0 && (
                      <Badge tone="neutral">
                        Route allowlist · {k.route_allowlist.length}
                      </Badge>
                    )}
                    {k.suspended && (
                      <Badge tone="warn">
                        suspended{k.suspended_reason ? ` · ${k.suspended_reason}` : ""}
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] muted mono mt-0.5">
                    {k.prefix}… · created {fmtDate(k.created_at)}
                    {k.last_used_at ? ` · last used ${fmtDate(k.last_used_at)}` : " · never used"}
                    {k.expires_at ? ` · expires ${fmtDate(k.expires_at)}` : " · no expiry"}
                  </div>
                  {(k.last_used_ip || k.last_used_user_agent) && (
                    <div
                      className="text-[11px] muted mono mt-0.5 truncate"
                      title={k.last_used_user_agent || undefined}
                    >
                      {k.last_used_ip ? `from ${k.last_used_ip}` : ""}
                      {k.last_used_ip && k.last_used_user_agent ? " · " : ""}
                      {k.last_used_user_agent
                        ? k.last_used_user_agent.length > 80
                          ? k.last_used_user_agent.slice(0, 80) + "…"
                          : k.last_used_user_agent
                        : ""}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onChangeRole(k.id, k.role || "member", k.label || k.prefix)}
                    disabled={changingRole === k.id || revoking === k.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm disabled:opacity-50"
                    title="Change RBAC role for this key"
                  >
                    {changingRole === k.id ? "Saving..." : "Role"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingAllowlist === k.id) {
                        setEditingAllowlist(null);
                      } else {
                        setEditingAllowlist(k.id);
                        setAllowlistDraft((k.ip_allowlist || []).join("\n"));
                        setAllowlistErr(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm"
                    title="Restrict this key to specific source IPs or CIDR blocks"
                  >
                    IP allowlist
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingRoutes === k.id) {
                        setEditingRoutes(null);
                      } else {
                        setEditingRoutes(k.id);
                        setRoutesDraft((k.route_allowlist || []).join("\n"));
                        setRoutesErr(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm"
                    title="Restrict this key to specific /api/v1/* paths (least privilege)"
                  >
                    Route allowlist
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingRate === k.id) {
                        setEditingRate(null);
                      } else {
                        openRateEditor(k.id);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm"
                    title="Cap requests per minute for this key"
                  >
                    <Gauge size={12} weight="duotone" />
                    Rate limit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingQuota === k.id) {
                        setEditingQuota(null);
                      } else {
                        openQuotaEditor(k.id);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm"
                    title="Hard cap on requests this key may make per calendar month"
                  >
                    <ChartLineUp size={12} weight="duotone" />
                    Monthly quota
                  </button>
                  <button
                    type="button"
                    onClick={() => onRotate(k.id, k.label || k.prefix)}
                    disabled={rotating === k.id || revoking === k.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[var(--border-strong)] hover:bg-white/[0.06] rounded-sm disabled:opacity-50"
                    title="Mint a new secret, invalidate the old one"
                  >
                    <ArrowsClockwise
                      size={12}
                      weight="duotone"
                      className={rotating === k.id ? "animate-spin" : ""}
                    />
                    {rotating === k.id ? "Rotating..." : "Rotate"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onToggleSuspend(k.id, k.label || k.prefix, !!k.suspended)
                    }
                    disabled={
                      suspending === k.id || revoking === k.id || rotating === k.id
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 rounded-sm disabled:opacity-50"
                    title={
                      k.suspended
                        ? "Lift the operational hold and let the key authenticate again"
                        : "Reversibly block the key from authenticating without rotating its secret"
                    }
                  >
                    <WarningCircle size={12} weight="duotone" />
                    {suspending === k.id
                      ? k.suspended
                        ? "Resuming..."
                        : "Suspending..."
                      : k.suspended
                        ? "Unsuspend"
                        : "Suspend"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRevoke(k.id, k.label || k.prefix)}
                    disabled={revoking === k.id || rotating === k.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-red-500/30 text-red-300 hover:bg-red-500/10 rounded-sm disabled:opacity-50"
                  >
                    <Trash size={12} weight="duotone" />
                    {revoking === k.id ? "Revoking..." : "Revoke"}
                  </button>
                </div>
                </div>
                {editingRate === k.id && (
                  <div className="mt-2 ml-0 sm:ml-2 p-3 border border-[var(--border)] rounded-sm bg-black/20 space-y-2">
                    <label className="block text-[10px] uppercase tracking-widest muted">
                      Requests per minute
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        value={rateDraft}
                        onChange={(e) => setRateDraft(e.target.value)}
                        className="w-32 bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
                      />
                      <span className="text-[11px] muted">
                        default {rateInfo[k.id]?.default_per_minute ?? "\u2014"}
                        {rateInfo[k.id]?.is_override ? " (override active)" : ""}
                      </span>
                    </div>
                    <p className="text-[11px] muted">
                      Requests over the cap return 429 with Retry-After and
                      standard X-RateLimit-Limit, Remaining, Reset headers.
                      The window is {rateInfo[k.id]?.window_seconds ?? 60} seconds.
                    </p>
                    {rateErr && (
                      <div className="flex items-start gap-2 p-2 border border-red-500/40 bg-red-500/10 rounded-sm text-[12px]">
                        <WarningCircle size={14} weight="duotone" className="text-red-400 shrink-0 mt-0.5" />
                        <span>{rateErr}</span>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onResetRate(k.id)}
                        disabled={savingRate}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Reset to default
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingRate(null)}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingRate}
                        onClick={() => onSaveRate(k.id)}
                        className="px-3 py-1 text-[11px] font-medium bg-[var(--amber)] text-black rounded-sm disabled:opacity-50"
                      >
                        {savingRate ? "Saving..." : "Save limit"}
                      </button>
                    </div>
                  </div>
                )}
                {editingQuota === k.id && (
                  <div className="mt-2 ml-0 sm:ml-2 p-3 border border-[var(--border)] rounded-sm bg-black/20 space-y-2">
                    <label className="block text-[10px] uppercase tracking-widest muted">
                      Requests per calendar month (0 = unlimited)
                    </label>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="number"
                        min={0}
                        max={100000000}
                        value={quotaDraft}
                        onChange={(e) => setQuotaDraft(e.target.value)}
                        className="w-40 bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
                      />
                      <span className="text-[11px] muted">
                        default {quotaInfo[k.id]?.default_monthly_quota ?? 0}
                        {quotaInfo[k.id]?.is_override ? " (override active)" : ""}
                      </span>
                    </div>
                    {quotaInfo[k.id] && (
                      <div className="text-[11px] muted mono">
                        Period {quotaInfo[k.id].period} · used {quotaInfo[k.id].used}
                        {quotaInfo[k.id].unlimited
                          ? " · unlimited"
                          : ` of ${quotaInfo[k.id].monthly_quota} · remaining ${quotaInfo[k.id].remaining ?? 0}`}
                        {" · resets "}{new Date(quotaInfo[k.id].resets_at).toUTCString()}
                      </div>
                    )}
                    <p className="text-[11px] muted">
                      Once a key passes its monthly cap, every v1 request
                      returns 429 with code monthly_quota_exceeded until the
                      first of the next UTC month. Standard X-Quota-Limit,
                      X-Quota-Used, X-Quota-Remaining, X-Quota-Reset headers
                      ride on every response.
                    </p>
                    {quotaErr && (
                      <div className="flex items-start gap-2 p-2 border border-red-500/40 bg-red-500/10 rounded-sm text-[12px]">
                        <WarningCircle size={14} weight="duotone" className="text-red-400 shrink-0 mt-0.5" />
                        <span>{quotaErr}</span>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onResetQuota(k.id)}
                        disabled={savingQuota}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Reset to default
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingQuota(null)}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingQuota}
                        onClick={() => onSaveQuota(k.id)}
                        className="px-3 py-1 text-[11px] font-medium bg-[var(--amber)] text-black rounded-sm disabled:opacity-50"
                      >
                        {savingQuota ? "Saving..." : "Save quota"}
                      </button>
                    </div>
                  </div>
                )}
                {editingAllowlist === k.id && (
                  <div className="mt-2 ml-0 sm:ml-2 p-3 border border-[var(--border)] rounded-sm bg-black/20 space-y-2">
                    <label className="block text-[10px] uppercase tracking-widest muted">
                      Source IP allowlist (one CIDR or IP per line)
                    </label>
                    <textarea
                      value={allowlistDraft}
                      onChange={(e) => setAllowlistDraft(e.target.value)}
                      placeholder={"10.0.0.0/8\n203.0.113.42\n2001:db8::/32"}
                      rows={4}
                      className="w-full bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
                    />
                    <p className="text-[11px] muted">
                      When the list is empty, this key works from any source.
                      When non-empty, requests from outside these networks are
                      rejected with 403. Up to 64 entries. IPv4 and IPv6 both
                      supported. Bare IPs are stored as host networks.
                    </p>
                    {allowlistErr && (
                      <div className="flex items-start gap-2 p-2 border border-red-500/40 bg-red-500/10 rounded-sm text-[12px]">
                        <WarningCircle size={14} weight="duotone" className="text-red-400 shrink-0 mt-0.5" />
                        <span>{allowlistErr}</span>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingAllowlist(null);
                          setAllowlistErr(null);
                        }}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingAllowlist}
                        onClick={() => onSaveAllowlist(k.id)}
                        className="px-3 py-1 text-[11px] font-medium bg-[var(--amber)] text-black rounded-sm disabled:opacity-50"
                      >
                        {savingAllowlist ? "Saving..." : "Save allowlist"}
                      </button>
                    </div>
                  </div>
                )}
                {editingRoutes === k.id && (
                  <div className="mt-2 ml-0 sm:ml-2 p-3 border border-[var(--border)] rounded-sm bg-black/20 space-y-2">
                    <label className="block text-[10px] uppercase tracking-widest muted">
                      Route allowlist (one /api/v1/* path per line)
                    </label>
                    <textarea
                      value={routesDraft}
                      onChange={(e) => setRoutesDraft(e.target.value)}
                      placeholder={"/api/v1/runs\n/api/v1/watchlist"}
                      rows={4}
                      className="w-full bg-black/30 border border-[var(--border)] rounded-sm px-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
                    />
                    <p className="text-[11px] muted">
                      Empty means this key may reach any /api/v1 path its
                      scopes already allow. When non-empty, requests to
                      paths outside the list are rejected with 403
                      route_not_allowed. Entries are path prefixes, so
                      /api/v1/runs also allows /api/v1/runs/abc/export.
                      Up to 32 entries.
                    </p>
                    {routesErr && (
                      <div className="flex items-start gap-2 p-2 border border-red-500/40 bg-red-500/10 rounded-sm text-[12px]">
                        <WarningCircle size={14} weight="duotone" className="text-red-400 shrink-0 mt-0.5" />
                        <span>{routesErr}</span>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingRoutes(null);
                          setRoutesErr(null);
                        }}
                        className="px-3 py-1 text-[11px] muted hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingRoutes}
                        onClick={() => onSaveRoutes(k.id)}
                        className="px-3 py-1 text-[11px] font-medium bg-[var(--amber)] text-black rounded-sm disabled:opacity-50"
                      >
                        {savingRoutes ? "Saving..." : "Save allowlist"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CurlExample />
    </div>
  );
}

function toggle(
  setter: (v: string[]) => void,
  current: string[],
  scope: string,
  checked: boolean,
) {
  const set = new Set(current);
  if (checked) set.add(scope);
  else set.delete(scope);
  setter(Array.from(set));
}

function ScopeToggle({
  scope,
  checked,
  onChange,
  desc,
}: {
  scope: string;
  checked: boolean;
  onChange: (c: boolean) => void;
  desc: string;
}) {
  return (
    <label
      className={`flex-1 min-w-[220px] cursor-pointer border rounded-sm px-3 py-2 transition ${
        checked
          ? "border-[var(--amber)] bg-[var(--amber)]/5"
          : "border-[var(--border)] hover:border-[var(--border-strong)]"
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-[var(--amber)]"
        />
        <span className="text-[12px] font-medium mono uppercase">{scope}</span>
      </div>
      <p className="text-[11px] muted mt-1 leading-snug">{desc}</p>
    </label>
  );
}

function RevealedSecret({
  created,
  onDismiss,
}: {
  created: Created;
  onDismiss: () => void;
}) {
  const [shown, setShown] = useState(true);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this key:", created.secret);
    }
  }

  return (
    <div className="border border-[var(--amber)]/60 bg-[var(--amber)]/5 rounded-sm p-3 space-y-2">
      <div className="flex items-center gap-2">
        <WarningCircle size={16} weight="duotone" className="text-[var(--amber)]" />
        <span className="text-[12px] font-semibold">
          Copy this key now. It will not be shown again.
        </span>
      </div>
      <div className="flex items-center gap-2 bg-black/40 border border-[var(--border)] rounded-sm px-2 py-1.5">
        <code className="flex-1 mono text-[12px] truncate select-all">
          {shown ? created.secret : "•".repeat(40)}
        </code>
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide secret" : "Show secret"}
          className="p-1 muted hover:text-white"
        >
          {shown ? <EyeSlash size={14} weight="duotone" /> : <Eye size={14} weight="duotone" />}
        </button>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[var(--border-strong)] rounded-sm hover:bg-white/[0.05]"
        >
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="duotone" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] muted">
          Label: {created.label} · Scopes: {created.scopes.join(", ")}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] muted hover:text-white"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function CurlExample() {
  const base =
    typeof window !== "undefined"
      ? process.env.NEXT_PUBLIC_API_URL || window.location.origin
      : "";
  const listSnippet = `curl ${base}/v1/runs \\
  -H 'Authorization: Bearer sc_live_your_key_here'`;
  const exportSnippet = `curl -o runs.csv ${base}/v1/runs/export?format=csv \\
  -H 'Authorization: Bearer sc_live_your_key_here'`;
  const usageSnippet = `curl ${base}/v1/usage \\
  -H 'Authorization: Bearer sc_live_your_key_here'`;
  const postSnippet = `curl -X POST ${base}/v1/runs \\
  -H 'Authorization: Bearer sc_live_your_trade_key' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "ticker": "SPY",
    "label": "my first api run",
    "close": [470.1, 471.5, 469.8, 472.0, 473.2, 474.6, 473.9, 475.1,
               476.3, 477.8, 478.5, 479.2, 480.0, 481.1, 482.4, 483.0,
               484.2, 485.5, 486.1, 487.0, 488.3, 489.2, 490.5, 491.7,
               492.4, 493.1, 494.0, 495.3, 496.2, 497.5, 498.1, 499.0]
  }'`;
  const snippet = `${listSnippet}

${exportSnippet}

${usageSnippet}

${postSnippet}`;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <Terminal size={12} weight="duotone" /> Try it from your shell
        </span>
      }
      right={
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] muted hover:text-white"
        >
          {copied ? <Check size={11} weight="bold" /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      }
    >
      <pre className="mono text-[12px] bg-black/40 border border-[var(--border)] rounded-sm p-2 overflow-x-auto whitespace-pre">
        {snippet}
      </pre>
      <p className="text-[11px] muted mt-2">
        The read scope unlocks GET /v1/runs and GET /v1/runs/:id. Pass q,
        ticker, regime, limit, and offset to filter and paginate. Use
        /v1/runs/export and /v1/runs/:id/export with format=csv or json to
        pull results into a spreadsheet or notebook. GET /v1/usage returns
        the same free-tier meter shown in the UI so you can warn users
        before they hit the cap. The trade scope unlocks POST /v1/runs to
        classify a price series and save it to history, and DELETE
        /v1/runs/:id to remove one.
      </p>
    </Card>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Key expiry watch panel. Read-only summary backed by
// GET /api/admin/keys/expiring. Surfaces here so an operator sees the same
// "is anything about to lapse" view they would see from the API. Stays
// silent when nothing is expiring or already expired.

type ClassifiedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  expires_at: string;
  expires_in_ms: number;
  expires_in_days: number;
  bucket: "expired" | "critical" | "soon" | "upcoming";
  revoked: boolean;
  suspended: boolean;
};

type ExpirySummary = {
  generated_at: string;
  window_days: number;
  counts: {
    expired: number;
    critical: number;
    soon: number;
    upcoming: number;
    active_with_expiry: number;
    no_expiry: number;
    revoked_or_suspended: number;
  };
  keys: ClassifiedKey[];
};

function relativeExpiry(k: ClassifiedKey): string {
  const ms = k.expires_in_ms;
  if (ms <= 0) {
    const days = Math.max(0, -k.expires_in_days);
    if (days === 0) return "expired today";
    if (days === 1) return "expired 1 day ago";
    return `expired ${days} days ago`;
  }
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) return hours <= 1 ? "in under 1 hour" : `in ${hours} hours`;
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function bucketTone(b: ClassifiedKey["bucket"]): {
  border: string;
  label: string;
} {
  switch (b) {
    case "expired":
      return { border: "border-red-500/40", label: "Expired" };
    case "critical":
      return { border: "border-red-500/40", label: "Under 24h" };
    case "soon":
      return { border: "border-amber-500/40", label: "Under 7d" };
    case "upcoming":
      return { border: "border-[var(--border-strong)]", label: "Upcoming" };
  }
}

function ExpiryWatch() {
  const { data, error, isLoading } = useSWR<ExpirySummary>(
    "/admin/keys/expiring?within_days=30",
    swrFetcher,
    { refreshInterval: 60_000 },
  );

  if (isLoading) {
    return (
      <div className="rounded-sm border border-[var(--border-strong)] bg-white/[0.02] px-3 py-2 text-[12px] muted flex items-center gap-2">
        <Clock size={14} weight="duotone" /> Checking key expiries
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-sm border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] text-red-300 flex items-center gap-2">
        <WarningCircle size={14} weight="duotone" />
        Could not load expiry summary
      </div>
    );
  }
  if (!data) return null;
  const c = data.counts;
  const total = c.expired + c.critical + c.soon + c.upcoming;
  if (total === 0) {
    // Stay quiet when nothing is on the radar; empty state lives below in
    // the keys list itself. Avoids "all green" badge noise on a fresh
    // install where every key is fresh.
    return null;
  }
  const headlineRed = c.expired > 0 || c.critical > 0;
  return (
    <div
      className={`rounded-sm border ${headlineRed ? "border-red-500/40 bg-red-500/5" : "border-amber-500/40 bg-amber-500/5"} px-3 py-2.5`}
    >
      <div className="flex items-center gap-2 text-[12px] font-medium">
        <Hourglass
          size={14}
          weight="duotone"
          className={headlineRed ? "text-red-400" : "text-amber-400"}
        />
        <span>
          {c.expired > 0 && (
            <span className="text-red-300">
              {c.expired} expired
              {(c.critical || c.soon || c.upcoming) > 0 ? " · " : ""}
            </span>
          )}
          {c.critical > 0 && (
            <span className="text-red-300">
              {c.critical} under 24h
              {(c.soon || c.upcoming) > 0 ? " · " : ""}
            </span>
          )}
          {c.soon > 0 && (
            <span className="text-amber-300">
              {c.soon} under 7d{c.upcoming > 0 ? " · " : ""}
            </span>
          )}
          {c.upcoming > 0 && (
            <span className="muted">{c.upcoming} within 30d</span>
          )}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {data.keys.slice(0, 6).map((k) => {
          const t = bucketTone(k.bucket);
          return (
            <li
              key={k.id}
              className={`flex items-center justify-between gap-3 rounded-sm border ${t.border} bg-white/[0.02] px-2 py-1.5 text-[12px]`}
            >
              <div className="min-w-0 flex items-center gap-2">
                <Key size={12} weight="duotone" className="shrink-0 muted" />
                <span className="truncate font-medium">{k.label}</span>
                <span className="muted font-mono text-[11px] truncate">
                  {k.prefix}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge>{t.label}</Badge>
                <span className="muted tabular-nums">{relativeExpiry(k)}</span>
              </div>
            </li>
          );
        })}
        {data.keys.length > 6 && (
          <li className="text-[11px] muted px-2">
            and {data.keys.length - 6} more in the list below
          </li>
        )}
      </ul>
    </div>
  );
}

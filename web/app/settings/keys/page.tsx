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
} from "@phosphor-icons/react/dist/ssr";

type StoredKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
  ip_allowlist?: string[];
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
  const [created, setCreated] = useState<Created | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [editingAllowlist, setEditingAllowlist] = useState<string | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState("");
  const [allowlistErr, setAllowlistErr] = useState<string | null>(null);
  const [savingAllowlist, setSavingAllowlist] = useState(false);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState("");
  const [rateErr, setRateErr] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [rateInfo, setRateInfo] = useState<Record<string, { limit_per_minute: number; default_per_minute: number; window_seconds: number; is_override: boolean }>>({});

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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    setBusy(true);
    try {
      const out = await api<Created>("/admin/keys", {
        method: "POST",
        body: JSON.stringify({ label: label.trim(), scopes }),
      });
      setCreated(out);
      setLabel("");
      setScopes(["read"]);
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
                Admin scope can only be granted from the server config, not the
                UI. This prevents privilege escalation.
              </p>
            </fieldset>
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
                    {k.scopes.map((s) => (
                      <Badge key={s} tone={s === "trade" ? "warn" : "neutral"}>
                        {s}
                      </Badge>
                    ))}
                    {k.ip_allowlist && k.ip_allowlist.length > 0 && (
                      <Badge tone="neutral">
                        IP allowlist · {k.ip_allowlist.length}
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] muted mono mt-0.5">
                    {k.prefix}… · created {fmtDate(k.created_at)}
                    {k.last_used_at ? ` · last used ${fmtDate(k.last_used_at)}` : " · never used"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
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

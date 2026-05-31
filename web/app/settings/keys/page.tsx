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
} from "@phosphor-icons/react/dist/ssr";

type StoredKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
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
              <li key={k.id} className="flex items-center gap-3 py-2.5 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium truncate">{k.label || "unnamed"}</span>
                    {k.scopes.map((s) => (
                      <Badge key={s} tone={s === "trade" ? "warn" : "neutral"}>
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-[11px] muted mono mt-0.5">
                    {k.prefix}… · created {fmtDate(k.created_at)}
                    {k.last_used_at ? ` · last used ${fmtDate(k.last_used_at)}` : " · never used"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(k.id, k.label || k.prefix)}
                  disabled={revoking === k.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-red-500/30 text-red-300 hover:bg-red-500/10 rounded-sm disabled:opacity-50"
                >
                  <Trash size={12} weight="duotone" />
                  {revoking === k.id ? "Revoking..." : "Revoke"}
                </button>
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
      ? process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431"
      : "http://localhost:7431";
  const snippet = `curl ${base}/picks \\
  -H 'x-api-key: sck_your_key_here'`;
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
        Replace the key with the value shown above. Read scope works for /picks,
        /portfolio/snapshot, /regime. Trade scope unlocks POST to /watchlist and
        /alerts.
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

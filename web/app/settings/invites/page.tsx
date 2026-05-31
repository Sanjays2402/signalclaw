"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
  Button,
  Input,
  Field,
} from "@/components/ui";
import {
  UserPlus,
  Trash,
  Check,
  Link as LinkIcon,
  Users,
  Warning,
} from "@phosphor-icons/react/dist/ssr";

type InviteScope = "read" | "trade";

type InvitePublic = {
  token: string;
  label: string;
  scopes: InviteScope[];
  max_uses: number;
  used_count: number;
  remaining: number;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
  created_by_key_id: string;
  accepted_by: { key_id: string; at: string }[];
  status: "pending" | "exhausted" | "expired" | "revoked";
};

type InvitesList = {
  invites: InvitePublic[];
  seats: { used: number; limit: number; remaining: number | null; unlimited: boolean };
};

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then(async (r) => {
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    return JSON.parse(t);
  });

export default function InvitesPage() {
  const { data, error, isLoading, mutate } = useSWR<InvitesList>(
    "/api/admin/invites",
    fetcher,
  );

  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<InviteScope[]>(["read"]);
  const [maxUses, setMaxUses] = useState("1");
  const [expiryDays, setExpiryDays] = useState("7");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function toggleScope(s: InviteScope) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateErr(null);
    try {
      const days = Number(expiryDays);
      const body: any = {
        label: label.trim(),
        scopes,
        max_uses: Math.max(1, Math.min(100, Number(maxUses) || 1)),
        expires_in_seconds:
          Number.isFinite(days) && days > 0 ? Math.floor(days * 24 * 3600) : 0,
      };
      const r = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (!r.ok) {
        const parsed = (() => { try { return JSON.parse(txt); } catch { return null; } })();
        throw new Error(parsed?.error?.message || txt || `${r.status}`);
      }
      setLabel("");
      setScopes(["read"]);
      setMaxUses("1");
      setExpiryDays("7");
      await mutate();
    } catch (e: any) {
      setCreateErr(String(e?.message || e));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: string) {
    if (!confirm("Revoke this invite? Anyone holding the link will not be able to redeem it.")) return;
    const r = await fetch(`/api/admin/invites/${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      alert(`Revoke failed: ${await r.text()}`);
      return;
    }
    await mutate();
  }

  async function copyLink(token: string) {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt("Copy this invite link", url);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] muted uppercase tracking-wider flex items-center gap-1.5">
            <UserPlus size={14} weight="duotone" />
            Onboarding
          </div>
          <h1 className="text-lg font-semibold mono">Invites and seats</h1>
        </div>
        <Link href="/settings" className="text-[11px] muted hover:text-white">
          Back to settings
        </Link>
      </header>

      <Card title="Seat usage">
        {isLoading ? (
          <Loading label="Loading seats" />
        ) : error ? (
          <ErrorBox err={error} />
        ) : data ? (
          <div className="flex items-center gap-3 text-sm">
            <Users size={18} weight="duotone" className="opacity-70" />
            <span className="mono">
              {data.seats.used}
              {data.seats.unlimited ? "" : ` / ${data.seats.limit}`} active keys
            </span>
            {!data.seats.unlimited && data.seats.remaining === 0 ? (
              <Badge tone="warn">at limit</Badge>
            ) : data.seats.unlimited ? (
              <Badge tone="info">unlimited</Badge>
            ) : (
              <span className="muted text-[11px]">
                {data.seats.remaining} remaining
              </span>
            )}
          </div>
        ) : null}
      </Card>

      <Card title="Create invite">
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <Field label="Label">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="alice@acme.com"
              required
              maxLength={80}
            />
          </Field>
          <Field label="Scopes">
            <div className="flex items-center gap-2">
              <label className="text-xs flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={scopes.includes("read")}
                  onChange={() => toggleScope("read")}
                />
                read
              </label>
              <label className="text-xs flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={scopes.includes("trade")}
                  onChange={() => toggleScope("trade")}
                />
                trade
              </label>
            </div>
          </Field>
          <Field label="Seats (max uses)">
            <Input
              type="number"
              min={1}
              max={100}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </Field>
          <Field label="Expires in days (0 = never, up to 90)">
            <Input
              type="number"
              min={0}
              max={90}
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button type="submit" disabled={creating || scopes.length === 0}>
              <UserPlus size={14} weight="duotone" />
              {creating ? "Creating" : "Create invite"}
            </Button>
            {createErr && (
              <span className="text-xs text-red-400 flex items-center gap-1">
                <Warning size={12} weight="duotone" /> {createErr}
              </span>
            )}
          </div>
        </form>
      </Card>

      <Card title="Invites">
        {isLoading ? (
          <Loading label="Loading invites" />
        ) : error ? (
          <ErrorBox err={error} />
        ) : !data || data.invites.length === 0 ? (
          <Empty
            title="No invites yet"
            hint="Create one above and share the link with a teammate."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left muted">
                <tr>
                  <th className="py-2 pr-3">Label</th>
                  <th className="py-2 pr-3">Scopes</th>
                  <th className="py-2 pr-3">Seats</th>
                  <th className="py-2 pr-3">Expires</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Created</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.invites.map((inv) => (
                  <tr key={inv.token} className="border-t border-white/5">
                    <td className="py-2 pr-3 mono">{inv.label}</td>
                    <td className="py-2 pr-3 mono">{inv.scopes.join(", ")}</td>
                    <td className="py-2 pr-3 mono">
                      {inv.used_count} / {inv.max_uses}
                    </td>
                    <td className="py-2 pr-3 muted">
                      {inv.expires_at
                        ? new Date(inv.expires_at).toLocaleString()
                        : "never"}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        tone={
                          inv.status === "pending"
                            ? "info"
                            : inv.status === "revoked"
                              ? "warn"
                              : "neutral"
                        }
                      >
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 muted">
                      {new Date(inv.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2 justify-end">
                        {inv.status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => copyLink(inv.token)}
                            className="inline-flex items-center gap-1 text-[11px] muted hover:text-white"
                            aria-label="Copy invite link"
                          >
                            {copied === inv.token ? (
                              <Check size={12} weight="duotone" />
                            ) : (
                              <LinkIcon size={12} weight="duotone" />
                            )}
                            <span>{copied === inv.token ? "Copied" : "Copy link"}</span>
                          </button>
                        ) : null}
                        {!inv.revoked ? (
                          <button
                            type="button"
                            onClick={() => revoke(inv.token)}
                            className="inline-flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300"
                            aria-label="Revoke invite"
                          >
                            <Trash size={12} weight="duotone" />
                            <span>Revoke</span>
                          </button>
                        ) : null}
                      </div>
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

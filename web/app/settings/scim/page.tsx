"use client";
// Admin: SCIM 2.0 provisioning console.
//
// Two jobs:
//   1. Mint / rotate / revoke the bearer token Okta or Azure AD will use
//      to push users into this workspace. The plaintext is shown once at
//      rotate time; after that only the prefix is visible.
//   2. Audit what the IdP has actually pushed (read-only list of
//      provisioned users with active flag and last-modified timestamp).
//
// All mutations route through /api/admin/scim (admin-scoped, MFA gated)
// and are recorded to the tamper-evident audit log. The IdP-facing
// endpoints at /scim/v2/* are documented inline so an enterprise IT team
// can plug them into Okta in five minutes.
import useSWR from "swr";
import { useState } from "react";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
  Button,
} from "@/components/ui";
import {
  ShieldCheck,
  Key,
  ArrowsClockwise,
  Trash,
  Users,
  CheckCircle,
  XCircle,
  Copy,
  PlugsConnected,
} from "@phosphor-icons/react/dist/ssr";
import { swrFetcher } from "@/lib/api";

type TokenStatus = {
  configured: boolean;
  prefix: string | null;
  created_at: string | null;
  last_used_at: string | null;
};

type UsersResp = {
  total: number;
  active: number;
  users: Array<{
    id: string;
    userName: string;
    givenName: string | null;
    familyName: string | null;
    active: boolean;
    externalId: string | null;
    created_at: string;
    updated_at: string;
  }>;
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const dt = Date.now() - t;
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ScimPage() {
  return (
    <AuthGate>
      <Scim />
    </AuthGate>
  );
}

function Scim() {
  const tok = useSWR<TokenStatus>("/api/admin/scim", swrFetcher, {
    refreshInterval: 30_000,
  });
  const users = useSWR<UsersResp>("/api/admin/scim/users", swrFetcher, {
    refreshInterval: 30_000,
  });
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function rotate() {
    if (busy) return;
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await fetch("/api/admin/scim", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      setMinted(j.token);
      tok.mutate();
    } catch (e: any) {
      setErrMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    if (!confirm("Revoke the SCIM token? The IdP will stop syncing until a new token is minted."))
      return;
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await fetch("/api/admin/scim", { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      setMinted(null);
      tok.mutate();
    } catch (e: any) {
      setErrMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const scimBase =
    typeof window !== "undefined" ? `${window.location.origin}/scim/v2` : "/scim/v2";

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <PlugsConnected size={24} weight="duotone" className="text-emerald-400" />
          SCIM 2.0 provisioning
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Lifecycle automation for Okta, Azure AD, and Google Workspace. The IdP pushes
          users to this workspace using the bearer token below.
        </p>
      </header>

      {errMsg ? <ErrorBox err={errMsg} /> : null}

      <section className="grid gap-4 sm:grid-cols-2 mb-6">
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-400">
              <Key size={14} weight="duotone" />
              <span>Bearer token</span>
            </div>
            {tok.isLoading ? (
              <Loading />
            ) : tok.error ? (
              <ErrorBox err={tok.error} />
            ) : tok.data?.configured ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Badge tone="up">
                    <CheckCircle size={12} weight="duotone" />
                    <span className="ml-1">Active</span>
                  </Badge>
                  <span className="text-xs text-zinc-500 font-mono">
                    {tok.data.prefix}...
                  </span>
                </div>
                <div className="text-xs text-zinc-400">
                  Minted {relTime(tok.data.created_at)}. Last used{" "}
                  {relTime(tok.data.last_used_at)}.
                </div>
              </div>
            ) : (
              <Empty title="No token minted" hint="Rotate to provision an IdP connection." />
            )}
            <div className="flex gap-2 flex-wrap">
              <Button onClick={rotate} disabled={busy}>
                <ArrowsClockwise size={14} weight="duotone" />
                <span className="ml-1">{tok.data?.configured ? "Rotate" : "Mint token"}</span>
              </Button>
              {tok.data?.configured ? (
                <Button onClick={revoke} disabled={busy} variant="ghost">
                  <Trash size={14} weight="duotone" />
                  <span className="ml-1">Revoke</span>
                </Button>
              ) : null}
            </div>
            {minted ? (
              <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <div className="text-amber-300 font-medium mb-1">
                  Copy this now. It will not be shown again.
                </div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-zinc-100 break-all">{minted}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(minted);
                    }}
                    className="text-zinc-400 hover:text-zinc-100"
                    aria-label="Copy token"
                  >
                    <Copy size={14} weight="duotone" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-400">
              <PlugsConnected size={14} weight="duotone" />
              <span>IdP endpoints</span>
            </div>
            <div className="text-xs text-zinc-400 space-y-1.5 font-mono">
              <div>
                <span className="text-zinc-500">Base URL:</span>
                <div className="text-zinc-100 break-all">{scimBase}</div>
              </div>
              <div>
                <span className="text-zinc-500">Auth:</span>
                <div className="text-zinc-100">OAuth Bearer Token</div>
              </div>
              <div>
                <span className="text-zinc-500">Discovery:</span>
                <div className="text-zinc-100 break-all">
                  {scimBase}/ServiceProviderConfig
                </div>
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              Paste the base URL and bearer token into your IdP&apos;s SCIM connector.
              Filter, PATCH, and User CRUD are supported. Groups and bulk are not.
            </div>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-semibold tracking-wide uppercase text-zinc-400 mb-3 flex items-center gap-2">
          <Users size={14} weight="duotone" />
          Provisioned users
          {users.data ? (
            <Badge tone="neutral">
              {users.data.active} active of {users.data.total}
            </Badge>
          ) : null}
        </h2>
        <Card>
          {users.isLoading ? (
            <Loading />
          ) : users.error ? (
            <ErrorBox err={users.error} />
          ) : !users.data || users.data.users.length === 0 ? (
            <Empty
              title="No users provisioned yet"
              hint="Once the IdP is connected, pushed users appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left py-2 pr-3">User</th>
                    <th className="text-left py-2 pr-3">State</th>
                    <th className="text-left py-2 pr-3">External id</th>
                    <th className="text-left py-2 pr-3">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.users.map((u) => (
                    <tr key={u.id} className="border-b border-zinc-900">
                      <td className="py-2 pr-3">
                        <div className="text-zinc-100">{u.userName}</div>
                        {u.givenName || u.familyName ? (
                          <div className="text-xs text-zinc-500">
                            {[u.givenName, u.familyName].filter(Boolean).join(" ")}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        {u.active ? (
                          <Badge tone="up">
                            <CheckCircle size={12} weight="duotone" />
                            <span className="ml-1">Active</span>
                          </Badge>
                        ) : (
                          <Badge tone="down">
                            <XCircle size={12} weight="duotone" />
                            <span className="ml-1">Suspended</span>
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs font-mono text-zinc-400">
                        {u.externalId ?? "-"}
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-400">
                        {relTime(u.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </main>
  );
}

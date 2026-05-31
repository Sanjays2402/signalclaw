"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Button, Field, Input, Badge } from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  Key,
  Globe,
  SignIn,
  SignOut,
  Warning,
  CheckCircle,
  Lock,
} from "@phosphor-icons/react/dist/ssr";

type PublicPolicy = {
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_set: boolean;
  allowed_domains: string[];
  enforce: boolean;
  redirect_uri: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

export default function SsoSettingsPage() {
  return (
    <AuthGate>
      <SsoSettingsInner />
    </AuthGate>
  );
}

function SsoSettingsInner() {
  const { data, error, isLoading, mutate } = useSWR<{ policy: PublicPolicy }>(
    "/admin/sso",
    swrFetcher,
  );

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [enforce, setEnforce] = useState(false);
  const [redirectUri, setRedirectUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // One-shot hydrate from loaded policy.
  if (data?.policy && !hydrated) {
    const p = data.policy;
    setIssuer(p.issuer);
    setClientId(p.client_id);
    setDomains(p.allowed_domains.join(", "));
    setEnabled(p.enabled);
    setEnforce(p.enforce);
    setRedirectUri(p.redirect_uri || "");
    setHydrated(true);
  }

  // Surface URL-driven errors from the callback redirect.
  let urlError: string | null = null;
  if (typeof window !== "undefined") {
    urlError = new URL(window.location.href).searchParams.get("error");
  }

  async function save() {
    setBusy(true);
    setErrMsg(null);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        enforce,
        issuer,
        client_id: clientId,
        allowed_domains: domains
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        redirect_uri: redirectUri.trim() ? redirectUri.trim() : null,
      };
      if (clientSecret.trim()) body.client_secret = clientSecret.trim();
      const out = await api<{ policy: PublicPolicy }>("/admin/sso", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setMsg("SSO policy saved.");
      setClientSecret("");
      mutate(out, { revalidate: false });
    } catch (e) {
      setErrMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Loading label="Loading SSO policy" />;
  if (error) return <ErrorBox err={error} />;

  const policy = data?.policy;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldCheck size={28} weight="duotone" /> Single Sign-On (OIDC)
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Federate dashboard sign-in with Google Workspace, Okta, Azure AD, or
            any OpenID Connect provider. Required for SOC2 / enterprise
            procurement.
          </p>
        </div>
        <div className="flex gap-2">
          {policy?.enabled ? (
            <Badge tone="up">enabled</Badge>
          ) : (
            <Badge tone="neutral">disabled</Badge>
          )}
          {policy?.enforce && <Badge tone="warn">enforced</Badge>}
        </div>
      </header>

      {urlError && (
        <Card>
          <div className="flex items-start gap-3 text-sm text-amber-700 dark:text-amber-400">
            <Warning size={20} weight="duotone" className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Sign-in failed</div>
              <div className="opacity-80">Reason: <code>{urlError}</code>. Check the audit log for details.</div>
            </div>
          </div>
        </Card>
      )}

      {msg && (
        <Card>
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle size={18} weight="duotone" /> {msg}
          </div>
        </Card>
      )}
      {errMsg && <ErrorBox err={errMsg} />}

      <Card>
        <div className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Key size={20} weight="duotone" /> Provider
          </h2>

          <Field label="Issuer URL">
            <Input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="https://accounts.google.com"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-neutral-500">OIDC discovery base, e.g. https://accounts.google.com</p>
          </Field>

          <Field label="Client ID">
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="your-app-client-id"
              autoComplete="off"
            />
          </Field>

          <Field label="Client secret">
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={policy?.client_secret_set ? "•••••••• (set)" : ""}
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-neutral-500">
              {policy?.client_secret_set
                ? "Stored. Leave blank to keep current secret."
                : "Required when SSO is enabled."}
            </p>
          </Field>

          <Field label="Redirect URI override">
            <Input
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-neutral-500">Optional. Default: this origin + /api/auth/sso/callback</p>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Globe size={20} weight="duotone" /> Access
          </h2>
          <Field label="Allowed email domains">
            <Input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="example.com, partner.io"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-neutral-500">Comma- or space-separated. Empty allows any verified email from the IdP.</p>
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-neutral-100"
            />
            <span>
              <span className="font-medium">Enable SSO</span>
              <span className="block text-neutral-500">
                Users may sign in via the IdP. API key auth continues to work.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={enforce}
              onChange={(e) => setEnforce(e.target.checked)}
              disabled={!enabled}
              className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-neutral-100 disabled:opacity-40"
            />
            <span>
              <span className="font-medium flex items-center gap-1">
                <Lock size={14} weight="duotone" /> Enforce SSO for dashboard sessions
              </span>
              <span className="block text-neutral-500">
                Browser admin actions require an SSO session. CI keys with the
                <code className="mx-1">admin</code> scope continue to work.
              </span>
            </span>
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save SSO policy"}
        </Button>
        <a
          href="/api/auth/sso/login?return_to=/settings/sso"
          className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          <SignIn size={16} weight="duotone" /> Test sign-in
        </a>
        <a
          href="/api/auth/sso/logout"
          className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          <SignOut size={16} weight="duotone" /> Sign out
        </a>
      </div>

      {policy && (
        <p className="text-xs text-neutral-500">
          Last updated{" "}
          {policy.updated_at ? new Date(policy.updated_at).toLocaleString() : "never"}
          {policy.updated_by ? ` by ${policy.updated_by}` : ""}.
        </p>
      )}
    </div>
  );
}

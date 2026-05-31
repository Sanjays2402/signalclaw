"use client";
import { useEffect, useState, use } from "react";
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
  CheckCircle,
  Copy,
  Check,
  Warning,
  Key,
} from "@phosphor-icons/react/dist/ssr";

type Invite = {
  token: string;
  label: string;
  scopes: ("read" | "trade")[];
  expires_at: string | null;
  status: "pending" | "exhausted" | "expired" | "revoked";
};

type CreatedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  secret: string;
};

export default function InviteRedeemPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [label, setLabel] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [acceptErr, setAcceptErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        const txt = await r.text();
        if (!r.ok) {
          const parsed = (() => { try { return JSON.parse(txt); } catch { return null; } })();
          throw new Error(parsed?.error?.message || txt || `${r.status}`);
        }
        if (!cancelled) setInvite(JSON.parse(txt));
      } catch (e: any) {
        if (!cancelled) setLoadErr(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function accept() {
    setAccepting(true);
    setAcceptErr(null);
    try {
      const r = await fetch(
        `/api/invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(label.trim() ? { label: label.trim() } : {}),
        },
      );
      const txt = await r.text();
      if (!r.ok) {
        const parsed = (() => { try { return JSON.parse(txt); } catch { return null; } })();
        throw new Error(parsed?.error?.message || txt || `${r.status}`);
      }
      setMinted(JSON.parse(txt));
    } catch (e: any) {
      setAcceptErr(String(e?.message || e));
    } finally {
      setAccepting(false);
    }
  }

  async function copySecret() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy your API key", minted.secret);
    }
  }

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-10 space-y-4">
      <header className="space-y-1">
        <div className="text-[11px] muted uppercase tracking-wider flex items-center gap-1.5">
          <UserPlus size={14} weight="duotone" />
          You have been invited
        </div>
        <h1 className="text-lg font-semibold mono">Accept invite</h1>
      </header>

      {loading ? (
        <Loading label="Loading invite" />
      ) : loadErr ? (
        <ErrorBox err={loadErr} />
      ) : !invite ? (
        <Empty title="Invite not found" hint="The link may be mistyped." />
      ) : minted ? (
        <Card title="Your API key">
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2">
              <CheckCircle size={16} weight="duotone" className="text-green-400" />
              Invite redeemed. This secret is shown only once. Store it safely now.
            </p>
            <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs break-all">
              {minted.secret}
            </div>
            <div className="flex items-center gap-3">
              <Button type="button" onClick={copySecret}>
                {copied ? <Check size={14} weight="duotone" /> : <Copy size={14} weight="duotone" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <span className="text-[11px] muted">
                Prefix {minted.prefix}... scopes {minted.scopes.join(", ")}
              </span>
            </div>
            <p className="text-[11px] muted">
              Use as <code className="mono">x-api-key</code> header on every <code className="mono">/v1/*</code> request.
            </p>
          </div>
        </Card>
      ) : invite.status !== "pending" ? (
        <Card title="This invite is no longer valid">
          <div className="text-sm">
            <Badge tone="warn">{invite.status}</Badge>
            <p className="muted mt-2">
              Ask the person who sent you the link to create a new one.
            </p>
          </div>
        </Card>
      ) : (
        <Card title={`Invited as "${invite.label}"`}>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-xs">
              <Key size={14} weight="duotone" className="opacity-70" />
              <span className="mono">Scopes:</span>
              {invite.scopes.map((s) => (
                <Badge key={s} tone="info">{s}</Badge>
              ))}
            </div>
            {invite.expires_at && (
              <p className="text-[11px] muted">
                Expires {new Date(invite.expires_at).toLocaleString()}
              </p>
            )}
            <Field label="Name this key (optional)">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={invite.label}
                maxLength={80}
              />
            </Field>
            <div className="flex items-center gap-3">
              <Button type="button" onClick={accept} disabled={accepting}>
                <CheckCircle size={14} weight="duotone" />
                {accepting ? "Accepting" : "Accept and reveal API key"}
              </Button>
              {acceptErr && (
                <span className="text-xs text-red-400 flex items-center gap-1">
                  <Warning size={12} weight="duotone" /> {acceptErr}
                </span>
              )}
            </div>
            <p className="text-[11px] muted">
              On accept, a new API key is minted for you and counted against the workspace seat limit. The secret is revealed exactly once on the next screen.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

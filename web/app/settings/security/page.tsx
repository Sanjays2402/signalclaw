"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Input,
  Field,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  ShieldWarning,
  QrCode,
  Copy,
  Check,
  Trash,
  Key,
} from "@phosphor-icons/react/dist/ssr";

type Status = {
  enrolled: boolean;
  pending: boolean;
  required_for_admin: boolean;
};

type Enroll = {
  secret: string;
  otpauth_uri: string;
  algorithm: string;
  digits: number;
  period_seconds: number;
};

function googleQrUrl(uri: string): string {
  // Static QR rendering via Google Charts. Pure GET, no JS dependency,
  // works fully offline-by-paste because the otpauth URI is shown too.
  const enc = encodeURIComponent(uri);
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${enc}`;
}

export default function SecurityPage() {
  return (
    <AuthGate>
      <SecurityInner />
    </AuthGate>
  );
}

function SecurityInner() {
  const { data, error, isLoading, mutate } = useSWR<Status>(
    "/mfa/status",
    swrFetcher,
  );

  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [adminCode, setAdminCode] = useState("");

  // Restore any persisted MFA code so the user does not have to retype
  // it for every admin call in the same tab.
  useEffect(() => {
    if (typeof window !== "undefined") {
      setAdminCode(sessionStorage.getItem("sc_mfa_code") || "");
    }
  }, []);

  async function startEnroll() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const out = await api<Enroll>("/mfa/enroll", {
        method: "POST",
        body: JSON.stringify({ label: "signalclaw-admin" }),
      });
      setEnroll(out);
    } catch (e) {
      setErr(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!/^\d{6}$/.test(code.trim())) {
      setErr("Code must be 6 digits");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api("/mfa/confirm", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      setEnroll(null);
      setCode("");
      setMsg("MFA enrolled. Admin actions now require a TOTP code.");
      mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!confirm) return;
    if (!window.confirm("Disable MFA for this key? Admin actions will only require the API key.")) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/mfa/disable", { method: "POST" });
      setMsg("MFA disabled.");
      mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  function saveAdminCode(value: string) {
    setAdminCode(value);
    if (typeof window !== "undefined") {
      if (value) sessionStorage.setItem("sc_mfa_code", value);
      else sessionStorage.removeItem("sc_mfa_code");
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <header className="flex items-center gap-3">
        <ShieldCheck size={28} weight="duotone" className="text-emerald-500" />
        <div>
          <h1 className="text-2xl font-semibold">Security</h1>
          <p className="text-sm text-neutral-500">
            Two-factor authentication for admin actions on this API key.
          </p>
        </div>
      </header>

      {isLoading && <Loading label="Loading security status" />}
      {error && <ErrorBox err={error} />}
      {msg && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          {err}
        </div>
      )}

      {data && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Status</span>
                {data.enrolled ? (
                  <Badge tone="up">Enrolled</Badge>
                ) : data.pending ? (
                  <Badge tone="neutral">Pending</Badge>
                ) : (
                  <Badge tone="down">Not enrolled</Badge>
                )}
                {data.required_for_admin && (
                  <Badge tone="neutral">Required by policy</Badge>
                )}
              </div>
              <p className="text-sm text-neutral-500">
                Covered routes: <code>/audit</code>, <code>/admin/keys/*</code>,{" "}
                <code>/privacy/export</code>, <code>/privacy/delete</code>,{" "}
                <code>/mfa/disable</code>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!data.enrolled && !data.pending && !enroll && (
                <Button onClick={startEnroll} disabled={busy}>
                  <Key size={16} weight="duotone" />
                  Enroll TOTP
                </Button>
              )}
              {data.enrolled && (
                <Button onClick={disable} disabled={busy}>
                  <Trash size={16} weight="duotone" />
                  Disable MFA
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {enroll && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <QrCode size={20} weight="duotone" />
              <h2 className="text-base font-semibold">Scan with your authenticator</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-[220px,1fr] items-start">
              <img
                src={googleQrUrl(enroll.otpauth_uri)}
                alt="TOTP enrollment QR code"
                className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white"
                width={220}
                height={220}
              />
              <div className="space-y-3 min-w-0">
                <Field label="Or enter the secret manually">
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={enroll.secret}
                      className="font-mono text-xs"
                    />
                    <Button onClick={() => copy(enroll.secret)}>
                      {copied ? (
                        <Check size={16} weight="duotone" />
                      ) : (
                        <Copy size={16} weight="duotone" />
                      )}
                    </Button>
                  </div>
                </Field>
                <Field label="Enter the 6-digit code your app shows">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    aria-label="TOTP code"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button onClick={confirm} disabled={busy || code.length !== 6}>
                    Confirm enrollment
                  </Button>
                  <Button
                    onClick={() => {
                      setEnroll(null);
                      setCode("");
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {data?.enrolled && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldWarning size={20} weight="duotone" className="text-amber-500" />
              <h2 className="text-base font-semibold">Admin session code</h2>
            </div>
            <p className="text-sm text-neutral-500">
              Paste a fresh 6-digit code here before opening Audit, API Keys,
              or Data export. Stored only in this browser tab and rotated by
              the server on every admin call.
            </p>
            <div className="flex gap-2">
              <Input
                value={adminCode}
                onChange={(e) => saveAdminCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Latest 6-digit code"
                aria-label="Active TOTP code"
              />
              <Button onClick={() => saveAdminCode("")} disabled={!adminCode}>
                Clear
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Input,
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
} from "@phosphor-icons/react/dist/ssr";

type Status = {
  key_id: string;
  enrolled: boolean;
  last_verified_at: string | null;
  created_at: string | null;
};

type Enroll = {
  key_id: string;
  secret_b32: string;
  otpauth_uri: string;
  digits: number;
  step_seconds: number;
};

function googleQrUrl(uri: string): string {
  const enc = encodeURIComponent(uri);
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${enc}`;
}

export default function AdminMfaPage() {
  return (
    <AuthGate>
      <AdminMfaInner />
    </AuthGate>
  );
}

function AdminMfaInner() {
  const { data, error, isLoading, mutate } = useSWR<{ status: Status }>(
    "/admin/mfa",
    swrFetcher,
  );
  const [enrollment, setEnrollment] = useState<Enroll | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function startEnroll() {
    setBusy(true);
    setErrMsg(null);
    setMsg(null);
    try {
      const out = await api<Enroll>("/admin/mfa", { method: "POST" });
      setEnrollment(out);
      setCode("");
    } catch (e) {
      setErrMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!/^[0-9]{6}$/.test(code.trim())) {
      setErrMsg("Code must be 6 digits.");
      return;
    }
    setBusy(true);
    setErrMsg(null);
    try {
      await api("/admin/mfa", {
        method: "PUT",
        body: JSON.stringify({ code: code.trim() }),
      });
      setMsg("MFA verified. It is now required on every mutating admin route.");
      setEnrollment(null);
      setCode("");
      mutate();
    } catch (e) {
      setErrMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!/^[0-9]{6}$/.test(disableCode.trim())) {
      setErrMsg("Enter a current 6-digit code to disable MFA.");
      return;
    }
    setBusy(true);
    setErrMsg(null);
    try {
      // Stash the code so the global api() wrapper forwards it as
      // x-mfa-code on this single call.
      sessionStorage.setItem("sc_mfa_code", disableCode.trim());
      await api("/admin/mfa", { method: "DELETE" });
      sessionStorage.removeItem("sc_mfa_code");
      setMsg("MFA disabled for this admin key.");
      setDisableCode("");
      mutate();
    } catch (e) {
      sessionStorage.removeItem("sc_mfa_code");
      setErrMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret_b32);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; secret is on screen for manual copy.
    }
  }

  const status = data?.status;
  const enrolled = !!status?.enrolled;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <div className="flex items-center gap-2 mb-4">
        <ShieldWarning size={18} weight="duotone" className="opacity-80" />
        <h1 className="text-lg font-semibold mono">Admin MFA</h1>
        {enrolled ? (
          <Badge>enrolled</Badge>
        ) : (
          <Badge>not enrolled</Badge>
        )}
      </div>

      <p className="text-xs muted mb-6 max-w-prose">
        Time-based one-time passwords (RFC 6238) for the admin API key. Once
        enrolled, every mutating admin route requires a fresh 6-digit code in
        the <code className="mono">X-MFA-Code</code> header. Read-only admin
        routes are not gated. Local single-user mode (no{" "}
        <code className="mono">SIGNALCLAW_ADMIN_KEY</code>) bypasses MFA so a
        fresh install can bootstrap.
      </p>

      {isLoading && <Loading />}
      {error && <ErrorBox err={error} />}
      {errMsg && <ErrorBox err={errMsg} />}
      {msg && (
        <div className="text-xs text-emerald-400 mb-4 inline-flex items-center gap-1.5">
          <Check size={14} weight="duotone" /> {msg}
        </div>
      )}

      {status && (
        <Card className="mb-6">
          <div className="text-xs muted mb-2">Status</div>
          <div className="text-sm space-y-1 mono">
            <div>key id: {status.key_id}</div>
            <div>enrolled: {enrolled ? "yes" : "no"}</div>
            <div>
              created:{" "}
              {status.created_at
                ? new Date(status.created_at).toLocaleString()
                : "n/a"}
            </div>
            <div>
              last verified:{" "}
              {status.last_verified_at
                ? new Date(status.last_verified_at).toLocaleString()
                : "never"}
            </div>
          </div>
        </Card>
      )}

      {!enrolled && !enrollment && (
        <Card className="mb-6">
          <div className="text-sm font-medium mb-2">Set up an authenticator</div>
          <p className="text-xs muted mb-3 max-w-prose">
            Generate a fresh secret, scan the QR with Google Authenticator,
            1Password, Authy, or any TOTP app, then verify a code to turn on
            enforcement.
          </p>
          <Button onClick={startEnroll} disabled={busy}>
            <QrCode size={14} weight="duotone" className="mr-1.5" />
            {busy ? "Generating..." : "Begin enrollment"}
          </Button>
        </Card>
      )}

      {enrollment && (
        <Card className="mb-6">
          <div className="text-sm font-medium mb-3">
            Scan, then enter a code to confirm
          </div>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <img
              src={googleQrUrl(enrollment.otpauth_uri)}
              alt="TOTP QR code"
              width={220}
              height={220}
              className="rounded border border-white/10 bg-white"
            />
            <div className="flex-1 min-w-0 space-y-3">
              <div>
                <div className="text-[11px] muted mb-1">
                  Secret (base32)
                </div>
                <div className="flex items-center gap-2">
                  <code className="mono text-xs break-all flex-1 px-2 py-1 rounded bg-white/5 border border-white/10">
                    {enrollment.secret_b32}
                  </code>
                  <Button onClick={copySecret} disabled={busy}>
                    {copied ? (
                      <Check size={14} weight="duotone" />
                    ) : (
                      <Copy size={14} weight="duotone" />
                    )}
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-[11px] muted mb-1">otpauth URI</div>
                <code className="mono text-[10px] break-all block px-2 py-1 rounded bg-white/5 border border-white/10">
                  {enrollment.otpauth_uri}
                </code>
              </div>
              <Field label="Verification code">
                <div className="flex gap-2">
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="123456"
                    className="mono"
                  />
                  <Button onClick={verify} disabled={busy || code.length !== 6}>
                    <ShieldCheck size={14} weight="duotone" className="mr-1.5" />
                    {busy ? "Verifying..." : "Verify"}
                  </Button>
                </div>
              </Field>
            </div>
          </div>
        </Card>
      )}

      {enrolled && (
        <Card>
          <div className="text-sm font-medium mb-2">Disable MFA</div>
          <p className="text-xs muted mb-3 max-w-prose">
            Disabling requires a current code so a stolen admin key cannot
            quietly turn MFA off. Disable only during planned device
            rotation, then re-enroll immediately.
          </p>
          <Field label="Current 6-digit code">
            <div className="flex gap-2">
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={disableCode}
                onChange={(e) =>
                  setDisableCode(e.target.value.replace(/\D/g, ""))
                }
                placeholder="123456"
                className="mono"
              />
              <Button
                onClick={disable}
                disabled={busy || disableCode.length !== 6}
              >
                <Trash size={14} weight="duotone" className="mr-1.5" />
                {busy ? "Disabling..." : "Disable"}
              </Button>
            </div>
          </Field>
        </Card>
      )}
    </main>
  );
}

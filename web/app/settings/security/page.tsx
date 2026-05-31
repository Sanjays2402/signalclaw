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
  recovery_codes_remaining: number;
};

type Enroll = {
  secret: string;
  otpauth_uri: string;
  algorithm: string;
  digits: number;
  period_seconds: number;
};

type ConfirmResult = {
  enrolled: boolean;
  recovery_codes: string[];
  recovery_codes_remaining: number;
};

type RegenResult = {
  recovery_codes: string[];
  recovery_codes_remaining: number;
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
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);

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
      const out = await api<ConfirmResult>("/mfa/confirm", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      setEnroll(null);
      setCode("");
      setMsg("MFA enrolled. Save your recovery codes before closing this page.");
      setRecoveryCodes(out.recovery_codes || []);
      setRecoveryAck(false);
      mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateRecovery() {
    if (!window.confirm("Replace your recovery codes? Any previously saved codes stop working immediately.")) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await api<RegenResult>("/mfa/recovery-codes/regenerate", {
        method: "POST",
      });
      setRecoveryCodes(out.recovery_codes || []);
      setRecoveryAck(false);
      setMsg("New recovery codes generated. Save them before closing this page.");
      mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  function downloadRecovery(codes: string[]) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const body =
      "SignalClaw MFA recovery codes\n" +
      `Generated: ${new Date().toISOString()}\n` +
      "Each code works exactly once. Keep them somewhere safe.\n\n" +
      codes.map((c, i) => `${(i + 1).toString().padStart(2, "0")}. ${c}`).join("\n") +
      "\n";
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `signalclaw-recovery-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

      {data?.enrolled && recoveryCodes === null && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Key size={20} weight="duotone" className="text-sky-500" />
              <h2 className="text-base font-semibold">Recovery codes</h2>
            </div>
            <p className="text-sm text-neutral-500">
              Single-use backup codes for the day your authenticator is
              unavailable. Send one as <code>x-mfa-recovery-code</code> to
              unlock any admin route.
            </p>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-medium">{data.recovery_codes_remaining}</span>
                <span className="text-neutral-500"> of 10 codes unused</span>
                {data.recovery_codes_remaining === 0 && (
                  <span className="ml-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    None left, regenerate now
                  </span>
                )}
                {data.recovery_codes_remaining > 0 && data.recovery_codes_remaining <= 3 && (
                  <span className="ml-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    Running low
                  </span>
                )}
              </div>
              <Button onClick={regenerateRecovery} disabled={busy}>
                Regenerate codes
              </Button>
            </div>
          </div>
        </Card>
      )}

      {recoveryCodes && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Key size={20} weight="duotone" className="text-sky-500" />
              <h2 className="text-base font-semibold">Save these recovery codes</h2>
            </div>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Shown once. Store them in a password manager or print and lock
              away. Each code works exactly one time. We only keep their
              SHA-256 hashes on the server.
            </p>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm">
              {recoveryCodes.map((c, i) => (
                <div
                  key={c}
                  className="flex items-center justify-between rounded border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <span className="text-neutral-400 select-none">{(i + 1).toString().padStart(2, "0")}</span>
                  <span>{c}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => copy(recoveryCodes.join("\n"))}>
                {copied ? <Check size={16} weight="duotone" /> : <Copy size={16} weight="duotone" />}
                Copy all
              </Button>
              <Button onClick={() => downloadRecovery(recoveryCodes)}>
                Download .txt
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={recoveryAck}
                  onChange={(e) => setRecoveryAck(e.target.checked)}
                />
                I saved these somewhere safe
              </label>
              <Button
                onClick={() => setRecoveryCodes(null)}
                disabled={!recoveryAck}
              >
                Done
              </Button>
            </div>
          </div>
        </Card>
      )}

      {data?.enrolled && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldWarning size={20} weight="duotone" className="text-rose-500" />
              <h2 className="text-base font-semibold">Use a recovery code</h2>
            </div>
            <p className="text-sm text-neutral-500">
              Lost your authenticator? Paste one unused recovery code below.
              It will be sent on your next admin action and burned on the
              server.
            </p>
            <RecoveryOneShot onPosted={() => setMsg("Recovery code queued. The next admin action will consume it.")} />
          </div>
        </Card>
      )}

      <CspLinkCard />
      <ResponseHeadersCard />
    </div>
  );
}

function CspLinkCard() {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} weight="duotone" className="text-sky-500" />
            <h2 className="text-base font-semibold">Content Security Policy</h2>
          </div>
          <p className="text-sm text-neutral-500 max-w-xl">
            Roll CSP out in report-only, watch the audit log for
            violations, then enforce. Per-workspace trusted hosts are
            configured separately from response headers.
          </p>
        </div>
        <a
          href="/settings/security/csp"
          className="text-sm underline decoration-dotted underline-offset-4 hover:text-white"
        >
          Open CSP settings
        </a>
      </div>
    </Card>
  );
}

type HeaderPolicy = {
  enabled: boolean;
  headers: Record<string, string>;
};

function ResponseHeadersCard() {
  const { data, error, isLoading } = useSWR<HeaderPolicy>(
    "/admin/security-headers",
    swrFetcher,
  );
  const required = [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
  ];
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} weight="duotone" className="text-emerald-500" />
          <h2 className="text-base font-semibold">Response headers</h2>
        </div>
        <p className="text-sm text-neutral-500">
          Stamped on every API response, including health checks and error
          payloads. Configure via SIGNALCLAW_HSTS_MAX_AGE, SIGNALCLAW_CSP,
          and SIGNALCLAW_SECURITY_HEADERS_ENABLED.
        </p>
        {isLoading && (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-9 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-900"
              />
            ))}
          </div>
        )}
        {error && <ErrorBox err={error} />}
        {data && data.enabled === false && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            Security headers are disabled. Set
            SIGNALCLAW_SECURITY_HEADERS_ENABLED=1 to re-enable.
          </div>
        )}
        {data && data.enabled && (
          <div className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {required.map((name) => {
              const value = data.headers[name];
              const present = typeof value === "string" && value.length > 0;
              return (
                <div
                  key={name}
                  className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="flex min-w-0 items-center gap-2 sm:w-72 sm:shrink-0">
                    <Badge tone={present ? "up" : "down"}>
                      {present ? "on" : "missing"}
                    </Badge>
                    <span className="truncate font-mono text-xs text-neutral-700 dark:text-neutral-300">
                      {name}
                    </span>
                  </div>
                  <code className="min-w-0 break-all rounded bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                    {present ? value : "not set"}
                  </code>
                </div>
              );
            })}
          </div>
        )}
        {data && data.enabled && data.headers && Object.keys(data.headers).length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-3 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No headers configured.
          </div>
        )}
      </div>
    </Card>
  );
}

function RecoveryOneShot({ onPosted }: { onPosted: () => void }) {
  const [val, setVal] = useState("");
  function queue() {
    const trimmed = val.trim().toUpperCase();
    if (!trimmed) return;
    if (typeof window !== "undefined") {
      sessionStorage.setItem("sc_mfa_recovery_code", trimmed);
    }
    setVal("");
    onPosted();
  }
  return (
    <div className="flex gap-2">
      <Input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="XXXXX-XXXXX"
        autoComplete="one-time-code"
        aria-label="Recovery code"
        className="font-mono"
      />
      <Button onClick={queue} disabled={!val.trim()}>
        Queue for next admin call
      </Button>
    </div>
  );
}

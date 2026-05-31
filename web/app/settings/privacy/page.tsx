"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
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
  Download,
  Trash,
  ShieldWarning,
  CheckCircle,
  WarningOctagon,
  FileLock,
  ArrowSquareOut,
} from "@phosphor-icons/react/dist/ssr";

type Plan = {
  willRemove: string[];
  willPreserve: string[];
};

type PreviewResp = {
  dry_run: true;
  options: { wipeCompliance?: boolean; wipeAudit?: boolean };
  plan: Plan;
};

type EraseSummary = {
  erased_at: string;
  removed: string[];
  preserved: string[];
  bytes_freed: number;
};

export default function PrivacyPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const [wipeCompliance, setWipeCompliance] = useState(false);
  const [wipeAudit, setWipeAudit] = useState(false);
  const previewKey = `/api/admin/privacy/delete?wipe_compliance=${wipeCompliance}&wipe_audit=${wipeAudit}`;
  const { data: preview, error: previewErr, isLoading } =
    useSWR<PreviewResp>(previewKey, swrFetcher);

  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<EraseSummary | null>(null);

  async function runExport() {
    setExportErr(null);
    setExporting(true);
    try {
      // Use plain fetch so we get the binary stream + filename header.
      const r = await fetch("/api/admin/privacy/export", {
        method: "GET",
        headers: {
          "x-api-key":
            typeof window !== "undefined"
              ? localStorage.getItem("sc_api_key") || ""
              : "",
        },
        cache: "no-store",
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `${r.status}`);
      }
      const disp = r.headers.get("content-disposition") || "";
      const m = disp.match(/filename="([^"]+)"/);
      const fname = m ? m[1] : "signalclaw-export.json";
      const blob = await r.blob();
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setExportErr(e?.message || "export failed");
    } finally {
      setExporting(false);
    }
  }

  async function runDelete() {
    setDeleteErr(null);
    setDeleteResult(null);
    setDeleting(true);
    try {
      const out = await api<EraseSummary>("/api/admin/privacy/delete", {
        method: "POST",
        body: JSON.stringify({
          confirm: confirmText,
          wipe_compliance: wipeCompliance,
          wipe_audit: wipeAudit,
        }),
      });
      setDeleteResult(out);
      setConfirmText("");
    } catch (e: any) {
      const msg =
        e instanceof ApiError
          ? safeMessage(e.body) || e.message
          : e?.message || "delete failed";
      setDeleteErr(msg);
    } finally {
      setDeleting(false);
    }
  }

  const confirmOk = confirmText === "DELETE";

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
          <span>/</span>
          <span>Privacy</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Privacy and data control
        </h1>
        <p className="text-sm text-neutral-500 max-w-2xl">
          Export everything we store about this workspace, or erase user data on
          request. Required for GDPR Article 17 and 20 and CCPA right-to-delete.
        </p>
      </header>

      <Card
        title="Export workspace data"
        right={
          <Badge tone="info">
            <FileLock weight="duotone" className="mr-1 inline h-3.5 w-3.5" />
            JSON
          </Badge>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-neutral-600">
            Bundles every record this workspace owns into a single JSON file:
            runs, watches, watchlist, alerts, settings, invites, webhook
            subscriptions, plus a copy of the audit log and API key metadata so
            you can verify what we keep about you. Admin scope required. The
            export action itself is recorded in the audit log.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={runExport} disabled={exporting}>
              <Download weight="duotone" className="mr-2 inline h-4 w-4" />
              {exporting ? "Building export" : "Download export"}
            </Button>
            <Link
              href="/settings/retention"
              className="text-sm text-neutral-500 inline-flex items-center hover:underline"
            >
              Retention policy
              <ArrowSquareOut className="ml-1 h-3.5 w-3.5" />
            </Link>
          </div>
          {exportErr && (
            <div className="text-sm text-rose-600">Export failed: {exportErr}</div>
          )}
        </div>
      </Card>

      <Card
        title="Erase workspace data"
        right={
          <Badge tone="down">
            <ShieldWarning weight="duotone" className="mr-1 inline h-3.5 w-3.5" />
            Destructive
          </Badge>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-neutral-600">
            Permanently removes user-generated state. Compliance stores (audit
            log, API keys, idempotency cache, delivery logs) are preserved by
            default to honour SOC2 retention. Opt in below to wipe them too. We
            cannot recover anything you erase here.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 p-3 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={wipeCompliance}
                onChange={(e) => setWipeCompliance(e.target.checked)}
              />
              <div>
                <div className="font-medium">Also wipe compliance stores</div>
                <div className="text-xs text-neutral-500">
                  API keys, idempotency cache, rate-limit counters, webhook
                  delivery log. Breaks ongoing SOC2 evidence.
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 p-3 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={wipeAudit}
                onChange={(e) => setWipeAudit(e.target.checked)}
              />
              <div>
                <div className="font-medium">Also wipe audit log</div>
                <div className="text-xs text-neutral-500">
                  Removes audit.jsonl and any rolled segment. Breaks the
                  tamper-evident hash chain.
                </div>
              </div>
            </label>
          </div>

          <PlanPanel
            loading={isLoading}
            err={previewErr}
            preview={preview}
          />

          <div className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50/60 dark:bg-rose-950/30 p-4 space-y-3">
            <div className="flex items-start gap-2 text-rose-700 dark:text-rose-300 text-sm">
              <WarningOctagon weight="duotone" className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                Type <code className="font-mono">DELETE</code> to confirm. There
                is no undo.
              </div>
            </div>
            <Field label="Confirmation">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                aria-label="Type DELETE to confirm"
                autoCapitalize="characters"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button
                onClick={runDelete}
                disabled={!confirmOk || deleting}
                variant="danger"
              >
                <Trash weight="duotone" className="mr-2 inline h-4 w-4" />
                {deleting ? "Erasing" : "Erase data"}
              </Button>
              {!confirmOk && (
                <span className="text-xs text-neutral-500">
                  Type DELETE to enable.
                </span>
              )}
            </div>
            {deleteErr && (
              <div className="text-sm text-rose-600">Failed: {deleteErr}</div>
            )}
            {deleteResult && (
              <div className="rounded-md border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm text-emerald-800 dark:text-emerald-200">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle weight="duotone" className="h-4 w-4" />
                  Erased {deleteResult.removed.length} file(s),{" "}
                  {deleteResult.bytes_freed.toLocaleString()} bytes freed.
                </div>
                <div className="mt-1 text-xs">
                  Preserved {deleteResult.preserved.length} file(s):{" "}
                  {deleteResult.preserved.join(", ") || "(none)"}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </main>
  );
}

function PlanPanel({
  loading,
  err,
  preview,
}: {
  loading: boolean;
  err: unknown;
  preview: PreviewResp | undefined;
}) {
  if (loading) return <Loading label="Calculating impact" />;
  if (err) return <ErrorBox err={err} />;
  if (!preview) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-md border border-rose-200 dark:border-rose-900/50 p-3">
        <div className="text-xs font-medium text-rose-700 dark:text-rose-300 uppercase tracking-wide">
          Will remove ({preview.plan.willRemove.length})
        </div>
        <ul className="mt-2 space-y-0.5 text-xs font-mono text-neutral-600 dark:text-neutral-400">
          {preview.plan.willRemove.length === 0 && <li>(none)</li>}
          {preview.plan.willRemove.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <div className="rounded-md border border-emerald-200 dark:border-emerald-900/50 p-3">
        <div className="text-xs font-medium text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
          Will preserve ({preview.plan.willPreserve.length})
        </div>
        <ul className="mt-2 space-y-0.5 text-xs font-mono text-neutral-600 dark:text-neutral-400">
          {preview.plan.willPreserve.length === 0 && <li>(none)</li>}
          {preview.plan.willPreserve.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function safeMessage(raw: string): string | null {
  try {
    const j = JSON.parse(raw);
    if (j?.error?.message) return String(j.error.message);
  } catch { /* not JSON */ }
  return null;
}

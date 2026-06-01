"use client";
// Evidence pack download surface.
//
// Procurement reality: when an auditor or prospect asks "send us proof
// you have controls X, Y, Z" the security owner needs one button that
// produces a single file they can attach to email. The bundle is built
// on demand by /api/admin/evidence-pack so it always reflects current
// policy values; we never cache a stale pack on disk.
//
// HEAD is fired on mount so the page can render the size + SHA-256
// without the user paying the download cost. The Download button
// itself uses the underlying GET, which is the call that writes an
// audit record + the bundle hash to the tamper-evident chain.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Button, Badge } from "@/components/ui";
import {
  ShieldCheck,
  DownloadSimple,
  FileLock,
  ArrowsClockwise,
  Warning,
  ArrowLeft,
} from "@phosphor-icons/react/dist/ssr";

type PackInfo = {
  filename: string;
  size: number;
  sha256: string;
  generated_at: string;
};

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const ENDPOINT = "/api/admin/evidence-pack";

export default function EvidencePackPage() {
  const [info, setInfo] = useState<PackInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(ENDPOINT, { method: "HEAD", cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) throw new Error("Admin scope required to generate evidence packs.");
        throw new Error(`Preview failed (${res.status}).`);
      }
      const size = Number(res.headers.get("content-length") ?? "0");
      const sha256 = res.headers.get("x-evidence-pack-sha256") ?? "";
      const generated_at = res.headers.get("x-evidence-pack-generated-at") ?? new Date().toISOString();
      const filename = res.headers.get("x-evidence-pack-filename") ?? "signalclaw-evidence.zip";
      setInfo({ filename, size, sha256, generated_at });
    } catch (e: any) {
      setErr(e?.message ?? "preview failed");
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const download = useCallback(async () => {
    setDownloading(true);
    setErr(null);
    try {
      const res = await fetch(ENDPOINT, { method: "GET", cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) throw new Error("Admin scope required.");
        throw new Error(`Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const filename = res.headers.get("x-evidence-pack-filename")
        || (res.headers.get("content-disposition") ?? "")
            .match(/filename="?([^";]+)"?/)?.[1]
        || info?.filename
        || "signalclaw-evidence.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // Re-preview so the displayed generated_at matches what's on disk.
      refresh();
    } catch (e: any) {
      setErr(e?.message ?? "download failed");
    } finally {
      setDownloading(false);
    }
  }, [info, refresh]);

  return (
    <AuthGate>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <Link
          href="/settings"
          className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5 mb-4"
        >
          <ArrowLeft size={12} weight="duotone" /> Back to settings
        </Link>
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FileLock size={22} weight="duotone" className="text-emerald-400" />
            SOC2 evidence pack
          </h1>
          <p className="text-sm text-zinc-400 mt-2">
            One signed archive that captures every workspace control, policy value, audit chain
            verification, key inventory and active session at the moment you click Download.
            Hand this to an external auditor or attach it to a vendor security questionnaire.
          </p>
        </header>

        {loading ? <Loading label="Preparing pack preview" /> : null}
        {err ? <ErrorBox err={err} /> : null}

        {info ? (
          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Pack file</div>
                <div className="font-mono text-sm text-zinc-100 break-all">{info.filename}</div>
                <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-zinc-500">Size</div>
                    <div className="text-zinc-200">{fmtBytes(info.size)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-zinc-500">Built at</div>
                    <div className="text-zinc-200">{fmtTime(info.generated_at)}</div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-xs uppercase tracking-wide text-zinc-500">SHA-256</div>
                    <div className="font-mono text-xs text-zinc-300 break-all">{info.sha256}</div>
                  </div>
                </div>
                <div className="mt-3">
                  <Badge tone="up">
                    <ShieldCheck size={12} weight="duotone" />
                    <span className="ml-1">Deterministic, manifest signed</span>
                  </Badge>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                <Button onClick={download} disabled={downloading} aria-label="Download evidence pack">
                  <DownloadSimple size={14} weight="duotone" />
                  <span className="ml-1">{downloading ? "Building" : "Download"}</span>
                </Button>
                <button
                  type="button"
                  onClick={refresh}
                  className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
                >
                  <ArrowsClockwise size={12} weight="duotone" /> Refresh preview
                </button>
              </div>
            </div>
          </Card>
        ) : null}

        <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Inside the archive</div>
            <ul className="text-sm text-zinc-300 space-y-1.5">
              <li>README.md and manifest.json with SHA-256 of every file</li>
              <li>controls-inventory.json with status of every control</li>
              <li>audit-chain-verification.json proving the audit log is intact</li>
              <li>keys.json (no secrets) and sessions.json (no tokens)</li>
              <li>policies/ for SSO, network, CORS, CSP, retention, rotation, egress, residency, lockout, concurrency, freeze, SIEM, holds, defaults</li>
            </ul>
          </Card>
          <Card>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Verify after handoff</div>
            <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed">{`unzip evidence-pack.zip -d pack/
cd pack
jq -r '.files[] | "\\(.sha256)  \\(.name)"' \\
  manifest.json | shasum -a 256 -c`}</pre>
            <p className="text-xs text-zinc-500 mt-2 flex items-start gap-1">
              <Warning size={12} weight="duotone" className="mt-0.5 text-amber-400" />
              <span>Each download is audit-logged with the bundle SHA-256 so a later check can prove which pack the recipient was sent.</span>
            </p>
          </Card>
        </section>
      </main>
    </AuthGate>
  );
}

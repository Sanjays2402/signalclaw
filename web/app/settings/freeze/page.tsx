"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Snowflake,
  Warning,
  ShieldCheck,
  LockKey,
} from "@phosphor-icons/react/dist/ssr";

type FreezeState = {
  frozen: boolean;
  reason: string | null;
  frozen_at: string | null;
  frozen_by: string | null;
  unfrozen_at: string | null;
  unfrozen_by: string | null;
  max_reason_len: number;
};

export default function FreezePage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<FreezeState>(
    "/admin/freeze",
    swrFetcher,
  );
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data && !data.frozen) setReason("");
  }, [data]);

  if (isLoading) return <Loading label="Loading freeze state" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const maxLen = data.max_reason_len ?? 500;
  const canFreeze = reason.trim().length > 0 && confirm.trim() === "FREEZE";

  async function doFreeze() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await api("/admin/freeze", {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setOk("Workspace frozen. All v1 API calls now return 503.");
      setConfirm("");
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUnfreeze() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await api("/admin/freeze", { method: "DELETE" });
      setOk("Workspace unfrozen. v1 API restored.");
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <Snowflake size={28} weight="duotone" className="mt-1 text-sky-500" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Emergency workspace freeze
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Instantly halt every authenticated /api/v1 call for this
            workspace. Admin routes stay reachable so you can unfreeze.
            Every change is recorded in the audit log.
          </p>
        </div>
      </header>

      <Card>
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            {data.frozen ? (
              <Badge tone="down">
                <Warning size={14} weight="duotone" />
                <span className="ml-1">Frozen</span>
              </Badge>
            ) : (
              <Badge tone="up">
                <ShieldCheck size={14} weight="duotone" />
                <span className="ml-1">Active</span>
              </Badge>
            )}
            <span className="text-sm text-neutral-500">
              {data.frozen
                ? `Since ${data.frozen_at ?? "unknown"}`
                : data.unfrozen_at
                  ? `Last unfrozen ${data.unfrozen_at}`
                  : "Never frozen"}
            </span>
          </div>
          {data.frozen && data.reason ? (
            <span className="max-w-md truncate text-sm text-neutral-400">
              {data.reason}
            </span>
          ) : null}
        </div>
      </Card>

      {err ? <ErrorBox err={err} /> : null}
      {ok ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-500">
          {ok}
        </div>
      ) : null}

      {data.frozen ? (
        <Card>
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <LockKey size={16} weight="duotone" />
              Unfreeze workspace
            </div>
            <p className="text-sm text-neutral-500">
              Resume normal /api/v1 traffic. The freeze and unfreeze events
              both remain in the audit log.
            </p>
            <div className="flex justify-end">
              <Button onClick={doUnfreeze} disabled={busy}>
                {busy ? "Unfreezing..." : "Unfreeze workspace"}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Warning size={16} weight="duotone" className="text-amber-500" />
              Freeze workspace
            </div>
            <p className="text-sm text-neutral-500">
              Every authenticated /api/v1 call will return 503 with a
              workspace_frozen error and an x-workspace-frozen: 1 header.
              Health, metrics, and admin routes stay reachable.
            </p>
            <Field label={`Reason (required, max ${maxLen} chars)`}>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, maxLen))}
                rows={3}
                placeholder="Suspected credential leak in CI logs; rotating keys."
                className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </Field>
            <Field label="Type FREEZE to confirm">
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="FREEZE"
                className="w-full rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </Field>
            <div className="flex justify-end">
              <Button
                onClick={doFreeze}
                disabled={!canFreeze || busy}
                variant="danger"
              >
                {busy ? "Freezing..." : "Freeze workspace"}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

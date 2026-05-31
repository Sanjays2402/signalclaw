"use client";
import { useMemo, useState } from "react";
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
  Scales,
  LockOpen,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr";

type Scope = "runs" | "audit" | "webhook_deliveries" | "user_data";

type Hold = {
  id: string;
  matter: string;
  reason: string;
  scopes: Scope[];
  opened_at: string;
  opened_by: string;
  released_at: string | null;
  released_by: string | null;
  released_reason: string | null;
};

type ListResponse = { holds: Hold[]; available_scopes: Scope[] };

const SCOPE_LABEL: Record<Scope, string> = {
  runs: "Run history",
  audit: "Audit log",
  webhook_deliveries: "Webhook deliveries",
  user_data: "All user data",
};

export default function LegalHoldPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(
    "/admin/legal-hold",
    swrFetcher,
  );

  const [matter, setMatter] = useState("");
  const [reason, setReason] = useState("");
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(["runs", "audit"]));
  const [busy, setBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const active = useMemo(
    () => (data?.holds || []).filter((h) => h.released_at === null),
    [data],
  );
  const past = useMemo(
    () => (data?.holds || []).filter((h) => h.released_at !== null),
    [data],
  );

  function toggleScope(s: Scope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function open() {
    setOpErr(null);
    setOpOk(null);
    if (matter.trim().length < 1) {
      setOpErr("Matter name is required.");
      return;
    }
    if (scopes.size === 0) {
      setOpErr("Pick at least one scope.");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/legal-hold", {
        method: "POST",
        body: JSON.stringify({
          matter: matter.trim(),
          reason: reason.trim(),
          scopes: Array.from(scopes),
        }),
      });
      setMatter("");
      setReason("");
      setOpOk("Legal hold opened. Retention sweeps and deletes are now blocked for the selected scopes.");
      await mutate();
    } catch (e) {
      if (e instanceof ApiError) setOpErr(extractMessage(e));
      else setOpErr("Unable to open hold.");
    } finally {
      setBusy(false);
    }
  }

  async function release(h: Hold) {
    setOpErr(null);
    setOpOk(null);
    const why = window.prompt(
      `Release "${h.matter}"? Document why counsel cleared the hold (min 4 chars):`,
      "",
    );
    if (why === null) return;
    if (why.trim().length < 4) {
      setOpErr("Release reason must be at least 4 characters.");
      return;
    }
    setBusy(true);
    try {
      await api(`/admin/legal-hold?id=${encodeURIComponent(h.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ released_reason: why.trim() }),
      });
      setOpOk(`Hold "${h.matter}" released.`);
      await mutate();
    } catch (e) {
      if (e instanceof ApiError) setOpErr(extractMessage(e));
      else setOpErr("Unable to release hold.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
      <div className="mb-6 flex items-center gap-3">
        <Scales weight="duotone" className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold">Legal hold</h1>
          <p className="text-sm text-zinc-500">
            Suspend automated deletion of workspace data while a matter is open. Active holds block the retention sweep and the privacy hard-delete.
          </p>
        </div>
      </div>

      <Card className="mb-6" title="Open a new hold">
        <div className="grid gap-4">
          <Field label="Matter">
            <Input
              value={matter}
              onChange={(e) => setMatter(e.target.value)}
              placeholder="e.g. Case 24-CV-1183 (Acme v. Doe)"
              maxLength={200}
              disabled={busy}
            />
          </Field>
          <Field label="Reason / counsel note">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Short description of the matter and instructing counsel."
              maxLength={1000}
              rows={3}
              disabled={busy}
              className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <fieldset>
            <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Scopes
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["runs", "audit", "webhook_deliveries", "user_data"] as Scope[]).map(
                (s) => (
                  <label
                    key={s}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 p-2 text-sm hover:border-amber-400 dark:border-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={scopes.has(s)}
                      onChange={() => toggleScope(s)}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">{SCOPE_LABEL[s]}</span>
                      <span className="block text-xs text-zinc-500">{scopeBlurb(s)}</span>
                    </span>
                  </label>
                ),
              )}
            </div>
          </fieldset>
          {opErr ? <ErrorBox err={opErr} /> : null}
          {opOk ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">
              <CheckCircle weight="duotone" className="h-4 w-4" />
              <span>{opOk}</span>
            </div>
          ) : null}
          <div>
            <Button onClick={open} disabled={busy}>
              {busy ? "Working..." : "Open hold"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mb-6" title={`Active holds (${active.length})`}>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorBox err={error} />
        ) : active.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No active holds. Retention and erase run normally.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {active.map((h) => (
              <li key={h.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{h.matter}</span>
                    {h.scopes.map((s) => (
                      <Badge key={s}>{SCOPE_LABEL[s]}</Badge>
                    ))}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Opened {fmtDate(h.opened_at)} by {h.opened_by}
                  </div>
                  {h.reason ? (
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                      {h.reason}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0">
                  <Button onClick={() => release(h)} disabled={busy}>
                    <LockOpen weight="duotone" className="mr-1 inline h-4 w-4" />
                    Release
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`History (${past.length})`}>
        {past.length === 0 ? (
          <div className="text-sm text-zinc-500">No released holds yet.</div>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {past.map((h) => (
              <li key={h.id} className="py-3 text-sm">
                <div className="font-medium">{h.matter}</div>
                <div className="text-xs text-zinc-500">
                  {fmtDate(h.opened_at)} to {fmtDate(h.released_at)} ({h.scopes.join(", ")})
                </div>
                {h.released_reason ? (
                  <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                    Released by {h.released_by}: {h.released_reason}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6 text-xs text-zinc-500">
        <Link href="/settings" className="underline">
          Back to settings
        </Link>
      </div>
    </main>
  );
}

function scopeBlurb(s: Scope): string {
  switch (s) {
    case "runs":
      return "Pins run history. Retention sweep skips runs.";
    case "audit":
      return "Pins the audit log. wipe_audit erase is blocked.";
    case "webhook_deliveries":
      return "Pins outbound webhook delivery records.";
    case "user_data":
      return "Pins every user-category store. All hard-deletes blocked.";
  }
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function extractMessage(e: ApiError): string {
  try {
    const j = JSON.parse(e.body);
    return j?.error?.message || e.message;
  } catch {
    return e.message;
  }
}

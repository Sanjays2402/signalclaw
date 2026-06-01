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
  FileLock,
  CheckCircle,
  Warning,
  ArrowSquareOut,
  Signature,
} from "@phosphor-icons/react/dist/ssr";

type DpaVersion = {
  version: string;
  effective_date: string;
  url: string;
  sha256: string;
};

type Acceptance = {
  id: string;
  action: "accepted" | "withdrawn";
  dpa_version: string;
  dpa_sha256: string;
  dpa_url: string;
  accepted_at: string;
  actor_id: string;
  actor_email: string | null;
  signatory_name: string;
  signatory_title: string;
  customer_entity: string;
  ip_hash: string | null;
  user_agent: string | null;
  note: string;
};

type State = {
  current: DpaVersion;
  active: Acceptance | null;
  needs_re_acceptance: boolean;
  acceptances: Acceptance[];
};

export default function DpaPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<State>(
    "/admin/dpa",
    swrFetcher,
  );

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [entity, setEntity] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const history = useMemo(() => data?.acceptances ?? [], [data]);

  async function submit() {
    setOpErr(null);
    setOpOk(null);
    if (name.trim().length < 2) {
      setOpErr("Signatory name is required.");
      return;
    }
    if (title.trim().length < 1) {
      setOpErr("Signatory title is required.");
      return;
    }
    if (entity.trim().length < 1) {
      setOpErr("Customer legal entity is required.");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/dpa", {
        method: "POST",
        body: JSON.stringify({
          signatory_name: name.trim(),
          signatory_title: title.trim(),
          customer_entity: entity.trim(),
          note: note.trim(),
        }),
      });
      setName("");
      setTitle("");
      setEntity("");
      setNote("");
      setOpOk(
        "DPA acceptance recorded. The pinned document hash and signatory are now in the audit chain.",
      );
      await mutate();
    } catch (e) {
      if (e instanceof ApiError) setOpErr(extractMessage(e));
      else setOpErr("Unable to record acceptance.");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setOpErr(null);
    setOpOk(null);
    const why = window.prompt(
      "Withdraw the current DPA acceptance? Counsel-facing reason (min 4 chars):",
      "",
    );
    if (why === null) return;
    if (why.trim().length < 4) {
      setOpErr("Withdrawal reason must be at least 4 characters.");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/dpa", {
        method: "DELETE",
        body: JSON.stringify({ reason: why.trim() }),
      });
      setOpOk("DPA acceptance withdrawn. A new acceptance is required to keep using the service.");
      await mutate();
    } catch (e) {
      if (e instanceof ApiError) setOpErr(extractMessage(e));
      else setOpErr("Unable to withdraw acceptance.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
      <div className="mb-6 flex items-center gap-3">
        <FileLock weight="duotone" className="h-7 w-7 text-sky-500" />
        <div>
          <h1 className="text-2xl font-semibold">Data Processing Agreement</h1>
          <p className="text-sm text-zinc-400">
            Versioned acceptance ledger for procurement, audit, and counsel.
          </p>
        </div>
      </div>

      <p className="mb-6 text-[13px] text-zinc-400">
        Every acceptance pins the DPA version and SHA-256 hash at the moment
        you accept, alongside the signatory, customer entity, and a hashed
        client IP. Records are append-only and surfaced inside the SOC2
        evidence pack so auditors can confirm DPA coverage without a back
        and forth.
      </p>

      {isLoading ? <Loading /> : null}
      {error ? <ErrorBox err={error} /> : null}

      {data ? (
        <>
          <Card className="mb-6">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-base font-medium">Current DPA</h2>
              <Badge>v{data.current.version}</Badge>
              <span className="text-xs text-zinc-500">
                effective {data.current.effective_date}
              </span>
              {data.needs_re_acceptance ? (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400">
                  <Warning weight="duotone" className="h-3.5 w-3.5" />
                  Action required
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">
                  <CheckCircle weight="duotone" className="h-3.5 w-3.5" />
                  Accepted
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 text-[12px] text-zinc-400 sm:grid-cols-2">
              <div>
                <span className="text-zinc-500">Document </span>
                <a
                  className="inline-flex items-center gap-1 text-sky-400 hover:underline"
                  href={data.current.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {data.current.url} <ArrowSquareOut className="h-3 w-3" />
                </a>
              </div>
              <div>
                <span className="text-zinc-500">SHA-256 </span>
                <code className="break-all font-mono text-[11px] text-zinc-300">
                  {data.current.sha256}
                </code>
              </div>
            </div>
            {data.active ? (
              <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3 text-[12px]">
                <div className="text-zinc-400">
                  Accepted by{" "}
                  <span className="text-zinc-200">{data.active.signatory_name}</span>
                  {data.active.signatory_title ? (
                    <span className="text-zinc-500"> ({data.active.signatory_title})</span>
                  ) : null}{" "}
                  on behalf of{" "}
                  <span className="text-zinc-200">{data.active.customer_entity}</span>
                </div>
                <div className="mt-1 text-zinc-500">
                  {new Date(data.active.accepted_at).toLocaleString()} via key{" "}
                  <code className="font-mono text-[11px]">{data.active.actor_id}</code>
                  {data.active.ip_hash ? (
                    <>
                      {" "}
                      ip{" "}
                      <code className="font-mono text-[11px]">
                        {data.active.ip_hash.slice(0, 12)}
                      </code>
                    </>
                  ) : null}
                </div>
                {data.active.dpa_version !== data.current.version ? (
                  <div className="mt-2 text-amber-400">
                    Active acceptance is for v{data.active.dpa_version}. Re-accept
                    v{data.current.version} to remain in compliance.
                  </div>
                ) : null}
                <div className="mt-3">
                  <Button onClick={withdraw} disabled={busy} variant="ghost">
                    Withdraw acceptance
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-300">
                No active DPA acceptance on file. Use the form below to record
                one before sharing this with procurement.
              </div>
            )}
          </Card>

          <Card className="mb-6">
            <div className="mb-3 flex items-center gap-2">
              <Signature weight="duotone" className="h-5 w-5 text-sky-400" />
              <h2 className="text-base font-medium">
                Accept v{data.current.version}
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Signatory name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Maria Chen"
                  maxLength={200}
                />
              </Field>
              <Field label="Signatory title">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Head of Security"
                  maxLength={200}
                />
              </Field>
              <Field label="Customer legal entity">
                <Input
                  value={entity}
                  onChange={(e) => setEntity(e.target.value)}
                  placeholder="e.g. Acme Capital Holdings, Inc."
                  maxLength={200}
                />
              </Field>
              <Field label="Internal note (optional)">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="MSA reference, counsel review id, etc."
                  maxLength={1000}
                />
              </Field>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={submit} disabled={busy}>
                Record acceptance
              </Button>
              <span className="text-[11px] text-zinc-500">
                Clicking records the current pinned document hash against your admin identity.
              </span>
            </div>
            {opErr ? (
              <p className="mt-3 text-[12px] text-rose-400">{opErr}</p>
            ) : null}
            {opOk ? (
              <p className="mt-3 text-[12px] text-emerald-400">{opOk}</p>
            ) : null}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-medium">Acceptance history</h2>
            {history.length === 0 ? (
              <p className="text-[12px] text-zinc-500">
                No acceptances recorded yet. The form above writes the first row.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {history.map((row) => (
                  <li key={row.id} className="py-3 text-[12px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>
                        {row.action === "withdrawn" ? "withdrawn" : "accepted"}
                      </Badge>
                      <span className="text-zinc-200">v{row.dpa_version}</span>
                      <span className="text-zinc-500">
                        {new Date(row.accepted_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1 text-zinc-400">
                      {row.signatory_name}
                      {row.signatory_title ? (
                        <span className="text-zinc-500"> ({row.signatory_title})</span>
                      ) : null}
                      {row.customer_entity ? (
                        <>
                          {" "}for{" "}
                          <span className="text-zinc-300">{row.customer_entity}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-1 text-zinc-500">
                      via{" "}
                      <code className="font-mono text-[11px]">{row.actor_id}</code>
                      {row.ip_hash ? (
                        <>
                          {" "}ip{" "}
                          <code className="font-mono text-[11px]">
                            {row.ip_hash.slice(0, 12)}
                          </code>
                        </>
                      ) : null}
                      {" "}sha{" "}
                      <code className="font-mono text-[11px]">
                        {row.dpa_sha256.slice(0, 12)}
                      </code>
                    </div>
                    {row.note ? (
                      <div className="mt-1 text-zinc-400">Note: {row.note}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="mt-6 text-[11px] text-zinc-500">
            See also{" "}
            <Link href="/settings/subprocessors" className="text-sky-400 hover:underline">
              subprocessor registry
            </Link>{" "}
            and{" "}
            <Link href="/settings/evidence-pack" className="text-sky-400 hover:underline">
              SOC2 evidence pack
            </Link>
            . The DPA ledger is exported inside the evidence pack zip.
          </p>
        </>
      ) : null}
    </main>
  );
}

function extractMessage(e: ApiError): string {
  const body = e.body as any;
  if (body && typeof body === "object" && body.error) {
    if (typeof body.error.message === "string") return body.error.message;
    if (typeof body.error.code === "string") return body.error.code;
  }
  return e.message || "Request failed.";
}

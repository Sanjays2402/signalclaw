"use client";
import { useMemo, useState } from "react";
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
  Clock,
  CurrencyDollar,
  Warning,
  CheckCircle,
} from "@phosphor-icons/react/dist/ssr";

type Severity = "sev1" | "sev2" | "sev3" | "sev4";

type Commitment = {
  version: number;
  effective_at: string;
  published_by: string;
  published_by_email: string | null;
  uptime_target_bps: number;
  response_targets: Record<Severity, number>;
  credit_ladder: { below_uptime_bps: number; credit_pct: number }[];
  notes: string;
  notes_sha256: string;
  contacts: {
    support_email: string;
    status_page_url: string | null;
    security_email: string | null;
  };
};

type State = { current: Commitment | null; history: Commitment[] };

function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}

function extractMessage(e: ApiError): string {
  const body: any = e.body;
  return body?.error?.message ?? e.message ?? "Request failed.";
}

const DEFAULT_FORM = {
  uptime_pct: "99.95",
  sev1: 15,
  sev2: 60,
  sev3: 240,
  sev4: 1440,
  ladder: [
    { below_pct: "99.00", credit_pct: 25 },
    { below_pct: "95.00", credit_pct: 50 },
    { below_pct: "90.00", credit_pct: 100 },
  ],
  notes:
    "Scheduled maintenance window Sunday 02:00-04:00 UTC. Excludes force majeure and customer-side network outages.",
  support_email: "",
  status_page_url: "",
  security_email: "",
};

function pctToBps(pct: string): number | null {
  const f = Number(pct);
  if (!Number.isFinite(f)) return null;
  const bps = Math.round(f * 100);
  return bps;
}

export default function SlaPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<State>(
    "/admin/sla",
    swrFetcher,
  );

  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [busy, setBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const history = useMemo(() => data?.history ?? [], [data]);

  async function publish() {
    setOpErr(null);
    setOpOk(null);
    const uptime_bps = pctToBps(form.uptime_pct);
    if (uptime_bps == null) {
      setOpErr("Uptime target must be a percentage like 99.95.");
      return;
    }
    const ladder = form.ladder.map((row) => ({
      below_uptime_bps: pctToBps(row.below_pct) ?? 0,
      credit_pct: Number(row.credit_pct),
    }));
    setBusy(true);
    try {
      await api("/admin/sla", {
        method: "POST",
        body: JSON.stringify({
          uptime_target_bps: uptime_bps,
          response_targets: {
            sev1: Number(form.sev1),
            sev2: Number(form.sev2),
            sev3: Number(form.sev3),
            sev4: Number(form.sev4),
          },
          credit_ladder: ladder,
          notes: form.notes,
          support_email: form.support_email.trim(),
          status_page_url: form.status_page_url.trim() || null,
          security_email: form.security_email.trim() || null,
        }),
      });
      setOpOk("SLA published. Previous version is preserved in history.");
      await mutate();
    } catch (e) {
      if (e instanceof ApiError) setOpErr(extractMessage(e));
      else setOpErr("Unable to publish SLA.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
      <div className="mb-6 flex items-center gap-3">
        <ShieldCheck weight="duotone" className="h-7 w-7 text-sky-500" />
        <div>
          <h1 className="text-2xl font-semibold">Service Level Agreement</h1>
          <p className="text-sm text-zinc-400">
            Versioned uptime, response time, and credit commitments for procurement.
          </p>
        </div>
      </div>

      <p className="mb-6 text-[13px] text-zinc-400">
        Publishing pins a new SLA version with a hashed notes document.
        Previous versions remain in history so a customer or auditor can
        prove which SLA was in force on any given date. Pair this with the
        SOC2 evidence pack and audit log for a defensible commitment record.
      </p>

      {isLoading ? <Loading /> : null}
      {error ? <ErrorBox err={error} /> : null}

      {data ? (
        <>
          <Card className="mb-6">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-base font-medium">Current commitment</h2>
              {data.current ? (
                <>
                  <Badge>v{data.current.version}</Badge>
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">
                    <CheckCircle weight="duotone" className="h-3.5 w-3.5" />
                    Published
                  </span>
                </>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400">
                  <Warning weight="duotone" className="h-3.5 w-3.5" />
                  No SLA published yet
                </span>
              )}
            </div>
            {data.current ? (
              <div className="grid grid-cols-1 gap-3 text-[12px] text-zinc-400 sm:grid-cols-2">
                <div>
                  <span className="text-zinc-500">Monthly uptime target </span>
                  <span className="text-zinc-200">{bpsToPct(data.current.uptime_target_bps)}%</span>
                </div>
                <div>
                  <span className="text-zinc-500">Effective </span>
                  <span className="text-zinc-200">
                    {new Date(data.current.effective_at).toLocaleString()}
                  </span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-zinc-500">Initial response targets </span>
                  <span className="text-zinc-200">
                    sev1 {data.current.response_targets.sev1}m, sev2{" "}
                    {data.current.response_targets.sev2}m, sev3{" "}
                    {data.current.response_targets.sev3}m, sev4{" "}
                    {data.current.response_targets.sev4}m
                  </span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-zinc-500">Credit ladder </span>
                  <ul className="mt-1 space-y-0.5">
                    {data.current.credit_ladder.map((t) => (
                      <li key={t.below_uptime_bps} className="text-zinc-300">
                        below {bpsToPct(t.below_uptime_bps)}% &rarr; {t.credit_pct}% credit
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className="text-zinc-500">Support </span>
                  <span className="text-zinc-200">{data.current.contacts.support_email}</span>
                </div>
                {data.current.contacts.status_page_url ? (
                  <div>
                    <span className="text-zinc-500">Status page </span>
                    <a
                      className="text-sky-400 hover:underline"
                      href={data.current.contacts.status_page_url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {data.current.contacts.status_page_url}
                    </a>
                  </div>
                ) : null}
                {data.current.contacts.security_email ? (
                  <div>
                    <span className="text-zinc-500">Security </span>
                    <span className="text-zinc-200">{data.current.contacts.security_email}</span>
                  </div>
                ) : null}
                <div className="sm:col-span-2">
                  <span className="text-zinc-500">Notes sha256 </span>
                  <code className="break-all font-mono text-[11px] text-zinc-300">
                    {data.current.notes_sha256}
                  </code>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-zinc-500">Notes </span>
                  <p className="mt-1 whitespace-pre-wrap text-zinc-300">{data.current.notes}</p>
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-zinc-500">
                Publish the first SLA below. Procurement teams routinely block
                signature without a written uptime and response time commitment.
              </p>
            )}
          </Card>

          <Card className="mb-6">
            <div className="mb-3 flex items-center gap-2">
              <Clock weight="duotone" className="h-5 w-5 text-sky-400" />
              <h2 className="text-base font-medium">
                Publish v{(data.current?.version ?? 0) + 1}
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Monthly uptime target (%)">
                <Input
                  value={form.uptime_pct}
                  onChange={(e) => setForm({ ...form, uptime_pct: e.target.value })}
                  placeholder="99.95"
                  inputMode="decimal"
                />
              </Field>
              <Field label="Support email">
                <Input
                  value={form.support_email}
                  onChange={(e) => setForm({ ...form, support_email: e.target.value })}
                  placeholder="support@acme.example"
                />
              </Field>
              <Field label="Sev1 response (minutes)">
                <Input
                  value={String(form.sev1)}
                  onChange={(e) => setForm({ ...form, sev1: Number(e.target.value) })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Sev2 response (minutes)">
                <Input
                  value={String(form.sev2)}
                  onChange={(e) => setForm({ ...form, sev2: Number(e.target.value) })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Sev3 response (minutes)">
                <Input
                  value={String(form.sev3)}
                  onChange={(e) => setForm({ ...form, sev3: Number(e.target.value) })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Sev4 response (minutes)">
                <Input
                  value={String(form.sev4)}
                  onChange={(e) => setForm({ ...form, sev4: Number(e.target.value) })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Status page URL (https, optional)">
                <Input
                  value={form.status_page_url}
                  onChange={(e) => setForm({ ...form, status_page_url: e.target.value })}
                  placeholder="https://status.acme.example"
                />
              </Field>
              <Field label="Security email (optional)">
                <Input
                  value={form.security_email}
                  onChange={(e) => setForm({ ...form, security_email: e.target.value })}
                  placeholder="security@acme.example"
                />
              </Field>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center gap-2 text-[12px] text-zinc-400">
                <CurrencyDollar weight="duotone" className="h-4 w-4 text-sky-400" />
                Credit ladder (each row: below uptime % &rarr; credit %)
              </div>
              <div className="space-y-2">
                {form.ladder.map((row, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <Input
                      value={row.below_pct}
                      onChange={(e) => {
                        const next = [...form.ladder];
                        next[i] = { ...row, below_pct: e.target.value };
                        setForm({ ...form, ladder: next });
                      }}
                      placeholder="99.00"
                      inputMode="decimal"
                    />
                    <Input
                      value={String(row.credit_pct)}
                      onChange={(e) => {
                        const next = [...form.ladder];
                        next[i] = { ...row, credit_pct: Number(e.target.value) };
                        setForm({ ...form, ladder: next });
                      }}
                      placeholder="25"
                      inputMode="numeric"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <Field label="Commitment notes (maintenance windows, exclusions, escalation)">
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={5}
                  maxLength={2000}
                  className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] text-zinc-200 focus:border-sky-500 focus:outline-none"
                />
              </Field>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button onClick={publish} disabled={busy}>
                Publish SLA
              </Button>
              <span className="text-[11px] text-zinc-500">
                Publishing pins a new version. The previous version stays in history.
              </span>
            </div>
            {opErr ? <p className="mt-3 text-[12px] text-rose-400">{opErr}</p> : null}
            {opOk ? <p className="mt-3 text-[12px] text-emerald-400">{opOk}</p> : null}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-medium">Version history</h2>
            {history.length === 0 ? (
              <p className="text-[12px] text-zinc-500">
                No prior versions. The first publish becomes v1.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {history.map((row) => (
                  <li key={row.version} className="py-3 text-[12px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>v{row.version}</Badge>
                      <span className="text-zinc-300">
                        {bpsToPct(row.uptime_target_bps)}% uptime
                      </span>
                      <span className="text-zinc-500">
                        {new Date(row.effective_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1 text-zinc-400">
                      published by{" "}
                      <code className="font-mono text-[11px]">{row.published_by}</code>{" "}
                      sha{" "}
                      <code className="font-mono text-[11px]">
                        {row.notes_sha256.slice(0, 12)}
                      </code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </main>
  );
}

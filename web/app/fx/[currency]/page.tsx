"use client";
import { use, useState } from "react";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Input,
  Field,
} from "@/components/ui";
import { api, swrFetcher, type FxRate } from "@/lib/api";
import {
  CurrencyDollar,
  ArrowLeft,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FxDetailPage({
  params,
}: {
  params: Promise<{ currency: string }>;
}) {
  const { currency } = use(params);
  return (
    <AuthGate>
      <Detail currency={currency.toUpperCase()} />
    </AuthGate>
  );
}

function Detail({ currency }: { currency: string }) {
  const [asOf, setAsOf] = useState(todayIso());
  const key = `/fx/${currency}?as_of=${asOf}`;
  const { data, error, isLoading } = useSWR<FxRate>(key, swrFetcher);

  const [newRate, setNewRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function onUpsert(e: React.FormEvent) {
    e.preventDefault();
    const r = parseFloat(newRate);
    if (!Number.isFinite(r) || r <= 0) return;
    setFormErr(null);
    setBusy(true);
    try {
      await api<FxRate>("/fx", {
        method: "POST",
        body: JSON.stringify({ currency, date: asOf, rate: r }),
      });
      setNewRate("");
      await mutate(key);
    } catch (err: any) {
      setFormErr(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/fx"
          className="muted text-xs inline-flex items-center gap-1 hover:text-[var(--accent)]"
        >
          <ArrowLeft weight="duotone" /> FX
        </Link>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <CurrencyDollar weight="duotone" />
          <span className="mono">{currency}</span>
        </h1>
      </div>

      <Card title="Lookup rate">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="As of">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </Field>
          <Button variant="ghost" onClick={() => mutate(key)}>
            <MagnifyingGlass weight="duotone" className="inline mr-1" />
            Refresh
          </Button>
        </div>
        <div className="mt-4">
          {error ? (
            (error as any)?.status === 404 ? (
              <div className="text-sm muted">
                No rate stored for <span className="mono">{currency}</span> on{" "}
                {asOf}. Use the form below to add one.
              </div>
            ) : (
              <ErrorBox err={error} />
            )
          ) : isLoading || !data ? (
            <Loading />
          ) : (
            <div className="panel p-4 flex items-baseline justify-between">
              <div>
                <div className="muted text-xs uppercase tracking-wide">
                  {data.currency} per USD on {data.date}
                </div>
                <div className="mt-1 text-3xl num">{data.rate}</div>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Update this date">
        <form onSubmit={onUpsert} className="flex items-end gap-3 flex-wrap">
          <Field label="Rate to USD">
            <Input
              type="number"
              step="any"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              placeholder="1.085"
              required
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving" : "Save"}
          </Button>
        </form>
        {formErr && <div className="text-xs down mt-2">{formErr}</div>}
      </Card>
    </div>
  );
}

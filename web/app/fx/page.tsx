"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Input,
  Field,
} from "@/components/ui";
import { api, swrFetcher, type FxList, type FxRate } from "@/lib/api";
import { CurrencyDollar, Plus, ArrowsClockwise } from "@phosphor-icons/react/dist/ssr";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FxPage() {
  return (
    <AuthGate>
      <Fx />
    </AuthGate>
  );
}

function Fx() {
  const { data, error, isLoading } = useSWR<FxList>("/fx", swrFetcher, {
    refreshInterval: 60000,
  });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function onUpsert(currency: string, date: string, rate: number) {
    setFormErr(null);
    setBusy(true);
    try {
      await api<FxRate>("/fx", {
        method: "POST",
        body: JSON.stringify({ currency, date, rate }),
      });
      await mutate("/fx");
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <CurrencyDollar weight="duotone" />
          FX rates
        </h1>
        <p className="muted text-xs">
          Per-currency conversion rates to USD. Used by the converted portfolio
          view.
        </p>
      </header>

      <UpsertForm onSubmit={onUpsert} busy={busy} err={formErr} />

      <Card title="Currencies">
        {error ? (
          <ErrorBox err={error} />
        ) : isLoading || !data ? (
          <Loading />
        ) : data.currencies.length === 0 ? (
          <Empty
            title="No FX rates stored"
            hint="Add one above to enable multi-currency conversion."
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {data.currencies.map((c) => (
              <Link
                key={c}
                href={`/fx/${c}`}
                className="panel p-3 hover:border-[var(--accent)] transition flex items-center justify-between"
              >
                <span className="mono text-sm">{c}</span>
                <Badge tone="info">view</Badge>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function UpsertForm({
  onSubmit,
  busy,
  err,
}: {
  onSubmit: (currency: string, date: string, rate: number) => void;
  busy: boolean;
  err: string | null;
}) {
  const [currency, setCurrency] = useState("");
  const [date, setDate] = useState(todayIso());
  const [rate, setRate] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = parseFloat(rate);
    const c = currency.toUpperCase().trim();
    if (c.length !== 3 || !/^[A-Z]+$/.test(c) || !Number.isFinite(r) || r <= 0) return;
    onSubmit(c, date, r);
    setRate("");
  }

  return (
    <Card title="Add or update rate">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
        <Field label="Currency (ISO 3)">
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            placeholder="EUR"
            maxLength={3}
            required
          />
        </Field>
        <Field label="As of">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Rate to USD">
          <Input
            type="number"
            step="any"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="1.085"
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="duotone" className="inline mr-1" />
          {busy ? "Saving" : "Save"}
        </Button>
        {err && <div className="md:col-span-4 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}

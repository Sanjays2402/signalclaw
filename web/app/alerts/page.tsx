"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd } from "@/components/ui";
import { api, swrFetcher, type Alert, type AlertIn } from "@/lib/api";
import { Bell, BellRinging, Trash, Plus } from "@phosphor-icons/react/dist/ssr";

const CONDITIONS = [
  { v: "price_above", l: "price above" },
  { v: "price_below", l: "price below" },
  { v: "pct_change_above", l: "% change above" },
  { v: "pct_change_below", l: "% change below" },
];

export default function AlertsPage() {
  return (
    <AuthGate>
      <Alerts />
    </AuthGate>
  );
}

function Alerts() {
  const { data, error, isLoading } = useSWR<{ alerts: Alert[] }>("/alerts", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function onCreate(input: AlertIn) {
    setFormErr(null);
    setBusy("create");
    try {
      await api("/alerts", { method: "POST", body: JSON.stringify(input) });
      await mutate("/alerts");
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this alert?")) return;
    setBusy(id);
    try {
      await api(`/alerts/${id}`, { method: "DELETE" });
      await mutate("/alerts");
    } finally {
      setBusy(null);
    }
  }

  async function onCheck() {
    setBusy("check");
    try {
      const r = await api<{ hits: any[] }>("/alerts/check", { method: "POST", body: "{}" });
      alert(`${r.hits.length} alert(s) firing now`);
      await mutate("/alerts");
    } catch (e: any) {
      alert(`Check failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Bell weight="duotone" />
            Alerts
          </h1>
          <p className="muted text-xs">Trigger on price levels or percent moves.</p>
        </div>
        <Button variant="ghost" onClick={onCheck} disabled={busy === "check"}>
          <BellRinging weight="duotone" className="inline mr-1" />
          {busy === "check" ? "Checking" : "Run check"}
        </Button>
      </header>

      <CreateAlertForm onSubmit={onCreate} busy={busy === "create"} err={formErr} />

      <Card title="Active alerts">
        {error ? <ErrorBox err={error} /> :
          isLoading || !data ? <Loading /> :
            data.alerts.length === 0 ? (
              <Empty title="No alerts yet" hint="Create one above to start watching a level." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                      <th className="py-2 pr-3">Ticker</th>
                      <th className="pr-3">Condition</th>
                      <th className="text-right pr-3">Value</th>
                      <th className="pr-3">Cooldown</th>
                      <th className="pr-3">Last fired</th>
                      <th className="pr-3">Note</th>
                      <th className="pr-3">State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.alerts.map((a) => (
                      <tr key={a.id} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                        <td className="py-2 pr-3 mono">{a.ticker}</td>
                        <td className="pr-3 text-xs">{a.condition}</td>
                        <td className="num text-right pr-3">
                          {typeof a.value === "number" ? (a.condition.includes("price") ? fmtUsd(a.value) : `${(a.value * 100).toFixed(2)}%`) : a.value}
                        </td>
                        <td className="pr-3 text-xs">{a.cooldown_hours}h</td>
                        <td className="pr-3 text-xs muted">{a.last_fired_at ?? "never"}</td>
                        <td className="pr-3 text-xs muted">{a.note || ""}</td>
                        <td className="pr-3">
                          <Badge tone={a.enabled ? "up" : "neutral"}>{a.enabled ? "on" : "off"}</Badge>
                        </td>
                        <td>
                          <Button
                            variant="danger"
                            onClick={() => onDelete(a.id)}
                            disabled={busy === a.id}
                            className="text-xs"
                          >
                            <Trash weight="duotone" className="inline" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>
    </div>
  );
}

function CreateAlertForm({
  onSubmit,
  busy,
  err,
}: {
  onSubmit: (a: AlertIn) => void;
  busy: boolean;
  err: string | null;
}) {
  const [ticker, setTicker] = useState("");
  const [condition, setCondition] = useState("price_above");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [cooldown, setCooldown] = useState(12);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = condition.startsWith("pct") ? parseFloat(value) / 100 : parseFloat(value);
    if (!ticker || Number.isNaN(v)) return;
    onSubmit({
      ticker: ticker.toUpperCase().trim(),
      condition,
      value: v,
      note: note.trim(),
      cooldown_hours: cooldown,
      enabled: true,
    });
  }

  return (
    <Card title="New alert">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label="Condition">
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </Select>
        </Field>
        <Field label={condition.startsWith("pct") ? "Value (%)" : "Value ($)"}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Cooldown (h)">
          <Input value={cooldown} onChange={(e) => setCooldown(parseInt(e.target.value || "0", 10))} type="number" min={0} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="duotone" className="inline mr-1" />
          {busy ? "Saving" : "Create"}
        </Button>
        {err && <div className="md:col-span-6 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}

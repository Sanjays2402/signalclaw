"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import RuleVisual from "@/components/RuleVisual";
import {
  Card,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Input,
  Select,
  Field,
  fmtUsd,
} from "@/components/ui";
import { api, swrFetcher, type Alert, type AlertIn } from "@/lib/api";
import { BellRinging, Trash, Plus } from "@phosphor-icons/react/dist/ssr";

const CONDITIONS = [
  { v: "price_above", l: "price >" },
  { v: "price_below", l: "price <" },
  { v: "pct_change_above", l: "% chg >" },
  { v: "pct_change_below", l: "% chg <" },
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
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-base font-semibold uppercase tracking-widest" style={{ letterSpacing: "0.1em" }}>
            Alerts
          </h1>
          <p className="muted text-[10px] uppercase tracking-widest">
            Price levels and % moves. Fires once per cooldown.
          </p>
        </div>
        <Button variant="ghost" onClick={onCheck} disabled={busy === "check"}>
          <BellRinging weight="duotone" className="inline mr-1" size={12} />
          {busy === "check" ? "Checking" : "Run check"}
        </Button>
      </header>

      <CreateAlertForm onSubmit={onCreate} busy={busy === "create"} err={formErr} />

      <Card title="Active alerts">
        {error ? (
          <ErrorBox err={error} />
        ) : isLoading || !data ? (
          <Loading />
        ) : data.alerts.length === 0 ? (
          <Empty title="No alerts armed" hint="Add one above to watch a level." />
        ) : (
          <div className="overflow-x-auto -mx-3">
            <table className="trade">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Rule</th>
                  <th style={{ width: 240 }}>Visual</th>
                  <th className="r">Value</th>
                  <th className="r">Cooldown</th>
                  <th>Last fired</th>
                  <th>Note</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.alerts.map((a) => {
                  const val = typeof a.value === "number" ? a.value : parseFloat(String(a.value));
                  const isPct = a.condition.includes("pct");
                  const valDisp =
                    typeof a.value === "number"
                      ? isPct
                        ? `${(a.value * 100).toFixed(2)}%`
                        : fmtUsd(a.value)
                      : String(a.value);
                  return (
                    <tr key={a.id}>
                      <td className="mono font-semibold">{a.ticker}</td>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {CONDITIONS.find((c) => c.v === a.condition)?.l ?? a.condition}
                      </td>
                      <td>
                        <RuleVisual kind="alert" trigger={val} condition={a.condition} />
                      </td>
                      <td className="r mono">{valDisp}</td>
                      <td className="r mono muted">{a.cooldown_hours}h</td>
                      <td className="muted mono" style={{ fontSize: 11 }}>
                        {a.last_fired_at ?? "never"}
                      </td>
                      <td className="muted" style={{ fontSize: 11, maxWidth: 200, whiteSpace: "normal" }}>
                        {a.note || ""}
                      </td>
                      <td>
                        <Badge tone={a.enabled ? "up" : "neutral"}>{a.enabled ? "on" : "off"}</Badge>
                      </td>
                      <td>
                        <Button
                          variant="danger"
                          onClick={() => onDelete(a.id)}
                          disabled={busy === a.id}
                          className="text-[10px]"
                        >
                          <Trash weight="duotone" size={11} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
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
    <Card title="Arm new alert">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label="Condition">
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map((c) => (
              <option key={c.v} value={c.v}>
                {c.l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={condition.startsWith("pct") ? "Value (%)" : "Value ($)"}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Cooldown h">
          <Input
            value={cooldown}
            onChange={(e) => setCooldown(parseInt(e.target.value || "0", 10))}
            type="number"
            min={0}
          />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="bold" className="inline mr-1" size={11} />
          {busy ? "Arming" : "Arm"}
        </Button>
        {err && <div className="md:col-span-6 text-[11px] down mono">{err}</div>}
      </form>
    </Card>
  );
}

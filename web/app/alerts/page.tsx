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
import { api, swrFetcher, type Alert, type AlertIn, type AlertHistory } from "@/lib/api";
import { BellRinging, Trash, Plus, ClockCounterClockwise } from "@phosphor-icons/react/dist/ssr";

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

      <AlertHistoryCard refreshKey={busy === "check" ? 0 : 1} />

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

function AlertHistoryCard({ refreshKey }: { refreshKey: number }) {
  const [ticker, setTicker] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  if (ticker.trim()) qs.set("ticker", ticker.trim().toUpperCase());
  const key = `/alerts/history?${qs.toString()}&_=${refreshKey}`;
  const { data, error, isLoading } = useSWR<AlertHistory>(key, swrFetcher);
  const [busy, setBusy] = useState(false);

  async function onClear() {
    if (!confirm("Clear all fire history? Active alerts are not affected.")) return;
    setBusy(true);
    try {
      await api("/alerts/history/clear", { method: "DELETE" });
      await mutate(key);
    } finally {
      setBusy(false);
    }
  }

  function fmtTs(s: string) {
    try {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      return d.toLocaleString(undefined, { hour12: false });
    } catch {
      return s;
    }
  }
  function fmtVal(v: number | string, cond: string) {
    if (typeof v !== "number") return String(v);
    if (cond.includes("pct")) return `${(v * 100).toFixed(2)}%`;
    return fmtUsd(v);
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <ClockCounterClockwise weight="duotone" size={12} />
          Fire history
        </span>
      }
    >
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <Field label="Filter ticker">
          <Input
            value={ticker}
            onChange={(e) => {
              setOffset(0);
              setTicker(e.target.value);
            }}
            placeholder="all"
            className="w-28"
          />
        </Field>
        <div className="muted text-[11px] mono">
          {data ? `${data.total} total` : ""}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            className="text-[10px]"
          >
            Prev
          </Button>
          <Button
            variant="ghost"
            disabled={!data || offset + limit >= data.total}
            onClick={() => setOffset(offset + limit)}
            className="text-[10px]"
          >
            Next
          </Button>
          <Button variant="danger" onClick={onClear} disabled={busy} className="text-[10px]">
            <Trash weight="duotone" size={11} className="inline mr-1" />
            Clear
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorBox err={error} />
      ) : isLoading || !data ? (
        <Loading />
      ) : data.events.length === 0 ? (
        <Empty
          title="No fires yet"
          hint="Run check on the alerts above. Hits land here with a timestamp."
        />
      ) : (
        <div className="overflow-x-auto -mx-3">
          <table className="trade">
            <thead>
              <tr>
                <th>Fired at</th>
                <th>Ticker</th>
                <th>Rule</th>
                <th className="r">Target</th>
                <th className="r">Observed</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e, i) => (
                <tr key={`${e.alert_id}-${e.fired_at}-${i}`}>
                  <td className="mono muted" style={{ fontSize: 11 }}>{fmtTs(e.fired_at)}</td>
                  <td className="mono font-semibold">{e.ticker}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {CONDITIONS.find((c) => c.v === e.condition)?.l ?? e.condition}
                  </td>
                  <td className="r mono">{fmtVal(e.value, e.condition)}</td>
                  <td className="r mono">{fmtVal(e.observed, e.condition)}</td>
                  <td className="muted" style={{ fontSize: 11, maxWidth: 240, whiteSpace: "normal" }}>
                    {e.note || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

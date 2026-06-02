"use client";
import { useMemo, useState } from "react";
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
import { filterAlerts, type AlertStateFilter } from "@/lib/alertFilter";
import { sortAlerts, type AlertSortKey, type AlertSortDir } from "@/lib/alertSort";
import { BellRinging, Trash, Plus, ClockCounterClockwise, DownloadSimple, Power, MagnifyingGlass, ArrowUp, ArrowDown, PencilSimple, Check, X } from "@phosphor-icons/react/dist/ssr";

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
  const { data, error, isLoading } = useSWR<{ alerts: Alert[] }>("/api/alerts", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCooldown, setEditCooldown] = useState("");
  const [editErr, setEditErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<AlertStateFilter>("");
  const [sortKey, setSortKey] = useState<AlertSortKey>("ticker");
  const [sortDir, setSortDir] = useState<AlertSortDir>("asc");
  const allAlerts = data?.alerts ?? [];
  const visibleAlerts = useMemo(
    () => sortAlerts(filterAlerts(allAlerts, { query, state: stateFilter }), sortKey, sortDir),
    [allAlerts, query, stateFilter, sortKey, sortDir],
  );

  async function onCreate(input: AlertIn) {
    setFormErr(null);
    setBusy("create");
    try {
      await api("/api/alerts", { method: "POST", body: JSON.stringify(input) });
      await mutate("/api/alerts");
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
      await api(`/api/alerts/${id}`, { method: "DELETE" });
      await mutate("/api/alerts");
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api(`/api/alerts/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      await mutate("/api/alerts");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(a: Alert) {
    setEditErr(null);
    setEditId(a.id);
    const isPct = a.condition.includes("pct");
    const displayVal = isPct
      ? (a.value * 100).toString()
      : String(a.value);
    setEditValue(displayVal);
    setEditNote(a.note ?? "");
    setEditCooldown(String(a.cooldown_hours));
  }

  function cancelEdit() {
    setEditId(null);
    setEditErr(null);
  }

  async function saveEdit(a: Alert) {
    setEditErr(null);
    const isPct = a.condition.includes("pct");
    const rawVal = parseFloat(editValue);
    if (!Number.isFinite(rawVal)) { setEditErr("value must be a number"); return; }
    const value = isPct ? rawVal / 100 : rawVal;
    const cooldown = Math.floor(Number(editCooldown));
    if (!Number.isFinite(cooldown) || cooldown < 0) { setEditErr("cooldown must be a non-negative integer"); return; }
    setBusy(a.id);
    try {
      await api(`/api/alerts/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ value, note: editNote.trim(), cooldown_hours: cooldown }),
      });
      await mutate("/api/alerts");
      setEditId(null);
    } catch (e: any) {
      setEditErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onCheck() {
    setBusy("check");
    try {
      const r = await api<{ hits: any[] }>("/api/alerts/check", { method: "POST", body: "{}" });
      alert(`${r.hits.length} alert(s) firing now`);
      await mutate("/api/alerts");
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
          <>
            <div className="flex items-center gap-2 flex-wrap pb-3 mb-3 border-b border-[var(--border)]">
              <div className="relative flex-1 min-w-[200px]">
                <MagnifyingGlass weight="duotone" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 opacity-60 pointer-events-none" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search ticker or note"
                  className="pl-7"
                  data-testid="alert-filter-query"
                />
              </div>
              <Select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value as AlertStateFilter)}
                title="Filter by enabled state"
                data-testid="alert-filter-state"
                className="w-auto"
              >
                <option value="">All states</option>
                <option value="enabled">Enabled only</option>
                <option value="disabled">Disabled only</option>
              </Select>
              <Select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as AlertSortKey)}
                title="Sort alerts by"
                data-testid="alert-sort-key"
                className="w-auto"
              >
                <option value="ticker">Sort: ticker</option>
                <option value="value">Sort: value</option>
                <option value="cooldown">Sort: cooldown</option>
                <option value="last_fired">Sort: last fired</option>
              </Select>
              <button
                type="button"
                onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
                title={sortDir === "asc" ? "Ascending (click to flip)" : "Descending (click to flip)"}
                aria-label={`Sort direction ${sortDir}`}
                data-testid="alert-sort-dir"
                className="text-[10px] uppercase tracking-widest mono px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)] inline-flex items-center gap-1"
              >
                {sortDir === "asc" ? <ArrowUp weight="bold" size={10} /> : <ArrowDown weight="bold" size={10} />}
                {sortDir}
              </button>
              <span className="muted text-xs mono" data-testid="alert-filter-count">
                {visibleAlerts.length}/{allAlerts.length}
              </span>
              {(query || stateFilter || sortKey !== "ticker" || sortDir !== "asc") && (
                <button
                  type="button"
                  className="text-[10px] uppercase tracking-widest mono px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)]"
                  onClick={() => { setQuery(""); setStateFilter(""); setSortKey("ticker"); setSortDir("asc"); }}
                >
                  Clear
                </button>
              )}
            </div>
            {visibleAlerts.length === 0 ? (
              <Empty title="No alerts match" hint="Try clearing the filter or widening your search." />
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
                {visibleAlerts.map((a) => {
                  const val = typeof a.value === "number" ? a.value : parseFloat(String(a.value));
                  const isPct = a.condition.includes("pct");
                  const valDisp =
                    typeof a.value === "number"
                      ? isPct
                        ? `${(a.value * 100).toFixed(2)}%`
                        : fmtUsd(a.value)
                      : String(a.value);
                  const isEditing = editId === a.id;
                  return (
                    <tr key={a.id}>
                      <td className="mono font-semibold">{a.ticker}</td>
                      <td className="mono muted" style={{ fontSize: 11 }}>
                        {CONDITIONS.find((c) => c.v === a.condition)?.l ?? a.condition}
                      </td>
                      <td>
                        <RuleVisual kind="alert" trigger={val} condition={a.condition} />
                      </td>
                      <td className="r mono">
                        {isEditing ? (
                          <Input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            type="number"
                            step="any"
                            data-testid="alert-edit-value"
                            className="w-24 text-right"
                          />
                        ) : (
                          valDisp
                        )}
                      </td>
                      <td className="r mono muted">
                        {isEditing ? (
                          <Input
                            value={editCooldown}
                            onChange={(e) => setEditCooldown(e.target.value)}
                            type="number"
                            min={0}
                            step={1}
                            data-testid="alert-edit-cooldown"
                            className="w-16 text-right"
                          />
                        ) : (
                          `${a.cooldown_hours}h`
                        )}
                      </td>
                      <td className="muted mono" style={{ fontSize: 11 }}>
                        {a.last_fired_at ?? "never"}
                      </td>
                      <td className="muted" style={{ fontSize: 11, maxWidth: 200, whiteSpace: "normal" }}>
                        {isEditing ? (
                          <Input
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            placeholder="note"
                            data-testid="alert-edit-note"
                            className="w-full"
                          />
                        ) : (
                          a.note || ""
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => onToggle(a.id, !a.enabled)}
                          disabled={busy === a.id || isEditing}
                          title={a.enabled ? "Disable this alert" : "Enable this alert"}
                          aria-label={a.enabled ? "Disable alert" : "Enable alert"}
                          aria-pressed={a.enabled}
                          data-testid="alert-toggle"
                          className="appearance-none bg-transparent p-0 border-0 cursor-pointer disabled:opacity-50"
                        >
                          <Badge tone={a.enabled ? "up" : "neutral"}>
                            <Power weight="duotone" size={10} className="inline mr-0.5" />
                            {a.enabled ? "on" : "off"}
                          </Badge>
                        </button>
                      </td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <Button
                                variant="ghost"
                                onClick={() => saveEdit(a)}
                                disabled={busy === a.id}
                                className="text-[10px]"
                                data-testid="alert-edit-save"
                                title="Save changes"
                              >
                                <Check weight="bold" size={11} />
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={cancelEdit}
                                disabled={busy === a.id}
                                className="text-[10px]"
                                data-testid="alert-edit-cancel"
                                title="Cancel"
                              >
                                <X weight="bold" size={11} />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                onClick={() => startEdit(a)}
                                disabled={busy === a.id || editId !== null}
                                className="text-[10px]"
                                data-testid="alert-edit"
                                title="Edit value, note, cooldown"
                              >
                                <PencilSimple weight="duotone" size={11} />
                              </Button>
                              <Button
                                variant="danger"
                                onClick={() => onDelete(a.id)}
                                disabled={busy === a.id}
                                className="text-[10px]"
                              >
                                <Trash weight="duotone" size={11} />
                              </Button>
                            </>
                          )}
                        </div>
                        {isEditing && editErr && (
                          <div className="text-[10px] text-[var(--danger,#f55)] mt-1" data-testid="alert-edit-err">
                            {editErr}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
            )}
          </>
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
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  if (ticker.trim()) qs.set("ticker", ticker.trim().toUpperCase());
  if (fromDate.trim()) qs.set("from", fromDate.trim());
  if (toDate.trim()) qs.set("to", toDate.trim());
  const key = `/api/alerts/history?${qs.toString()}&_=${refreshKey}`;
  const { data, error, isLoading } = useSWR<AlertHistory>(key, swrFetcher);
  const [busy, setBusy] = useState(false);

  async function onClear() {
    if (!confirm("Clear all fire history? Active alerts are not affected.")) return;
    setBusy(true);
    try {
      await api("/api/alerts/history/clear", { method: "DELETE" });
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
        <Field label="From">
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setOffset(0);
              setFromDate(e.target.value);
            }}
            data-testid="alert-history-from"
            className="w-36"
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={toDate}
            onChange={(e) => {
              setOffset(0);
              setToDate(e.target.value);
            }}
            data-testid="alert-history-to"
            className="w-36"
          />
        </Field>
        {(fromDate || toDate) && (
          <button
            type="button"
            onClick={() => {
              setOffset(0);
              setFromDate("");
              setToDate("");
            }}
            className="text-[10px] uppercase tracking-widest mono muted hover:text-[var(--fg)]"
            data-testid="alert-history-date-clear"
          >
            Clear dates
          </button>
        )}
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
          {(() => {
            const exportQs = new URLSearchParams();
            if (ticker.trim()) exportQs.set("ticker", ticker.trim().toUpperCase());
            if (fromDate.trim()) exportQs.set("from", fromDate.trim());
            if (toDate.trim()) exportQs.set("to", toDate.trim());
            const suffix = exportQs.toString() ? `&${exportQs.toString()}` : "";
            const disabled = !data || data.total === 0;
            const linkCls =
              "text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)] uppercase tracking-widest font-semibold mono" +
              (disabled ? " opacity-40 pointer-events-none" : "");
            const parts: string[] = [];
            if (ticker.trim()) parts.push(ticker.trim().toUpperCase());
            if (fromDate.trim() || toDate.trim()) {
              parts.push(`${fromDate.trim() || "start"} to ${toDate.trim() || "now"}`);
            }
            const tip = parts.length
              ? `Download fire history (${parts.join(", ")})`
              : "Download all fire history";
            return (
              <>
                <a
                  href={`/api/alerts/history?format=csv${suffix}`}
                  className={linkCls}
                  title={`${tip} as CSV`}
                  data-testid="alert-history-export-csv"
                >
                  <DownloadSimple weight="duotone" size={11} /> CSV
                </a>
                <a
                  href={`/api/alerts/history?format=json${suffix}`}
                  className={linkCls}
                  title={`${tip} as JSON`}
                  data-testid="alert-history-export-json"
                >
                  <DownloadSimple weight="duotone" size={11} /> JSON
                </a>
                <a
                  href={`/api/alerts/history?format=md${suffix}`}
                  className={linkCls}
                  title={`${tip} as Markdown`}
                  data-testid="alert-history-export-md"
                >
                  <DownloadSimple weight="duotone" size={11} /> MD
                </a>
              </>
            );
          })()}
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

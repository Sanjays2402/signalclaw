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
  Select,
  Field,
  fmtUsd,
} from "@/components/ui";
import {
  api,
  swrFetcher,
  type ScalingPlan,
  type ScalingPlanList,
  type ScalingPlanIn,
  type ScaleRung,
} from "@/lib/api";
import { Stack, Plus, Trash, ArrowRight } from "@phosphor-icons/react/dist/ssr";

function statusTone(s: string): "up" | "down" | "warn" | "info" | "neutral" {
  const k = s.toLowerCase();
  if (k === "open" || k === "active") return "info";
  if (k === "complete" || k === "completed" || k === "filled") return "up";
  if (k === "cancelled" || k === "canceled") return "down";
  return "neutral";
}

export default function ScalingPage() {
  return (
    <AuthGate>
      <Scaling />
    </AuthGate>
  );
}

function Scaling() {
  const { data, error, isLoading } = useSWR<ScalingPlanList>(
    "/scaling/plans",
    swrFetcher,
    { refreshInterval: 60000 },
  );
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function onCreate(input: ScalingPlanIn) {
    setFormErr(null);
    setBusy(true);
    try {
      await api<ScalingPlan>("/scaling/plans", {
        method: "POST",
        body: JSON.stringify(input),
      });
      await mutate("/scaling/plans");
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
          <Stack weight="duotone" />
          Scaling plans
        </h1>
        <p className="muted text-xs">
          Pyramid in or trim out at R-multiple thresholds. Evaluate against
          intraday bars to fire rungs and ratchet stops.
        </p>
      </header>

      <CreatePlanForm onSubmit={onCreate} busy={busy} err={formErr} />

      <Card title="Plans">
        {error ? (
          <ErrorBox err={error} />
        ) : isLoading || !data ? (
          <Loading />
        ) : data.plans.length === 0 ? (
          <Empty
            title="No scaling plans"
            hint="Create one above to schedule R-multiple add or trim rungs."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                  <th className="py-2 pr-3">Ticker</th>
                  <th className="pr-3">Status</th>
                  <th className="text-right pr-3">Entry</th>
                  <th className="text-right pr-3">Init stop</th>
                  <th className="text-right pr-3">Shares</th>
                  <th className="text-right pr-3">Rungs</th>
                  <th className="text-right pr-3">Triggered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.plans.map((p) => (
                  <tr
                    key={p.plan_id}
                    className="border-b border-[var(--border)] hover:bg-white/[0.02]"
                  >
                    <td className="py-2 pr-3">
                      <Link
                        href={`/scaling/${p.plan_id}`}
                        className="mono hover:underline"
                      >
                        {p.ticker}
                      </Link>
                    </td>
                    <td className="pr-3">
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                    </td>
                    <td className="num text-right pr-3">{fmtUsd(p.entry)}</td>
                    <td className="num text-right pr-3">
                      {fmtUsd(p.initial_stop)}
                    </td>
                    <td className="num text-right pr-3">{p.initial_shares}</td>
                    <td className="num text-right pr-3">{p.rungs.length}</td>
                    <td className="num text-right pr-3">
                      {p.triggered.length} / {p.rungs.length}
                    </td>
                    <td>
                      <Link
                        href={`/scaling/${p.plan_id}`}
                        className="text-xs inline-flex items-center gap-1 hover:text-[var(--accent)]"
                      >
                        open <ArrowRight weight="duotone" />
                      </Link>
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

function CreatePlanForm({
  onSubmit,
  busy,
  err,
}: {
  onSubmit: (a: ScalingPlanIn) => void;
  busy: boolean;
  err: string | null;
}) {
  const [ticker, setTicker] = useState("");
  const [entry, setEntry] = useState("");
  const [initialStop, setInitialStop] = useState("");
  const [shares, setShares] = useState("");
  const [rungs, setRungs] = useState<ScaleRung[]>([
    { r_multiple: 1, action: "trim", size_fraction: 0.33, new_stop_r: 0 },
    { r_multiple: 2, action: "trim", size_fraction: 0.5, new_stop_r: 1 },
  ]);

  function setRung(i: number, patch: Partial<ScaleRung>) {
    setRungs((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRung() {
    setRungs((rs) => [
      ...rs,
      { r_multiple: 3, action: "trim", size_fraction: 0.25, new_stop_r: 2 },
    ]);
  }
  function removeRung(i: number) {
    setRungs((rs) => rs.filter((_, idx) => idx !== i));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const eN = parseFloat(entry);
    const sN = parseFloat(initialStop);
    const qN = parseInt(shares, 10);
    if (!ticker || !Number.isFinite(eN) || !Number.isFinite(sN) || !Number.isFinite(qN)) return;
    onSubmit({
      ticker: ticker.toUpperCase().trim(),
      entry: eN,
      initial_stop: sN,
      initial_shares: qN,
      rungs: rungs.map((r) => ({
        r_multiple: Number(r.r_multiple),
        action: r.action,
        size_fraction: Number(r.size_fraction),
        new_stop_r:
          r.new_stop_r == null || (r.new_stop_r as any) === "" ? null : Number(r.new_stop_r),
      })),
    });
    setTicker("");
    setEntry("");
    setInitialStop("");
    setShares("");
  }

  return (
    <Card title="New plan">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Ticker">
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL"
              required
            />
          </Field>
          <Field label="Entry">
            <Input
              type="number"
              step="any"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              required
            />
          </Field>
          <Field label="Initial stop">
            <Input
              type="number"
              step="any"
              value={initialStop}
              onChange={(e) => setInitialStop(e.target.value)}
              required
            />
          </Field>
          <Field label="Initial shares">
            <Input
              type="number"
              step="1"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              required
            />
          </Field>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="muted text-xs uppercase tracking-wide">Rungs</div>
            <Button type="button" variant="ghost" onClick={addRung} className="text-xs">
              <Plus weight="duotone" className="inline mr-1" />
              Add rung
            </Button>
          </div>
          <div className="space-y-2">
            {rungs.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end panel p-3"
              >
                <Field label="R multiple">
                  <Input
                    type="number"
                    step="any"
                    value={r.r_multiple}
                    onChange={(e) => setRung(i, { r_multiple: parseFloat(e.target.value) })}
                  />
                </Field>
                <Field label="Action">
                  <Select
                    value={r.action}
                    onChange={(e) => setRung(i, { action: e.target.value })}
                  >
                    <option value="trim">trim</option>
                    <option value="add">add</option>
                  </Select>
                </Field>
                <Field label="Size fraction">
                  <Input
                    type="number"
                    step="any"
                    value={r.size_fraction}
                    onChange={(e) =>
                      setRung(i, { size_fraction: parseFloat(e.target.value) })
                    }
                  />
                </Field>
                <Field label="New stop (R, blank for none)">
                  <Input
                    type="number"
                    step="any"
                    value={r.new_stop_r ?? ""}
                    onChange={(e) =>
                      setRung(i, {
                        new_stop_r:
                          e.target.value === "" ? null : parseFloat(e.target.value),
                      })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => removeRung(i)}
                  className="text-xs"
                  disabled={rungs.length <= 1}
                >
                  <Trash weight="duotone" className="inline" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs down">{err}</div>
          <Button type="submit" disabled={busy}>
            <Plus weight="duotone" className="inline mr-1" />
            {busy ? "Saving" : "Create plan"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

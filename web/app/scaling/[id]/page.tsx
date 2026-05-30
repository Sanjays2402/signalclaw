"use client";
import { use, useState, useMemo } from "react";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  fmtUsd,
} from "@/components/ui";
import {
  api,
  swrFetcher,
  type ScalingPlan,
  type ScalingPlanList,
  type ScaleEvaluate,
  type ScaleEvent,
  type ScaleBar,
} from "@/lib/api";
import {
  Stack,
  ArrowLeft,
  Trash,
  Prohibit,
  Lightning,
} from "@phosphor-icons/react/dist/ssr";

function statusTone(s: string): "up" | "down" | "warn" | "info" | "neutral" {
  const k = s.toLowerCase();
  if (k === "open" || k === "active") return "info";
  if (k === "complete" || k === "completed" || k === "filled") return "up";
  if (k === "cancelled" || k === "canceled") return "down";
  return "neutral";
}

export default function ScalingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AuthGate>
      <Detail id={id} />
    </AuthGate>
  );
}

function Detail({ id }: { id: string }) {
  const router = useRouter();
  // The API has no GET /scaling/plans/{id}, so derive from list.
  const { data, error, isLoading } = useSWR<ScalingPlanList>(
    "/scaling/plans",
    swrFetcher,
    { refreshInterval: 60000 },
  );
  const plan = useMemo(
    () => data?.plans.find((p) => p.plan_id === id) ?? null,
    [data, id],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const [barsText, setBarsText] = useState(
    "1, 0, 0\n2, 0, 0\n3, 0, 0",
  );
  const [lastResult, setLastResult] = useState<ScaleEvaluate | null>(null);

  async function onCancel() {
    if (!plan) return;
    if (!confirm("Cancel this plan? Remaining rungs will not fire.")) return;
    setActionErr(null);
    setBusy("cancel");
    try {
      await api(`/scaling/plans/${plan.plan_id}/cancel`, { method: "POST" });
      await mutate("/scaling/plans");
    } catch (e: any) {
      setActionErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!plan) return;
    if (!confirm("Delete this plan permanently?")) return;
    setActionErr(null);
    setBusy("delete");
    try {
      await api(`/scaling/plans/${plan.plan_id}`, { method: "DELETE" });
      await mutate("/scaling/plans");
      router.push("/scaling");
    } catch (e: any) {
      setActionErr(e?.message ?? String(e));
      setBusy(null);
    }
  }

  function parseBars(): ScaleBar[] | null {
    try {
      return barsText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
          if (parts.length < 3) throw new Error(`bad row: ${line}`);
          const [index, high, low] = parts;
          return {
            index: parseInt(index, 10),
            high: parseFloat(high),
            low: parseFloat(low),
          };
        });
    } catch {
      return null;
    }
  }

  async function onEvaluate() {
    if (!plan) return;
    const bars = parseBars();
    if (!bars || bars.length === 0) {
      setActionErr("bars must be lines of `index, high, low`");
      return;
    }
    if (bars.some((b) => !Number.isFinite(b.index) || !Number.isFinite(b.high) || !Number.isFinite(b.low))) {
      setActionErr("bars contain invalid numbers");
      return;
    }
    setActionErr(null);
    setBusy("evaluate");
    try {
      const r = await api<ScaleEvaluate>(
        `/scaling/plans/${plan.plan_id}/evaluate`,
        { method: "POST", body: JSON.stringify({ bars }) },
      );
      setLastResult(r);
      await mutate("/scaling/plans");
    } catch (e: any) {
      setLastResult(null);
      setActionErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/scaling"
          className="muted text-xs inline-flex items-center gap-1 hover:text-[var(--accent)]"
        >
          <ArrowLeft weight="duotone" /> Plans
        </Link>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Stack weight="duotone" />
          {plan ? (
            <>
              <span className="mono">{plan.ticker}</span>
              <Badge tone={statusTone(plan.status)}>{plan.status}</Badge>
            </>
          ) : (
            <span className="mono">{id}</span>
          )}
        </h1>
      </div>

      {error ? (
        <ErrorBox err={error} />
      ) : isLoading || !data ? (
        <Loading />
      ) : !plan ? (
        <Empty
          title="Plan not found"
          hint="It may have been deleted. Return to the list."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Entry" value={fmtUsd(plan.entry)} />
            <Stat label="Initial stop" value={fmtUsd(plan.initial_stop)} />
            <Stat label="Initial shares" value={plan.initial_shares} />
            <Stat
              label="Triggered"
              value={`${plan.triggered.length} / ${plan.rungs.length}`}
            />
          </div>

          <Card
            title="Rungs"
            right={
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={onCancel}
                  disabled={busy === "cancel"}
                >
                  <Prohibit weight="duotone" className="inline mr-1" />
                  {busy === "cancel" ? "Cancelling" : "Cancel"}
                </Button>
                <Button
                  variant="danger"
                  onClick={onDelete}
                  disabled={busy === "delete"}
                >
                  <Trash weight="duotone" className="inline mr-1" />
                  {busy === "delete" ? "Deleting" : "Delete"}
                </Button>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                    <th className="py-2 pr-3">#</th>
                    <th className="pr-3">Action</th>
                    <th className="text-right pr-3">R multiple</th>
                    <th className="text-right pr-3">Size</th>
                    <th className="text-right pr-3">New stop (R)</th>
                    <th className="pr-3">State</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rungs.map((r, i) => {
                    const fired = plan.triggered.includes(i);
                    return (
                      <tr
                        key={i}
                        className="border-b border-[var(--border)] hover:bg-white/[0.02]"
                      >
                        <td className="py-2 pr-3 mono">{i}</td>
                        <td className="pr-3">
                          <Badge tone={r.action === "add" ? "info" : "warn"}>
                            {r.action}
                          </Badge>
                        </td>
                        <td className="num text-right pr-3">{r.r_multiple}</td>
                        <td className="num text-right pr-3">
                          {(r.size_fraction * 100).toFixed(1)}%
                        </td>
                        <td className="num text-right pr-3">
                          {r.new_stop_r == null ? "..." : r.new_stop_r}
                        </td>
                        <td className="pr-3">
                          {fired ? (
                            <Badge tone="up">fired</Badge>
                          ) : (
                            <Badge tone="neutral">pending</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {actionErr && <div className="text-xs down mt-3">{actionErr}</div>}
          </Card>

          <Card title="Evaluate against bars">
            <p className="muted text-xs mb-2">
              One bar per line as <span className="mono">index, high, low</span>.
              Rungs fire when the bar reaches the corresponding R-multiple
              price.
            </p>
            <textarea
              value={barsText}
              onChange={(e) => setBarsText(e.target.value)}
              rows={6}
              className="w-full bg-black/40 border border-[var(--border)] rounded px-3 py-2 text-sm mono focus:outline-none focus:border-[var(--accent)]"
            />
            <div className="mt-3 flex justify-end">
              <Button onClick={onEvaluate} disabled={busy === "evaluate"}>
                <Lightning weight="duotone" className="inline mr-1" />
                {busy === "evaluate" ? "Evaluating" : "Evaluate"}
              </Button>
            </div>

            {lastResult && (
              <div className="mt-4">
                <div className="muted text-xs uppercase tracking-wide mb-2">
                  Events ({lastResult.events.length})
                </div>
                {lastResult.events.length === 0 ? (
                  <div className="text-sm muted">
                    No rungs fired on these bars.
                  </div>
                ) : (
                  <ul className="text-sm space-y-1">
                    {lastResult.events.map((ev: ScaleEvent, idx) => (
                      <li
                        key={idx}
                        className="flex items-center gap-2 flex-wrap"
                      >
                        <Badge tone={ev.action === "add" ? "info" : "warn"}>
                          {ev.action}
                        </Badge>
                        <span className="muted text-xs">rung {ev.rung_index}</span>
                        <span className="muted text-xs">@</span>
                        <span className="num">{fmtUsd(ev.trigger_price)}</span>
                        <span className="muted text-xs">
                          bar {ev.bar_index} ({ev.shares} sh, {ev.r_multiple}R)
                        </span>
                        {ev.new_stop != null && (
                          <span className="muted text-xs">
                            new stop {fmtUsd(ev.new_stop)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="panel p-3">
      <div className="muted text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-lg num">{value}</div>
    </div>
  );
}

"use client";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Empty, Badge, Button } from "@/components/ui";
import { swrFetcher, api, type ReportHistory, type ReportSummary } from "@/lib/api";
import { Archive, ClockClockwise, ArrowRight } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <Reports />
    </AuthGate>
  );
}

function Reports() {
  const { data, error, isLoading } = useSWR<ReportHistory>("/reports/history", swrFetcher, {
    refreshInterval: 60000,
  });
  const [busy, setBusy] = useState(false);
  const [mutErr, setMutErr] = useState<string | null>(null);

  async function archiveToday() {
    setBusy(true);
    setMutErr(null);
    try {
      await api("/reports/archive", { method: "POST" });
      await mutate("/reports/history");
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Report history</h1>
          <p className="muted text-xs mt-1">
            Daily picks snapshots. Open any date to view the full report and diff against the prior day.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mutErr && <span className="text-xs down">{mutErr}</span>}
          <Button onClick={archiveToday} disabled={busy}>
            <span className="inline-flex items-center gap-1.5">
              <Archive weight="duotone" size={14} />
              {busy ? "Archiving" : "Archive today"}
            </span>
          </Button>
        </div>
      </div>

      {isLoading && <Loading label="Loading report history" />}
      {error && <ErrorBox err={error} />}
      {data && data.summaries.length === 0 && (
        <Empty
          title="No archived reports yet"
          hint="Click Archive today to snapshot the current picks."
        />
      )}

      {data && data.summaries.length > 0 && (
        <Card title={`${data.summaries.length} snapshots`}>
          <ul className="divide-y divide-[var(--border)]">
            {[...data.summaries]
              .sort((a, b) => (a.as_of < b.as_of ? 1 : -1))
              .map((s) => (
                <ReportRow key={s.as_of} s={s} />
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ReportRow({ s }: { s: ReportSummary }) {
  return (
    <li>
      <Link
        href={`/reports/${s.as_of}`}
        className="flex items-center gap-4 py-3 px-1 hover:bg-white/5 rounded transition"
      >
        <div className="flex items-center gap-2 min-w-[7.5rem]">
          <ClockClockwise weight="duotone" size={16} className="text-[var(--accent)]" />
          <span className="num text-sm">{s.as_of}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 grow">
          <Badge tone="up">{s.n_watch} watch</Badge>
          <Badge tone="info">{s.n_hold} hold</Badge>
          <Badge tone="down">{s.n_skip} skip</Badge>
          {s.top_pick && (
            <span className="muted text-xs ml-2">
              top: <span className="text-white num">{s.top_pick}</span>
            </span>
          )}
        </div>
        <ArrowRight weight="duotone" size={16} className="muted" />
      </Link>
    </li>
  );
}

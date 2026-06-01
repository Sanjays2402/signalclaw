"use client";
import useSWR from "swr";
import Link from "next/link";
import {
  Pulse,
  CheckCircle,
  Warning,
  WarningOctagon,
  ClockClockwise,
  ArrowSquareOut,
  Stack,
} from "@phosphor-icons/react/dist/ssr";

type Update = { ts: string; status: string; body: string };
type Incident = {
  id: string;
  title: string;
  severity: "sev1" | "sev2" | "sev3" | "sev4";
  status: "investigating" | "identified" | "monitoring" | "resolved";
  summary: string;
  affected_services: string[];
  started_at: string;
  resolved_at: string | null;
  postmortem_url: string | null;
  updates: Update[];
};
type StatusPayload = {
  version: number;
  updated_at: string;
  overall_status: "operational" | "minor" | "major" | "critical";
  open_count: number;
  incidents: Incident[];
};

const BASE = process.env.NEXT_PUBLIC_API_URL || "";

const fetcher = (path: string) =>
  fetch(`${BASE}${path}`, { cache: "no-store" }).then(async (r) => {
    const txt = await r.text();
    if (!r.ok) throw new Error(txt || `${r.status}`);
    return JSON.parse(txt);
  });

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

function durationLabel(start: string, end: string | null): string {
  try {
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const mins = Math.max(0, Math.round((e - s) / 60000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return `${h}h ${m}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  } catch {
    return "";
  }
}

const SEV_LABEL: Record<Incident["severity"], string> = {
  sev1: "SEV1",
  sev2: "SEV2",
  sev3: "SEV3",
  sev4: "SEV4",
};
const SEV_CLASS: Record<Incident["severity"], string> = {
  sev1: "border-red-700/60 text-red-300 bg-red-950/40",
  sev2: "border-orange-700/60 text-orange-300 bg-orange-950/40",
  sev3: "border-amber-700/60 text-amber-300 bg-amber-950/30",
  sev4: "border-zinc-700/70 text-zinc-300 bg-zinc-900/60",
};
const STATUS_LABEL: Record<Incident["status"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

function OverallBanner({ status, openCount }: { status: StatusPayload["overall_status"]; openCount: number }) {
  if (status === "operational") {
    return (
      <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-5 flex items-start gap-3">
        <CheckCircle size={28} weight="duotone" className="text-emerald-400 shrink-0" />
        <div>
          <div className="text-base font-semibold text-emerald-200">All systems operational</div>
          <div className="text-xs text-emerald-400/80 mt-1">
            No active incidents. Public reads are unauthenticated; subscribe via the API at /status.
          </div>
        </div>
      </div>
    );
  }
  const cls =
    status === "critical"
      ? "border-red-800/70 bg-red-950/40 text-red-200"
      : status === "major"
      ? "border-orange-800/70 bg-orange-950/30 text-orange-200"
      : "border-amber-800/70 bg-amber-950/30 text-amber-200";
  const Icon = status === "critical" ? WarningOctagon : Warning;
  const label =
    status === "critical"
      ? "Critical incident in progress"
      : status === "major"
      ? "Major incident in progress"
      : "Minor incident in progress";
  return (
    <div className={`rounded-lg border p-5 flex items-start gap-3 ${cls}`}>
      <Icon size={28} weight="duotone" className="shrink-0" />
      <div>
        <div className="text-base font-semibold">{label}</div>
        <div className="text-xs opacity-80 mt-1">
          {openCount} open {openCount === 1 ? "incident" : "incidents"}. See details below.
        </div>
      </div>
    </div>
  );
}

function IncidentCard({ inc }: { inc: Incident }) {
  const isOpen = inc.status !== "resolved";
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center text-[10px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${SEV_CLASS[inc.severity]}`}
            >
              {SEV_LABEL[inc.severity]}
            </span>
            <span
              className={`text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 border ${
                isOpen
                  ? "border-amber-700/60 text-amber-200 bg-amber-950/30"
                  : "border-zinc-700/70 text-zinc-400 bg-zinc-900/60"
              }`}
            >
              {STATUS_LABEL[inc.status]}
            </span>
          </div>
          <h3 className="text-sm sm:text-base font-medium text-zinc-100 mt-2 break-words">
            {inc.title}
          </h3>
        </div>
        <div className="text-[11px] font-mono text-zinc-500 text-right shrink-0">
          <div>{fmtDateTime(inc.started_at)}</div>
          <div className="mt-0.5">
            duration {durationLabel(inc.started_at, inc.resolved_at)}
          </div>
        </div>
      </header>
      <p className="text-xs text-zinc-400">{inc.summary}</p>
      {inc.affected_services.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {inc.affected_services.map((s) => (
            <span
              key={s}
              className="text-[10px] font-mono text-zinc-300 bg-zinc-800/60 rounded px-1.5 py-0.5"
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {inc.updates.length > 0 && (
        <ol className="mt-3 border-l border-zinc-800 pl-3 space-y-2">
          {inc.updates.map((u, i) => (
            <li key={i} className="text-xs">
              <div className="flex items-center gap-2 text-zinc-500 font-mono text-[10px]">
                <span>{fmtDateTime(u.ts)}</span>
                <span className="uppercase tracking-wider">
                  {STATUS_LABEL[(u.status as Incident["status"]) ?? "investigating"] ?? u.status}
                </span>
              </div>
              <div className="text-zinc-300 mt-0.5 break-words">{u.body}</div>
            </li>
          ))}
        </ol>
      )}
      {inc.postmortem_url && (
        <div className="mt-3">
          <a
            href={inc.postmortem_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-zinc-400 hover:text-white inline-flex items-center gap-1"
          >
            Post-incident review <ArrowSquareOut size={11} weight="duotone" />
          </a>
        </div>
      )}
    </article>
  );
}

export default function StatusPage() {
  const { data, error, isLoading } = useSWR<StatusPayload>(
    "/status?limit=50",
    fetcher,
    { refreshInterval: 60_000 },
  );

  const open = (data?.incidents ?? []).filter((i) => i.status !== "resolved");
  const recent = (data?.incidents ?? []).filter((i) => i.status === "resolved");

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
              Trust Center
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold flex items-center gap-2">
              <Pulse size={28} weight="duotone" /> Service Status
            </h1>
            <p className="text-sm text-zinc-400 mt-2 max-w-2xl">
              Real-time health of Signalclaw and a full history of past incidents.
              Reads are public; you do not need a login.
            </p>
          </div>
          <Link
            href="/"
            className="text-[11px] text-zinc-400 hover:text-white whitespace-nowrap"
          >
            Back to app
          </Link>
        </header>

        {isLoading && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-400">
            Loading status...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300 flex items-start gap-2">
            <Warning size={18} weight="duotone" className="mt-0.5" />
            <div>
              <div className="font-medium">Could not load status.</div>
              <div className="text-xs text-red-400/80 mt-1">
                {(error as Error).message}
              </div>
            </div>
          </div>
        )}

        {data && (
          <>
            <OverallBanner status={data.overall_status} openCount={data.open_count} />

            <div className="flex items-center justify-between text-[11px] text-zinc-500 mt-3 mb-6 font-mono">
              <span>
                version {data.version} &middot; checked {fmtDateTime(data.updated_at)}
              </span>
              <span>{data.incidents.length} on record</span>
            </div>

            <section className="mb-8">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3 text-zinc-300">
                <Stack size={18} weight="duotone" /> Active incidents
              </h2>
              {open.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
                  No active incidents.
                </div>
              ) : (
                <div className="space-y-3">
                  {open.map((i) => (
                    <IncidentCard key={i.id} inc={i} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3 text-zinc-300">
                <ClockClockwise size={18} weight="duotone" /> Past incidents
              </h2>
              {recent.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
                  No resolved incidents on record.
                </div>
              ) : (
                <div className="space-y-3">
                  {recent.map((i) => (
                    <IncidentCard key={i.id} inc={i} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

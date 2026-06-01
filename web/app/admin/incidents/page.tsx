"use client";
// Admin incident manager. The buyer's SRE/ops lead uses this page to
// declare an incident, post timeline updates, and resolve it. All
// mutations land in the global audit chain and the public /status
// page reflects them within the SWR refresh window.
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Badge } from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Pulse,
  Plus,
  ArrowLeft,
  Warning,
  CheckCircle,
  Trash,
  PaperPlaneTilt,
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
type Resp = {
  version: number;
  overall_status: "operational" | "minor" | "major" | "critical";
  open_count: number;
  incidents: Incident[];
};

const SEVERITIES: Incident["severity"][] = ["sev1", "sev2", "sev3", "sev4"];
const STATUSES: Incident["status"][] = ["investigating", "identified", "monitoring", "resolved"];

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Incident["severity"]>("sev3");
  const [status, setStatus] = useState<Incident["status"]>("investigating");
  const [summary, setSummary] = useState("");
  const [services, setServices] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const affected_services = services
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      await api("/admin/incidents", {
        method: "POST",
        body: JSON.stringify({ title, severity, status, summary, affected_services }),
      });
      setTitle("");
      setSummary("");
      setServices("");
      onCreated();
    } catch (e: unknown) {
      const msg = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Plus size={16} weight="duotone" /> Declare incident
      </h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">
          <div className="text-zinc-400 mb-1">Title</div>
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Signal engine latency spike"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs">
          <div className="text-zinc-400 mb-1">Severity</div>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Incident["severity"])}
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s.toUpperCase()}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <div className="text-zinc-400 mb-1">Status</div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Incident["status"])}
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          <div className="text-zinc-400 mb-1">Summary (visible on /status)</div>
          <textarea
            required
            maxLength={1024}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={2}
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <div className="text-zinc-400 mb-1">Affected services (comma separated, lowercase)</div>
          <input
            value={services}
            onChange={(e) => setServices(e.target.value)}
            placeholder="signal-engine, api"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          />
        </label>
        {err && (
          <div className="sm:col-span-2 text-xs text-red-300 flex items-center gap-1">
            <Warning size={14} weight="duotone" /> {err}
          </div>
        )}
        <div className="sm:col-span-2 flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 inline-flex items-center gap-1"
          >
            <PaperPlaneTilt size={14} weight="duotone" />
            {busy ? "Publishing..." : "Publish incident"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function IncidentRow({ inc, onChanged }: { inc: Incident; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [updStatus, setUpdStatus] = useState<Incident["status"]>(inc.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function postUpdate() {
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/admin/incidents/${inc.id}/updates`, {
        method: "POST",
        body: JSON.stringify({ status: updStatus, body: body.trim() }),
      });
      setBody("");
      onChanged();
    } catch (e: unknown) {
      const msg = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${inc.id}? This is recorded in the audit log.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/admin/incidents/${inc.id}`, { method: "DELETE" });
      onChanged();
    } catch (e: unknown) {
      const msg = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(msg);
      setBusy(false);
    }
  }

  const isOpen = inc.status !== "resolved";
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge>{inc.severity.toUpperCase()}</Badge>
            <Badge>{inc.status}</Badge>
            {isOpen ? null : <CheckCircle size={14} weight="duotone" className="text-emerald-400" />}
          </div>
          <h3 className="text-sm font-medium mt-2 break-words">{inc.title}</h3>
          <div className="text-[11px] text-zinc-500 font-mono mt-1">{inc.id}</div>
        </div>
        <button
          onClick={remove}
          disabled={busy}
          className="text-[11px] text-red-300 hover:text-red-200 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Trash size={12} weight="duotone" /> Delete
        </button>
      </div>
      <p className="text-xs text-zinc-400">{inc.summary}</p>
      {inc.affected_services.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
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
        <ol className="mt-3 border-l border-zinc-800 pl-3 space-y-1.5">
          {inc.updates.map((u, i) => (
            <li key={i} className="text-xs">
              <div className="text-[10px] font-mono text-zinc-500">
                {fmtDateTime(u.ts)} &middot; {u.status}
              </div>
              <div className="text-zinc-300 break-words">{u.body}</div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
        <select
          value={updStatus}
          onChange={(e) => setUpdStatus(e.target.value as Incident["status"])}
          className="bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Post a public update..."
          maxLength={2048}
          className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1.5 text-xs"
        />
        <button
          onClick={postUpdate}
          disabled={busy || !body.trim()}
          className="text-xs px-3 py-1.5 rounded bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Posting..." : "Post update"}
        </button>
      </div>
      {err && (
        <div className="mt-2 text-xs text-red-300 flex items-center gap-1">
          <Warning size={14} weight="duotone" /> {err}
        </div>
      )}
    </Card>
  );
}

function AdminInner() {
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    "/admin/incidents",
    swrFetcher,
    { refreshInterval: 0 },
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
              Admin
            </div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Pulse size={26} weight="duotone" /> Incidents
            </h1>
            <p className="text-sm text-zinc-400 mt-2 max-w-2xl">
              Manage the public status page. Every change is recorded in the
              audit chain and visible to the customer at /status.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Link
              href="/status"
              className="text-[11px] text-zinc-400 hover:text-white whitespace-nowrap"
            >
              Public page
            </Link>
            <Link
              href="/admin/controls"
              className="text-[11px] text-zinc-500 hover:text-white whitespace-nowrap inline-flex items-center gap-1"
            >
              <ArrowLeft size={11} weight="duotone" /> Admin
            </Link>
          </div>
        </header>

        <div className="mb-6">
          <CreateForm onCreated={() => mutate()} />
        </div>

        {isLoading && <Loading />}
        {error && <ErrorBox err={error} />}

        {data && (
          <>
            <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-3 font-mono">
              <span>overall: {data.overall_status}</span>
              <span>
                {data.open_count} open &middot; {data.incidents.length} total
              </span>
            </div>
            {data.incidents.length === 0 ? (
              <Card className="p-6 text-center text-sm text-zinc-400">
                No incidents recorded yet.
              </Card>
            ) : (
              <div className="space-y-3">
                {data.incidents.map((i) => (
                  <IncidentRow key={i.id} inc={i} onChanged={() => mutate()} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function AdminIncidentsPage() {
  return (
    <AuthGate>
      <AdminInner />
    </AuthGate>
  );
}

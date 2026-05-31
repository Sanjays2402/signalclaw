"use client";
import useSWR from "swr";
import Link from "next/link";
import { useState } from "react";
import {
  Bell,
  CheckCircle,
  Trash,
  FloppyDisk,
  Plug,
  Stack,
  Key,
  WarningCircle,
  Sparkle,
  Info,
} from "@phosphor-icons/react/dist/ssr";
import { Card, Button, Empty, Loading, ErrorBox } from "@/components/ui";

type Ev = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  created_at: string;
  read: boolean;
};

type Resp = {
  events: Ev[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

const KIND_LABELS: Record<string, string> = {
  "run.saved": "Run saved",
  "run.deleted": "Run deleted",
  "webhook.delivered": "Webhook delivered",
  "webhook.failed": "Webhook failed",
  "batch.completed": "Batch complete",
  "key.created": "API key created",
  "key.revoked": "API key revoked",
  "alert.fired": "Alert fired",
  system: "System",
};

const KINDS = Object.keys(KIND_LABELS);

function fetcher(url: string): Promise<Resp> {
  return fetch(url, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json();
  });
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.max(1, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "shrink-0";
  const size = 16;
  switch (kind) {
    case "run.saved":
      return <FloppyDisk size={size} weight="duotone" className={cls} />;
    case "run.deleted":
      return <Trash size={size} weight="duotone" className={cls} />;
    case "webhook.delivered":
      return <Plug size={size} weight="duotone" className={cls} />;
    case "webhook.failed":
      return <WarningCircle size={size} weight="duotone" className={cls} />;
    case "batch.completed":
      return <Stack size={size} weight="duotone" className={cls} />;
    case "key.created":
    case "key.revoked":
      return <Key size={size} weight="duotone" className={cls} />;
    case "alert.fired":
      return <Sparkle size={size} weight="duotone" className={cls} />;
    default:
      return <Info size={size} weight="duotone" className={cls} />;
  }
}

export default function ActivityPage() {
  const [kindFilter, setKindFilter] = useState<string>("");
  const [unreadOnly, setUnreadOnly] = useState<boolean>(false);
  const [offset, setOffset] = useState<number>(0);
  const LIMIT = 25;

  const qs = new URLSearchParams();
  if (kindFilter) qs.set("kind", kindFilter);
  if (unreadOnly) qs.set("unread", "1");
  qs.set("limit", String(LIMIT));
  qs.set("offset", String(offset));

  const { data, error, isLoading, mutate } = useSWR<Resp>(
    `/api/activity?${qs.toString()}`,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const [busy, setBusy] = useState<string | null>(null);

  async function markAllRead() {
    setBusy("all");
    try {
      await fetch("/api/activity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark_all_read" }),
      });
      mutate();
    } finally {
      setBusy(null);
    }
  }

  async function markRead(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/activity/${id}`, { method: "PATCH" });
      mutate();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/activity/${id}`, { method: "DELETE" });
      mutate();
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    if (!confirm("Clear all activity? This cannot be undone.")) return;
    setBusy("clear");
    try {
      await fetch("/api/activity", { method: "DELETE" });
      setOffset(0);
      mutate();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Bell size={18} weight="duotone" />
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          {data && (
            <span className="mono text-[11px] muted">
              {data.unread} unread of {data.total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={markAllRead} disabled={busy === "all"}>
            <CheckCircle size={14} weight="duotone" /> Mark all read
          </Button>
          <Button onClick={clearAll} disabled={busy === "clear"}>
            <Trash size={14} weight="duotone" /> Clear
          </Button>
        </div>
      </div>

      <Card title="Filter">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => {
              setKindFilter("");
              setOffset(0);
            }}
            className={`px-2 py-1 border rounded uppercase tracking-wider ${
              kindFilter === "" ? "border-[var(--amber)] text-[var(--amber)]" : "border-[var(--border)] muted"
            }`}
          >
            All
          </button>
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKindFilter(k);
                setOffset(0);
              }}
              className={`px-2 py-1 border rounded uppercase tracking-wider ${
                kindFilter === k ? "border-[var(--amber)] text-[var(--amber)]" : "border-[var(--border)] muted"
              }`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 mono">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setOffset(0);
              }}
            />
            Unread only
          </label>
        </div>
      </Card>

      {error && <ErrorBox err={error} />}
      {isLoading && !data && <Loading />}

      {data && data.events.length === 0 && (
        <Empty
          title="No activity yet"
          hint="Save a run, fire a webhook, or run a batch scan to see events here."
        />
      )}

      {data && data.events.length > 0 && (
        <div className="panel divide-y divide-[var(--border)]">
          {data.events.map((e) => (
            <div
              key={e.id}
              className={`flex items-start gap-3 p-3 ${e.read ? "" : "bg-[var(--bg-elev)]"}`}
            >
              <div className="pt-0.5">
                <KindIcon kind={e.kind} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium truncate">{e.title}</span>
                  {!e.read && (
                    <span className="mono text-[9px] px-1.5 py-0.5 rounded bg-[var(--amber)] text-black uppercase tracking-widest">
                      New
                    </span>
                  )}
                  <span className="mono text-[10px] muted uppercase tracking-widest">
                    {KIND_LABELS[e.kind] ?? e.kind}
                  </span>
                </div>
                {e.body && <div className="text-[12px] muted mt-0.5 break-words">{e.body}</div>}
                <div className="text-[10px] muted mono mt-1 flex items-center gap-3">
                  <span>{relativeTime(e.created_at)}</span>
                  {e.href && (
                    <Link href={e.href} className="underline hover:no-underline">
                      Open
                    </Link>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {!e.read && (
                  <button
                    type="button"
                    onClick={() => markRead(e.id)}
                    disabled={busy === e.id}
                    title="Mark read"
                    className="p-1 hover:text-[var(--amber)]"
                  >
                    <CheckCircle size={14} weight="duotone" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(e.id)}
                  disabled={busy === e.id}
                  title="Delete"
                  className="p-1 hover:text-red-400"
                >
                  <Trash size={14} weight="duotone" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && (data.has_more || offset > 0) && (
        <div className="flex items-center justify-between text-[11px] mono">
          <Button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
            Previous
          </Button>
          <span className="muted">
            Showing {offset + 1}-{offset + data.events.length} of {data.total}
          </span>
          <Button
            onClick={() => setOffset(offset + LIMIT)}
            disabled={!data.has_more}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

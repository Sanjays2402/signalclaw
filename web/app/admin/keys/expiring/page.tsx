"use client";
// Admin: API-key expiry watchlist.
//
// SOC2 CC6.1 and ISO 27001 A.9.2.6 require time-bound credentials and
// proactive rotation. The Next.js route /api/admin/keys/expiring and the
// FastAPI route /admin/keys/expiring already classify each key by how
// soon it lapses. This page is the human surface: an operator can see,
// in one screen, which keys need to be rotated this week so automation
// does not break at 03:00 on a Sunday.
//
// Admin-scoped on the server. Buckets match lib/keyExpiry.ts so the
// FastAPI and Next.js views agree.
import useSWR from "swr";
import { useMemo, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Empty,
  Badge,
} from "@/components/ui";
import { swrFetcher } from "@/lib/api";
import {
  Key,
  Clock,
  Warning,
  ShieldWarning,
  Buildings,
  ArrowSquareOut,
  Hourglass,
} from "@phosphor-icons/react/dist/ssr";

type Bucket = "expired" | "critical" | "soon" | "upcoming" | "ok";

type ClassifiedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  expires_at: string;
  expires_in_ms: number;
  expires_in_days: number;
  bucket: Bucket;
  revoked: boolean;
  suspended: boolean;
};

type Resp = {
  generated_at: string;
  window_days: number;
  counts: {
    expired: number;
    critical: number;
    soon: number;
    upcoming: number;
    active_with_expiry: number;
    no_expiry: number;
    revoked_or_suspended: number;
  };
  keys: ClassifiedKey[];
};

const WINDOWS = [7, 14, 30, 60, 90];

export default function AdminKeysExpiringPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const [windowDays, setWindowDays] = useState(30);
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    `/admin/keys/expiring?within_days=${windowDays}`,
    swrFetcher,
    { refreshInterval: 60_000 },
  );

  const grouped = useMemo(() => {
    const out: Record<Exclude<Bucket, "ok">, ClassifiedKey[]> = {
      expired: [],
      critical: [],
      soon: [],
      upcoming: [],
    };
    if (data?.keys) {
      for (const k of data.keys) {
        if (k.bucket === "ok") continue;
        out[k.bucket].push(k);
      }
    }
    return out;
  }, [data]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <Buildings size={14} weight="duotone" />
          <Link href="/admin" className="hover:text-zinc-200">Admin</Link>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-200">API key expiry</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-100 flex items-center gap-2">
          <Hourglass size={22} weight="duotone" className="text-zinc-300" />
          Expiring API keys
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Forward-looking rotation queue. Already-expired keys always
          surface so a dead credential still configured downstream is
          obvious. Live, polled every 60 seconds.
        </p>
      </header>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Window</span>
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindowDays(w)}
                className={
                  "rounded px-2 py-1 border " +
                  (w === windowDays
                    ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700")
                }
              >
                {w}d
              </button>
            ))}
          </div>
          <button
            onClick={() => mutate()}
            className="rounded border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
          >
            Refresh
          </button>
        </div>

        {data && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Expired"
              value={data.counts.expired}
              tone="danger"
              icon={<ShieldWarning size={14} weight="duotone" />}
            />
            <Stat
              label="<= 24h"
              value={data.counts.critical}
              tone="danger"
              icon={<Warning size={14} weight="duotone" />}
            />
            <Stat
              label="<= 7d"
              value={data.counts.soon}
              tone="warn"
              icon={<Clock size={14} weight="duotone" />}
            />
            <Stat
              label="<= 30d"
              value={data.counts.upcoming}
              tone="muted"
              icon={<Hourglass size={14} weight="duotone" />}
            />
          </div>
        )}
        {data && (
          <p className="mt-3 text-[11px] text-zinc-500">
            {data.counts.active_with_expiry} active with expiry,{" "}
            {data.counts.no_expiry} without,{" "}
            {data.counts.revoked_or_suspended} revoked or suspended. Window {data.window_days}d.
          </p>
        )}
      </Card>

      {isLoading && (
        <div className="mt-4"><Loading /></div>
      )}
      {error && (
        <div className="mt-4"><ErrorBox err={error} /></div>
      )}

      {data && (
        <div className="mt-4 space-y-4">
          <BucketSection
            title="Expired"
            hint="Already past expiry. Rotate or remove from downstream automation immediately."
            tone="danger"
            keys={grouped.expired}
          />
          <BucketSection
            title="Critical (under 24h)"
            hint="Rotate today. Anything still calling with this key will start 401ing soon."
            tone="danger"
            keys={grouped.critical}
          />
          <BucketSection
            title="Soon (under 7 days)"
            hint="Plan rotation this week."
            tone="warn"
            keys={grouped.soon}
          />
          <BucketSection
            title="Upcoming (under 30 days)"
            hint="On the radar. Schedule with the owning team."
            tone="muted"
            keys={grouped.upcoming}
          />

          {data.keys.length === 0 && (
            <Empty
              title="Nothing expiring in this window"
              hint="Widen the window above to look further ahead, or manage keys in Settings."
            />
          )}

          <div className="text-xs text-zinc-500">
            Manage keys at{" "}
            <Link
              href="/settings/keys"
              className="text-zinc-300 hover:text-zinc-100 inline-flex items-center gap-1"
            >
              /settings/keys <ArrowSquareOut size={10} weight="duotone" />
            </Link>
            .
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "danger" | "warn" | "muted";
  icon: React.ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-300"
        : "text-zinc-300";
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <div className={"flex items-center gap-1.5 text-[11px] " + cls}>
        {icon}
        <span className="uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function BucketSection({
  title,
  hint,
  tone,
  keys,
}: {
  title: string;
  hint: string;
  tone: "danger" | "warn" | "muted";
  keys: ClassifiedKey[];
}) {
  if (keys.length === 0) return null;
  const border =
    tone === "danger"
      ? "border-rose-900/60"
      : tone === "warn"
        ? "border-amber-900/60"
        : "border-zinc-800";
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">
          {title} <span className="text-zinc-500 font-normal">({keys.length})</span>
        </h2>
        <p className="text-[11px] text-zinc-500 max-w-md text-right">{hint}</p>
      </div>
      <div className={"rounded-md border " + border + " bg-zinc-950 overflow-hidden"}>
        <ul className="divide-y divide-zinc-900">
          {keys.map((k) => (
            <li key={k.id} className="p-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Key size={14} weight="duotone" className="text-zinc-400 shrink-0" />
                  <span className="text-sm text-zinc-100 truncate">{k.label}</span>
                  <code className="text-[11px] text-zinc-500">{k.prefix}</code>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-zinc-300">
                  {formatExpiry(k)}
                </div>
                <div className="text-[10px] text-zinc-500 font-mono">{k.expires_at}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function formatExpiry(k: ClassifiedKey): string {
  const ms = k.expires_in_ms;
  if (ms <= 0) {
    const past = Math.abs(ms);
    if (past < 3600_000) return `expired ${Math.max(1, Math.round(past / 60_000))}m ago`;
    if (past < 86_400_000) return `expired ${Math.round(past / 3_600_000)}h ago`;
    return `expired ${Math.round(past / 86_400_000)}d ago`;
  }
  if (ms < 3600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

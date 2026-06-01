"use client";
// Admin: API-key dormancy watchlist.
//
// SOC2 CC6.1 and ISO 27001 A.9.2.5 require periodic review of access
// rights. A credential that has not authenticated in months is a
// liability: full original scope, no recent observation, no business
// owner watching it. The Next.js route /api/admin/keys/dormant and the
// FastAPI route /admin/keys/dormant classify each live key by how long
// it has been silent. This page is the human surface: an operator can
// see, in one screen, which keys to revoke or rotate this week.
//
// Admin-scoped on the server. Buckets match lib/keyDormancy.ts so the
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
  Moon,
  Warning,
  Buildings,
  ArrowSquareOut,
  ClockCountdown,
  Bed,
} from "@phosphor-icons/react/dist/ssr";

type Bucket = "quiet" | "dormant" | "abandoned";

type ClassifiedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  silent_ms: number;
  silent_days: number;
  bucket: Bucket;
  never_used: boolean;
  revoked: boolean;
};

type Resp = {
  generated_at: string;
  window_days: number;
  counts: {
    quiet: number;
    dormant: number;
    abandoned: number;
    never_used: number;
    active: number;
    revoked: number;
    unknown: number;
  };
  keys: ClassifiedKey[];
};

const WINDOWS = [14, 30, 60, 90, 180];

export default function AdminKeysDormantPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const [windowDays, setWindowDays] = useState(30);
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    `/admin/keys/dormant?within_days=${windowDays}`,
    swrFetcher,
    { refreshInterval: 60_000 },
  );

  const grouped = useMemo(() => {
    const out: Record<Bucket, ClassifiedKey[]> = {
      abandoned: [],
      dormant: [],
      quiet: [],
    };
    if (data?.keys) {
      for (const k of data.keys) out[k.bucket].push(k);
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
          <span className="text-zinc-200">API key dormancy</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-100 flex items-center gap-2">
          <Moon size={22} weight="duotone" className="text-zinc-300" />
          Dormant API keys
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Credentials that have been silent past the review window. Revoke
          the ones nobody owns; rotate and document the ones still in use.
          Live, polled every 60 seconds.
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
              label=">= 180d"
              value={data.counts.abandoned}
              tone="danger"
              icon={<Warning size={14} weight="duotone" />}
            />
            <Stat
              label=">= 90d"
              value={data.counts.dormant}
              tone="warn"
              icon={<Bed size={14} weight="duotone" />}
            />
            <Stat
              label=">= 30d"
              value={data.counts.quiet}
              tone="muted"
              icon={<ClockCountdown size={14} weight="duotone" />}
            />
            <Stat
              label="Never used"
              value={data.counts.never_used}
              tone="warn"
              icon={<Moon size={14} weight="duotone" />}
            />
          </div>
        )}
        {data && (
          <p className="mt-3 text-[11px] text-zinc-500">
            {data.counts.active} active, {data.counts.revoked} revoked or
            expired, {data.counts.unknown} unclassified. Window {data.window_days}d.
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
            title="Abandoned (180 days or more)"
            hint="Revoke unless an owner can vouch for it today. Most should go."
            tone="danger"
            keys={grouped.abandoned}
          />
          <BucketSection
            title="Dormant (90 to 179 days)"
            hint="Confirm the owner, rotate the secret, document the workload."
            tone="warn"
            keys={grouped.dormant}
          />
          <BucketSection
            title="Quiet (30 to 89 days)"
            hint="On the radar. Surface to the owning team during the next access review."
            tone="muted"
            keys={grouped.quiet}
          />

          {data.keys.length === 0 && (
            <Empty
              title="No dormant keys in this window"
              hint="Widen the window above to look further back, or manage keys in Settings."
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
            . Compare against the expiry watchlist at{" "}
            <Link
              href="/admin/keys/expiring"
              className="text-zinc-300 hover:text-zinc-100 inline-flex items-center gap-1"
            >
              /admin/keys/expiring <ArrowSquareOut size={10} weight="duotone" />
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
                  {k.never_used && (
                    <Badge>never used</Badge>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {k.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-zinc-300">
                  {formatSilence(k)}
                </div>
                <div className="text-[10px] text-zinc-500 font-mono">
                  {k.last_used_at ?? `created ${k.created_at}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function formatSilence(k: ClassifiedKey): string {
  const ms = k.silent_ms;
  const verb = k.never_used ? "minted" : "last used";
  if (ms < 86_400_000) return `${verb} ${Math.round(ms / 3_600_000)}h ago`;
  return `${verb} ${Math.round(ms / 86_400_000)}d ago`;
}

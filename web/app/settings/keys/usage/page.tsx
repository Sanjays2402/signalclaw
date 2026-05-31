"use client";
//
// Admin console: per-API-key usage analytics.
//
// Reads the same /api/admin/keys listing the keys page uses, lets the
// operator pick a key, then fetches /api/admin/keys/:id/usage and renders
// a daily volume sparkline, lifetime + window totals, and a per-route
// breakdown. Backed by lib/keyUsageStore (file-backed, atomic writes).
//
// Why this lives in the admin surface and not as a public /demo: enterprise
// procurement teams ask for per-credential traffic visibility to scope
// abuse and bill-back. This is the page they get pointed at.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
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
  ChartLineUp,
  ArrowsClockwise,
  ShieldCheck,
  Pulse,
} from "@phosphor-icons/react/dist/ssr";

type ListedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  revoked: boolean;
  suspended?: boolean;
};

type DailyPoint = {
  day: string;
  total: number;
  success: number;
  client_error: number;
  server_error: number;
};

type UsagePayload = {
  key_id: string;
  window_days: number;
  total_lifetime: number;
  last_request_at: string | null;
  window: {
    total: number;
    success: number;
    client_error: number;
    server_error: number;
  };
  daily: DailyPoint[];
  by_route: Array<{
    route_class: string;
    total: number;
    success: number;
    client_error: number;
    server_error: number;
  }>;
};

const WINDOW_OPTIONS = [7, 14, 30];

export default function KeyUsagePage() {
  const keysSwr = useSWR<{ keys: ListedKey[] }>(
    "/api/admin/keys",
    swrFetcher,
  );
  const keys = keysSwr.data?.keys ?? [];
  const activeKeys = keys.filter((k) => !k.revoked);
  const [selected, setSelected] = useState<string>("");
  const [days, setDays] = useState<number>(14);

  useEffect(() => {
    if (!selected && activeKeys.length) setSelected(activeKeys[0].id);
  }, [selected, activeKeys]);

  const usageUrl =
    selected && `/api/admin/keys/${selected}/usage?days=${days}`;
  const usageSwr = useSWR<UsagePayload>(usageUrl || null, swrFetcher);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest muted">
            <ShieldCheck size={14} weight="duotone" />
            Admin console
          </div>
          <h1 className="text-xl font-semibold mt-1">API key usage</h1>
          <p className="text-sm muted mt-1">
            Per credential request volume, success rate, and route mix.
            Hooked into every /v1 request at the central guard.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            keysSwr.mutate();
            usageSwr.mutate();
          }}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          aria-label="Refresh usage"
        >
          <ArrowsClockwise size={14} weight="duotone" />
          Refresh
        </button>
      </header>

      <Card title="Credential">
        {keysSwr.isLoading ? (
          <Loading label="Loading keys" />
        ) : keysSwr.error ? (
          <ErrorBox err={keysSwr.error} />
        ) : activeKeys.length === 0 ? (
          <Empty
            title="No active API keys"
            hint="Mint a key on Settings, API keys before this page can render usage."
          />
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex-1 min-w-0">
              <span className="block text-[10px] uppercase tracking-widest muted mb-1">
                Key
              </span>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-sm mono focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {activeKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label} ({k.prefix})
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="block text-[10px] uppercase tracking-widest muted mb-1">
                Window
              </span>
              <div
                role="tablist"
                aria-label="Window in days"
                className="inline-flex rounded-md border border-[var(--border)] overflow-hidden"
              >
                {WINDOW_OPTIONS.map((w) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={w === days}
                    key={w}
                    onClick={() => setDays(w)}
                    className={
                      "px-3 py-1.5 text-xs mono focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] " +
                      (w === days
                        ? "bg-[var(--hover)]"
                        : "hover:bg-[var(--hover)]")
                    }
                  >
                    {w}d
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      {selected && (
        <UsagePanel
          loading={usageSwr.isLoading}
          error={usageSwr.error}
          data={usageSwr.data}
          selectedLabel={
            activeKeys.find((k) => k.id === selected)?.label || selected
          }
        />
      )}
    </div>
  );
}

function UsagePanel({
  loading,
  error,
  data,
  selectedLabel,
}: {
  loading: boolean;
  error: unknown;
  data: UsagePayload | undefined;
  selectedLabel: string;
}) {
  if (loading) {
    return (
      <Card title="Activity">
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonStat key={i} />
            ))}
          </div>
          <div className="h-32 rounded-md bg-[var(--hover)] animate-pulse" />
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card title="Activity">
        <ErrorBox err={error} />
      </Card>
    );
  }
  if (!data) return null;
  const hasTraffic = data.window.total > 0;
  const errorRate =
    data.window.total === 0
      ? 0
      : (data.window.client_error + data.window.server_error) /
        data.window.total;

  return (
    <>
      <Card
        title="Activity"
        right={
          <Badge tone={errorRate > 0.1 ? "warn" : "up"}>
            {(100 - errorRate * 100).toFixed(1)}% ok
          </Badge>
        }
      >
        {!hasTraffic ? (
          <Empty
            title={`No requests in the last ${data.window_days} days`}
            hint={`Lifetime total ${data.total_lifetime} request${data.total_lifetime === 1 ? "" : "s"} for ${selectedLabel}.`}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatTile
                label="Window total"
                value={data.window.total.toLocaleString()}
                icon={<Pulse size={14} weight="duotone" />}
              />
              <StatTile
                label="Success"
                value={data.window.success.toLocaleString()}
              />
              <StatTile
                label="Client error"
                value={data.window.client_error.toLocaleString()}
                tone={data.window.client_error > 0 ? "warn" : undefined}
              />
              <StatTile
                label="Server error"
                value={data.window.server_error.toLocaleString()}
                tone={data.window.server_error > 0 ? "warn" : undefined}
              />
            </div>
            <Sparkline points={data.daily} />
            <div className="text-[11px] muted mono">
              Lifetime {data.total_lifetime.toLocaleString()} requests
              {data.last_request_at
                ? ` · last seen ${fmt(data.last_request_at)}`
                : " · never seen"}
            </div>
          </div>
        )}
      </Card>

      <Card title="By route">
        {data.by_route.length === 0 ? (
          <Empty title="No route activity in window" />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {data.by_route.map((r) => (
              <li
                key={r.route_class}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm mono truncate">
                    {r.route_class}
                  </div>
                  <div className="text-[11px] muted mono">
                    {r.success} ok · {r.client_error} 4xx ·{" "}
                    {r.server_error} 5xx
                  </div>
                </div>
                <div className="text-sm mono tabular-nums">
                  {r.total.toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: "warn";
}) {
  return (
    <div className="panel p-3">
      <div className="muted text-[10px] uppercase tracking-widest flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div
        className={
          "mt-1 text-xl mono font-semibold tabular-nums " +
          (tone === "warn" ? "text-amber-500" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

function SkeletonStat() {
  return (
    <div className="panel p-3">
      <div className="h-3 w-16 rounded bg-[var(--hover)] animate-pulse" />
      <div className="mt-2 h-6 w-12 rounded bg-[var(--hover)] animate-pulse" />
    </div>
  );
}

function Sparkline({ points }: { points: DailyPoint[] }) {
  const max = useMemo(
    () => Math.max(1, ...points.map((p) => p.total)),
    [points],
  );
  const w = 600;
  const h = 96;
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - (p.total / max) * (h - 8) - 4;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div
      role="img"
      aria-label={`Daily request volume for ${points.length} day window, peak ${max}`}
      className="rounded-md border border-[var(--border)] p-2 overflow-hidden"
    >
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-24"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-[var(--accent)] opacity-80"
        />
        {points.map((p, i) => {
          const x = i * stepX;
          const y = h - (p.total / max) * (h - 8) - 4;
          return (
            <circle
              key={p.day}
              cx={x}
              cy={y}
              r={p.total > 0 ? 2 : 1}
              className="text-[var(--accent)]"
              fill="currentColor"
            >
              <title>{`${p.day}: ${p.total} (${p.success} ok, ${p.client_error} 4xx, ${p.server_error} 5xx)`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] muted mono">
        <span>{points[0]?.day}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function fmt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

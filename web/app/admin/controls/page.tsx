"use client";
// Admin control index. One screen that lists every enterprise control
// with its current status. Built for procurement walkthroughs: a buyer's
// security reviewer can scan the page top to bottom and tick boxes
// without spelunking through the sidebar.
import { useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Badge } from "@/components/ui";
import { swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  ShieldWarning,
  Warning,
  MagnifyingGlass,
  ArrowSquareOut,
  IdentificationCard,
  Database,
  Globe,
  Gauge,
  ChartLine,
  ArrowLeft,
  CheckCircle,
  Circle,
} from "@phosphor-icons/react/dist/ssr";

type Status = "enforcing" | "monitoring" | "configured" | "off" | "warning";
type Category = "identity" | "data" | "network" | "operations" | "observability";
type Row = {
  key: string;
  label: string;
  href: string;
  category: Category;
  status: Status;
  summary: string;
};
type Resp = {
  generated_at: string;
  admin_mode: "local" | "production";
  controls: Row[];
  counts: Record<Status, number>;
};

const CATEGORY_META: Record<
  Category,
  { label: string; icon: (props: { size: number; weight: "duotone" }) => ReactNode }
> = {
  identity: {
    label: "Identity and access",
    icon: (p) => <IdentificationCard {...p} />,
  },
  data: { label: "Data governance", icon: (p) => <Database {...p} /> },
  network: { label: "Network and edge", icon: (p) => <Globe {...p} /> },
  operations: { label: "Operations", icon: (p) => <Gauge {...p} /> },
  observability: {
    label: "Observability",
    icon: (p) => <ChartLine {...p} />,
  },
};

const STATUS_META: Record<Status, { label: string; tone: string; ring: string }> = {
  enforcing: {
    label: "Enforcing",
    tone: "text-emerald-400",
    ring: "ring-emerald-500/30 bg-emerald-500/5",
  },
  monitoring: {
    label: "Monitoring",
    tone: "text-sky-400",
    ring: "ring-sky-500/30 bg-sky-500/5",
  },
  configured: {
    label: "Configured",
    tone: "text-neutral-300",
    ring: "ring-neutral-700 bg-neutral-900/40",
  },
  warning: {
    label: "Review",
    tone: "text-amber-400",
    ring: "ring-amber-500/30 bg-amber-500/5",
  },
  off: { label: "Off", tone: "text-neutral-500", ring: "ring-neutral-800 bg-neutral-950" },
};

export default function AdminIndexPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading } = useSWR<Resp>("/admin/controls", swrFetcher, {
    refreshInterval: 30_000,
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.controls.filter((c) => {
      if (status !== "all" && c.status !== status) return false;
      if (!needle) return true;
      return (
        c.label.toLowerCase().includes(needle) ||
        c.summary.toLowerCase().includes(needle) ||
        c.key.toLowerCase().includes(needle)
      );
    });
  }, [data, q, status]);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <Loading label="Loading control inventory" />
      </div>
    );
  }
  if (error) {
    const msg =
      error instanceof ApiError && error.status === 403
        ? "Admin scope required to view the control inventory."
        : error instanceof Error
          ? error.message
          : String(error);
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <ErrorBox err={msg} />
      </div>
    );
  }
  if (!data) return null;

  const grouped = new Map<Category, Row[]>();
  for (const row of filtered) {
    const list = grouped.get(row.category) ?? [];
    list.push(row);
    grouped.set(row.category, list);
  }

  const categoryOrder: Category[] = [
    "identity",
    "data",
    "network",
    "operations",
    "observability",
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <ShieldCheck size={28} weight="duotone" className="mt-1 text-sky-500" />
          <div>
            <div className="muted text-[10px] uppercase tracking-widest">Admin</div>
            <h1 className="text-xl font-semibold tracking-tight">Control inventory</h1>
            <p className="mt-1 max-w-2xl text-sm text-neutral-500">
              Every enterprise control in one place. Status reflects the
              current policy, not its UI presence. Click any row to jump
              to the surface that lets you change it.
            </p>
          </div>
        </div>
        <Link
          href="/admin"
          className="muted inline-flex items-center gap-1.5 text-[11px] hover:text-white"
        >
          <ArrowLeft size={14} weight="duotone" /> Admin overview
        </Link>
      </header>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="up">
              <CheckCircle size={12} weight="duotone" />
              <span className="ml-1">{data.counts.enforcing} enforcing</span>
            </Badge>
            <Badge tone="up">
              <Circle size={12} weight="duotone" />
              <span className="ml-1">{data.counts.monitoring} monitoring</span>
            </Badge>
            <Badge tone="neutral">
              <Circle size={12} weight="duotone" />
              <span className="ml-1">{data.counts.configured} configured</span>
            </Badge>
            {data.counts.warning > 0 ? (
              <Badge tone="down">
                <Warning size={12} weight="duotone" />
                <span className="ml-1">{data.counts.warning} review</span>
              </Badge>
            ) : null}
            {data.counts.off > 0 ? (
              <Badge tone="neutral">
                <ShieldWarning size={12} weight="duotone" />
                <span className="ml-1">{data.counts.off} off</span>
              </Badge>
            ) : null}
            <span className="muted ml-2 text-[11px]">
              mode {data.admin_mode}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="relative">
              <MagnifyingGlass
                size={14}
                weight="duotone"
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
              />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search controls"
                aria-label="Search controls"
                className="w-56 rounded-md border border-neutral-800 bg-neutral-950 py-1 pl-7 pr-2 text-[12px] focus:border-neutral-600 focus:outline-none"
              />
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Status | "all")}
              aria-label="Filter by status"
              className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-[12px] focus:border-neutral-600 focus:outline-none"
            >
              <option value="all">All statuses</option>
              <option value="enforcing">Enforcing</option>
              <option value="monitoring">Monitoring</option>
              <option value="configured">Configured</option>
              <option value="warning">Review</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <div className="p-6 text-center text-sm text-neutral-500">
            No controls match the filter.
          </div>
        </Card>
      ) : (
        categoryOrder
          .filter((c) => grouped.has(c))
          .map((cat) => {
            const meta = CATEGORY_META[cat];
            const rows = grouped.get(cat) ?? [];
            return (
              <section key={cat} aria-labelledby={`cat-${cat}`} className="space-y-2">
                <h2
                  id={`cat-${cat}`}
                  className="muted inline-flex items-center gap-2 text-[11px] uppercase tracking-widest"
                >
                  {meta.icon({ size: 14, weight: "duotone" })} {meta.label}
                  <span className="text-neutral-600">({rows.length})</span>
                </h2>
                <Card>
                  <ul className="divide-y divide-[var(--border)]">
                    {rows.map((row) => {
                      const sm = STATUS_META[row.status];
                      return (
                        <li key={row.key}>
                          <Link
                            href={row.href}
                            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-1 py-3 hover:bg-white/[0.02] sm:gap-4"
                          >
                            <span
                              className={`inline-flex h-7 min-w-[88px] items-center justify-center rounded-full px-2 text-[10px] uppercase tracking-wide ring-1 ${sm.ring} ${sm.tone}`}
                            >
                              {sm.label}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-neutral-100">
                                {row.label}
                              </div>
                              <div className="muted truncate text-[11px]">
                                {row.summary}
                              </div>
                            </div>
                            <ArrowSquareOut
                              size={14}
                              weight="duotone"
                              className="text-neutral-500"
                              aria-hidden
                            />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              </section>
            );
          })
      )}

      <p className="muted text-[11px]">
        Generated {new Date(data.generated_at).toLocaleString()}. Refreshes every 30 seconds.
      </p>
    </div>
  );
}

"use client";
// Admin: per-tenant watchlist visibility.
//
// The /admin/watchlists endpoint already returns every tenant's
// watchlist keyed by owner_key_id (with __default__ holding the
// pre-tenancy operator bucket), but until now there was no surface
// for it. Enterprise security reviewers ask "show me, in one screen,
// every workspace and what they're tracking" before they sign; this
// page is that screen. Admin-scoped, MFA-gated on the server.
import useSWR from "swr";
import { useState, useMemo } from "react";
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
  Users,
  Eye,
  MagnifyingGlass,
  Buildings,
} from "@phosphor-icons/react/dist/ssr";

type Resp = { tenants: Record<string, string[]> };

export default function AdminWatchlistsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading } = useSWR<Resp>(
    "/admin/watchlists",
    swrFetcher,
  );
  const [filter, setFilter] = useState("");

  const tenants = useMemo(() => {
    if (!data?.tenants) return [] as Array<[string, string[]]>;
    const q = filter.trim().toLowerCase();
    return Object.entries(data.tenants)
      .filter(([owner, tickers]) => {
        if (!q) return true;
        if (owner.toLowerCase().includes(q)) return true;
        return tickers.some((t) => t.toLowerCase().includes(q));
      })
      .sort(([a], [b]) => {
        // __default__ pinned last so legacy bucket doesn't dominate.
        if (a === "__default__") return 1;
        if (b === "__default__") return -1;
        return a.localeCompare(b);
      });
  }, [data, filter]);

  const totalTickers = useMemo(() => {
    if (!data?.tenants) return 0;
    return Object.values(data.tenants).reduce((n, ts) => n + ts.length, 0);
  }, [data]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <Buildings size={14} weight="duotone" />
          <span>Admin</span>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-200">Tenant watchlists</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-100 flex items-center gap-2">
          <Eye size={22} weight="duotone" className="text-zinc-300" />
          Tenant watchlists
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Every API key&apos;s watchlist in one place. The{" "}
          <code className="text-zinc-300">__default__</code> bucket holds
          legacy tickers added before per-tenant scoping; assign them an
          owner or prune them as part of cleanup.
        </p>
      </header>

      {isLoading && <Loading />}
      {error && (
        <ErrorBox err={error} />
      )}

      {data && (
        <>
          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-2 text-zinc-300">
                  <Users size={14} weight="duotone" />
                  <span className="font-medium">
                    {Object.keys(data.tenants).length}
                  </span>
                  <span className="text-zinc-500">tenants</span>
                </div>
                <div className="flex items-center gap-2 text-zinc-300">
                  <Eye size={14} weight="duotone" />
                  <span className="font-medium">{totalTickers}</span>
                  <span className="text-zinc-500">tracked tickers</span>
                </div>
              </div>
              <label className="relative flex items-center w-full sm:w-72">
                <MagnifyingGlass
                  size={14}
                  weight="duotone"
                  className="absolute left-3 text-zinc-500"
                />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by tenant or ticker"
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 pl-8 pr-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                />
              </label>
            </div>
          </Card>

          <div className="mt-4 space-y-3">
            {tenants.length === 0 && (
              <Empty
                title="No tenants yet"
                hint="Watchlists will appear here as API keys start adding tickers."
              />
            )}
            {tenants.map(([owner, tickers]) => (
              <Card key={owner}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="text-sm text-zinc-100 break-all">
                        {owner}
                      </code>
                      {owner === "__default__" && (
                        <Badge>legacy</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {tickers.length} ticker{tickers.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:max-w-[60%] sm:justify-end">
                    {tickers.length === 0 ? (
                      <span className="text-xs text-zinc-600">empty</span>
                    ) : (
                      tickers.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                        >
                          {t}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

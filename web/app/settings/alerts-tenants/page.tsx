"use client";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import { swrFetcher } from "@/lib/api";
import { Bell, Users, ChartLine } from "@phosphor-icons/react/dist/ssr";

type TenantRow = {
  owner_id: string;
  alert_count: number;
  armed: number;
  history_count: number;
};

type Summary = {
  tenants: TenantRow[];
  total_alerts: number;
  total_history: number;
};

export default function AdminAlertsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function shortOwner(id: string): string {
  if (id === "__operator__") return "operator (cookie session)";
  return id;
}

function Inner() {
  const { data, error, isLoading } = useSWR<Summary>(
    "/admin/alerts",
    swrFetcher,
    { refreshInterval: 10_000 },
  );

  if (isLoading) return <Loading label="Loading alert tenants" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const tenants = data.tenants;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bell weight="duotone" className="h-7 w-7" />
          Alert tenants
        </h1>
        <p className="text-sm text-neutral-500">
          Per-API-key alert footprint. Each tenant bucket is isolated: alerts
          armed by one key are invisible to and undeletable by any other key.
          This view exposes counts only, never the alert rows themselves.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
            <Users weight="duotone" className="h-4 w-4" /> Tenants
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {tenants.length}
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
            <Bell weight="duotone" className="h-4 w-4" /> Alerts
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {data.total_alerts}
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
            <ChartLine weight="duotone" className="h-4 w-4" /> History rows
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {data.total_history}
          </div>
        </Card>
      </div>

      <Card>
        {tenants.length === 0 ? (
          <Empty
            title="No alert tenants yet"
            hint="Arm an alert via /api/v1/alerts to create a tenant bucket."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4">Owner</th>
                  <th className="py-2 pr-4 text-right">Alerts</th>
                  <th className="py-2 pr-4 text-right">Armed</th>
                  <th className="py-2 pr-4 text-right">History</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/60 dark:divide-neutral-800/60">
                {tenants.map((t) => (
                  <tr key={t.owner_id}>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {shortOwner(t.owner_id)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {t.alert_count}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Badge tone={t.armed > 0 ? "up" : "neutral"}>
                        {t.armed}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {t.history_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

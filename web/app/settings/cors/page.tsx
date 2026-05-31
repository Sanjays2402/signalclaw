"use client";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Loading, ErrorBox, Badge } from "@/components/ui";
import { swrFetcher, ApiError } from "@/lib/api";
import {
  Globe,
  ShieldCheck,
  ShieldWarning,
  Lock,
  LockOpen,
} from "@phosphor-icons/react/dist/ssr";

type CorsView = {
  production: boolean;
  origins: string[];
  loopback_default: boolean;
  allow_methods: string;
  allow_headers: string;
  expose_headers: string;
  max_age: string;
};

export default function CorsPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { data, error, isLoading } = useSWR<CorsView>(
    "/admin/cors",
    swrFetcher,
  );

  if (error) {
    const msg =
      error instanceof ApiError
        ? error.status === 403
          ? "You need an admin API key to view the CORS policy."
          : error.body || error.message
        : (error as Error).message;
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorBox err={msg} />
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Loading label="Loading CORS policy" />
      </div>
    );
  }

  const empty = data.origins.length === 0;
  const postureLabel = data.production ? "production" : "local single-user";
  const effective = data.production
    ? empty
      ? "Browser origins denied. Server to server only."
      : `${data.origins.length} origin${data.origins.length === 1 ? "" : "s"} permitted from the browser.`
    : empty
      ? "Loopback default: http://localhost and http://127.0.0.1 are permitted while no allowlist is set."
      : `${data.origins.length} origin${data.origins.length === 1 ? "" : "s"} permitted from the browser.`;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Admin
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <Globe size={18} weight="duotone" /> CORS policy
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Cross-origin browser access to the API. The allowlist is driven
            by the SIGNALCLAW_CORS_ORIGINS environment variable so a hosting
            team controls it through the deploy pipeline, not the dashboard.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="text-[11px] muted hover:text-white"
          >
            Settings
          </Link>
          <Link
            href="/settings/network"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <Lock size={14} weight="duotone" /> Network
          </Link>
        </div>
      </header>

      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-medium inline-flex items-center gap-2">
              {data.production ? (
                <ShieldCheck size={14} weight="duotone" />
              ) : (
                <ShieldWarning size={14} weight="duotone" />
              )}
              Posture
            </div>
            <div className="muted text-xs mt-1">{effective}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{postureLabel}</Badge>
            {data.loopback_default ? (
              <Badge>
                <LockOpen size={11} weight="duotone" /> loopback default
              </Badge>
            ) : null}
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Permitted origins{" "}
              <span className="muted text-[11px]">
                ({data.origins.length})
              </span>
            </div>
          </div>
          {data.origins.length === 0 ? (
            <div className="muted text-xs border border-dashed border-white/10 rounded p-4">
              No origins configured. Set SIGNALCLAW_CORS_ORIGINS to a comma
              separated list of exact origins, then redeploy. Example:{" "}
              <code className="mono">
                SIGNALCLAW_CORS_ORIGINS=https://app.example.com,https://admin.example.com
              </code>
              .
            </div>
          ) : (
            <ul className="divide-y divide-white/5 border border-white/10 rounded">
              {data.origins.map((o) => (
                <li
                  key={o}
                  className="px-3 py-2 flex items-center justify-between gap-3"
                >
                  <span className="mono text-xs break-all">{o}</span>
                  <Badge>allowed</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <div className="space-y-2 text-xs">
          <div className="text-sm font-medium">Preflight contract</div>
          <Row label="Allow methods" value={data.allow_methods} />
          <Row label="Allow headers" value={data.allow_headers} />
          <Row label="Expose headers" value={data.expose_headers} />
          <Row label="Max age" value={`${data.max_age} seconds`} />
          <Row
            label="Credentials"
            value="Echoed only for allowlisted origins. Never sent with wildcard."
          />
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-start">
      <div className="muted">{label}</div>
      <div className="mono break-all">{value}</div>
    </div>
  );
}

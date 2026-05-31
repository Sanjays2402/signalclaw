"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  Globe,
  ShieldCheck,
  Warning,
  CheckCircle,
  MapPin,
} from "@phosphor-icons/react/dist/ssr";

type Policy = {
  region: "us" | "eu" | "ap" | "global";
  mode: "off" | "monitor" | "enforce";
  updated_at: string;
  updated_by: string | null;
};

type Self = {
  region: Policy["region"];
  source: "explicit" | "country" | "unknown";
  raw: string | null;
};

type Resp = {
  policy: Policy;
  self: Self;
  options: { regions: Policy["region"][]; modes: Policy["mode"][] };
};

const REGION_LABEL: Record<Policy["region"], string> = {
  us: "Americas",
  eu: "EU + UK + EEA",
  ap: "Asia Pacific",
  global: "Any region",
};

const MODE_LABEL: Record<Policy["mode"], string> = {
  off: "Off",
  monitor: "Monitor only",
  enforce: "Enforce",
};

export default function ResidencyPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function ModeBadge({ mode }: { mode: Policy["mode"] }) {
  if (mode === "enforce") {
    return (
      <Badge tone="up">
        <ShieldCheck size={11} weight="duotone" /> enforcing
      </Badge>
    );
  }
  if (mode === "monitor") {
    return (
      <Badge tone="warn">
        <Warning size={11} weight="duotone" /> monitor
      </Badge>
    );
  }
  return <Badge tone="neutral">off</Badge>;
}

function Inner() {
  const { data, error, isLoading, mutate } = useSWR<Resp>(
    "/admin/residency",
    swrFetcher,
  );

  const [region, setRegion] = useState<Policy["region"]>("global");
  const [mode, setMode] = useState<Policy["mode"]>("off");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.policy) {
      setRegion(data.policy.region);
      setMode(data.policy.mode);
    }
  }, [data?.policy]);

  const selfWouldBeBlocked = useMemo(() => {
    if (!data) return false;
    if (mode !== "enforce") return false;
    if (region === "global") return false;
    return data.self.region !== region;
  }, [data, mode, region]);

  async function save() {
    setFormError(null);
    setMsg(null);
    setSaving(true);
    try {
      await api("/admin/residency", {
        method: "PUT",
        body: JSON.stringify({ region, mode }),
      });
      setMsg("Residency policy updated.");
      await mutate();
    } catch (e: any) {
      const body = e instanceof ApiError ? e.body : String(e?.message || e);
      setFormError(`Save failed: ${body}`);
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  const p = data.policy;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Security
          </div>
          <h1 className="text-lg font-semibold mono inline-flex items-center gap-2">
            <Globe size={18} weight="duotone" /> Data residency
          </h1>
          <p className="muted text-xs mt-1 max-w-xl">
            Pin this workspace to a region. Mutating /v1 requests that
            resolve to a different region get blocked with HTTP 451 and an
            audit line. Monitor mode logs mismatches without blocking.
          </p>
        </div>
        <Link href="/settings" className="text-[11px] muted hover:text-white">
          Back to settings
        </Link>
      </header>

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <MapPin size={14} weight="duotone" />
          <h2 className="text-sm font-medium">Current policy</h2>
          <ModeBadge mode={p.mode} />
          <span className="muted text-[10px]">
            region: <code>{p.region}</code>
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Field label="Pinned region">
              <select
                value={region}
                onChange={(e) =>
                  setRegion(e.target.value as Policy["region"])
                }
                className="w-full bg-transparent border border-white/10 rounded px-2 py-1 text-sm"
                aria-label="Pinned region"
              >
                {data.options.regions.map((r) => (
                  <option key={r} value={r} className="bg-black">
                    {r} &middot; {REGION_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="text-[10px] muted mt-1">
              Pick &quot;global&quot; to disable region matching while still
              recording region metadata in headers.
            </div>
          </div>
          <div>
            <Field label="Enforcement mode">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Policy["mode"])}
                className="w-full bg-transparent border border-white/10 rounded px-2 py-1 text-sm"
                aria-label="Enforcement mode"
              >
                {data.options.modes.map((m) => (
                  <option key={m} value={m} className="bg-black">
                    {m} &middot; {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="text-[10px] muted mt-1">
              Monitor logs mismatches. Enforce blocks mutating requests with
              HTTP 451.
            </div>
          </div>
        </div>

        {selfWouldBeBlocked && (
          <div className="mt-3 text-[11px] text-amber-300 inline-flex items-center gap-1">
            <Warning size={12} weight="duotone" /> This browser resolved to
            region <code>{data.self.region}</code>. Saving enforce mode for
            <code> {region}</code> will block writes from your current
            location.
          </div>
        )}
        {formError && (
          <div className="text-[11px] text-red-400 mt-2">{formError}</div>
        )}
        {msg && (
          <div className="text-[11px] text-emerald-400 mt-2 inline-flex items-center gap-1">
            <CheckCircle size={12} weight="duotone" /> {msg}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <div className="muted text-[10px]">
            Last updated {p.updated_at}
            {p.updated_by ? ` by ${p.updated_by}` : ""}
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving" : "Save policy"}
          </Button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Globe size={14} weight="duotone" />
          <h2 className="text-sm font-medium">This request</h2>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <dt className="muted">Resolved region</dt>
          <dd className="mono">{data.self.region}</dd>
          <dt className="muted">Source</dt>
          <dd className="mono">{data.self.source}</dd>
          <dt className="muted">Country header</dt>
          <dd className="mono">{data.self.raw ?? "(none)"}</dd>
        </dl>
        <p className="muted text-[10px] mt-3">
          Send <code>x-data-region: us|eu|ap</code> from server-to-server
          callers to assert provenance. Edge country headers
          (<code>x-vercel-ip-country</code>, <code>cf-ipcountry</code>) are
          honored when no explicit hint is present.
        </p>
      </Card>
    </main>
  );
}

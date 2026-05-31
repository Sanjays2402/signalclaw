"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Input,
  Select,
  Field,
  Badge,
} from "@/components/ui";
import {
  UserCircle,
  Bell,
  ShieldWarning,
  DownloadSimple,
  Trash,
  CheckCircle,
  Key,
  Globe,
  ArchiveBox,
  UserPlus,
  ArrowsClockwise,
  FileLock,
  LockKey,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

type NotificationPrefs = {
  email_digest: boolean;
  digest_frequency: "daily" | "weekly" | "off";
  alert_kinds: string[];
  quiet_hours_start: number;
  quiet_hours_end: number;
};
type Profile = {
  display_name: string;
  email: string;
  timezone: string;
  base_currency: string;
};
type Settings = {
  profile: Profile;
  notifications: NotificationPrefs;
  updated_at: string;
};

const ALERT_KINDS = [
  { id: "entered", label: "Entered watchlist" },
  { id: "exited", label: "Exited watchlist" },
  { id: "upgraded", label: "Score upgraded" },
  { id: "downgraded", label: "Score downgraded" },
  { id: "score_jump", label: "Score jump" },
];

const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then(async (r) => {
    const t = await r.text();
    if (!r.ok) throw new Error(t || `${r.status}`);
    return JSON.parse(t);
  });

export default function SettingsPage() {
  return (
    <AuthGate>
      <Settings />
    </AuthGate>
  );
}

function Settings() {
  const { data, error, isLoading, mutate } = useSWR<Settings>(
    "/api/settings",
    fetcher,
  );

  if (isLoading) return <Loading label="Loading settings" />;
  if (error) return <ErrorBox err={error} />;
  if (!data) return null;

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Account
          </div>
          <h1 className="text-lg font-semibold mono">Settings</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/settings/keys"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <Key size={14} weight="duotone" /> API keys
          </Link>
          <Link
            href="/settings/security"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ShieldWarning size={14} weight="duotone" /> Security
          </Link>
          <Link
            href="/settings/security/rotation"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} weight="duotone" /> Rotation
          </Link>
          <Link
            href="/settings/security/residency"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <Globe size={14} weight="duotone" /> Residency
          </Link>
          <Link
            href="/settings/network"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <Globe size={14} weight="duotone" /> Network
          </Link>
          <Link
            href="/settings/siem"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <FileLock size={14} weight="duotone" /> SIEM
          </Link>
          <Link
            href="/settings/cors"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <Globe size={14} weight="duotone" /> CORS
          </Link>
          <Link
            href="/settings/retention"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ArchiveBox size={14} weight="duotone" /> Retention
          </Link>
          <Link
            href="/settings/invites"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <UserPlus size={14} weight="duotone" /> Invites
          </Link>
          <Link
            href="/settings/idempotency"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise size={14} weight="duotone" /> Idempotency
          </Link>
          <Link
            href="/settings/privacy"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <FileLock size={14} weight="duotone" /> Privacy
          </Link>
          <Link
            href="/settings/admin-mfa"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <ShieldWarning size={14} weight="duotone" /> Admin MFA
          </Link>
          <Link
            href="/settings/auth-lockout"
            className="text-[11px] muted hover:text-white inline-flex items-center gap-1.5"
          >
            <LockKey size={14} weight="duotone" /> Auth lockout
          </Link>
          <Link
            href="/usage"
            className="text-[11px] muted hover:text-white"
          >
            Usage
          </Link>
        </div>
      </header>

      <ProfileCard settings={data} onSaved={mutate} />
      <NotificationsCard settings={data} onSaved={mutate} />
      <AccountDataCard onChanged={mutate} />
    </div>
  );
}

function ProfileCard({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) {
  const [p, setP] = useState<Profile>(settings.profile);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => setP(settings.profile), [settings.profile]);

  const dirty = useMemo(
    () =>
      p.display_name !== settings.profile.display_name ||
      p.email !== settings.profile.email ||
      p.timezone !== settings.profile.timezone ||
      p.base_currency !== settings.profile.base_currency,
    [p, settings.profile],
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: p }),
      });
      const txt = await r.text();
      if (!r.ok) {
        const body = txt ? JSON.parse(txt) : null;
        throw new Error(body?.error?.message || txt || `${r.status}`);
      }
      setOk(true);
      onSaved();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <UserCircle size={12} weight="duotone" /> Profile
        </span>
      }
    >
      <form onSubmit={save} className="space-y-3" aria-label="Profile">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Display name">
            <Input
              value={p.display_name}
              onChange={(e) => setP({ ...p, display_name: e.target.value })}
              placeholder="Sanjay"
              maxLength={80}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={p.email}
              onChange={(e) => setP({ ...p, email: e.target.value })}
              placeholder="you@example.com"
              maxLength={200}
            />
          </Field>
          <Field label="Timezone">
            <Input
              value={p.timezone}
              onChange={(e) => setP({ ...p, timezone: e.target.value })}
              placeholder="America/Los_Angeles"
            />
          </Field>
          <Field label="Base currency">
            <Input
              value={p.base_currency}
              onChange={(e) =>
                setP({ ...p, base_currency: e.target.value.toUpperCase() })
              }
              placeholder="USD"
              maxLength={3}
            />
          </Field>
        </div>
        {err && (
          <div className="text-[11px] text-[var(--red)] mono">{err}</div>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!dirty || busy}>
            {busy ? "Saving" : "Save profile"}
          </Button>
          {ok && (
            <span className="text-[11px] mono inline-flex items-center gap-1 text-[var(--green,#4ade80)]">
              <CheckCircle size={12} weight="duotone" /> Saved
            </span>
          )}
          <span className="muted text-[10px] ml-auto">
            Updated {new Date(settings.updated_at).toLocaleString()}
          </span>
        </div>
      </form>
    </Card>
  );
}

function NotificationsCard({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) {
  const [n, setN] = useState<NotificationPrefs>(settings.notifications);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => setN(settings.notifications), [settings.notifications]);

  function toggleKind(id: string) {
    setN((cur) =>
      cur.alert_kinds.includes(id)
        ? { ...cur, alert_kinds: cur.alert_kinds.filter((k) => k !== id) }
        : { ...cur, alert_kinds: [...cur.alert_kinds, id] },
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notifications: n }),
      });
      const txt = await r.text();
      if (!r.ok) {
        const body = txt ? JSON.parse(txt) : null;
        throw new Error(body?.error?.message || txt || `${r.status}`);
      }
      setOk(true);
      onSaved();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <Bell size={12} weight="duotone" /> Notifications
        </span>
      }
    >
      <form onSubmit={save} className="space-y-3" aria-label="Notifications">
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={n.email_digest}
            onChange={(e) => setN({ ...n, email_digest: e.target.checked })}
          />
          <span>Email me a digest of new picks</span>
        </label>
        <p className="text-[11px] muted">
          Preview what the digest will look like at{' '}
          <a href="/digest" className="underline">/digest</a>.
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Digest frequency">
            <Select
              value={n.digest_frequency}
              onChange={(e) =>
                setN({
                  ...n,
                  digest_frequency: e.target.value as NotificationPrefs["digest_frequency"],
                })
              }
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          <Field label="Quiet hours start">
            <Input
              type="number"
              min={0}
              max={23}
              value={n.quiet_hours_start}
              onChange={(e) =>
                setN({ ...n, quiet_hours_start: Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Quiet hours end">
            <Input
              type="number"
              min={0}
              max={23}
              value={n.quiet_hours_end}
              onChange={(e) =>
                setN({ ...n, quiet_hours_end: Number(e.target.value) })
              }
            />
          </Field>
        </div>
        <div>
          <div className="muted text-[10px] mb-2 uppercase tracking-widest">
            Alert kinds
          </div>
          <div className="flex flex-wrap gap-2">
            {ALERT_KINDS.map((k) => {
              const on = n.alert_kinds.includes(k.id);
              return (
                <button
                  type="button"
                  key={k.id}
                  onClick={() => toggleKind(k.id)}
                  className={
                    "px-2 py-1 rounded-sm text-[11px] mono border transition " +
                    (on
                      ? "bg-[var(--amber)]/15 border-[var(--amber)]/60 text-white"
                      : "border-[var(--border-strong)] muted hover:text-white")
                  }
                  aria-pressed={on}
                >
                  {k.label}
                </button>
              );
            })}
          </div>
        </div>
        {err && (
          <div className="text-[11px] text-[var(--red)] mono">{err}</div>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving" : "Save notifications"}
          </Button>
          {ok && (
            <span className="text-[11px] mono inline-flex items-center gap-1 text-[var(--green,#4ade80)]">
              <CheckCircle size={12} weight="duotone" /> Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function AccountDataCard({ onChanged }: { onChanged: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<string[] | null>(null);

  async function doDelete() {
    setBusy(true);
    setErr(null);
    setDeleted(null);
    try {
      const r = await fetch("/api/settings/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const txt = await r.text();
      if (!r.ok) {
        const body = txt ? JSON.parse(txt) : null;
        throw new Error(body?.error?.message || txt || `${r.status}`);
      }
      const out = JSON.parse(txt);
      setDeleted(out.deleted || []);
      setConfirm("");
      onChanged();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <ShieldWarning size={12} weight="duotone" /> Account data
        </span>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[12px]">Export a copy of your local data</div>
            <div className="muted text-[11px]">
              Runs, journal, watchlist, alerts, webhooks, batch jobs, quota,
              settings. JSON bundle.
            </div>
          </div>
          <a
            href="/api/settings/export"
            className="rounded-sm px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest border border-[var(--border-strong)] text-[var(--fg-dim)] hover:bg-white/[0.04] hover:text-white inline-flex items-center gap-1.5"
          >
            <DownloadSimple size={12} weight="duotone" /> Download
          </a>
        </div>

        <div className="border-t border-[var(--border)] pt-4">
          <div className="text-[12px] mb-1">Delete account data</div>
          <div className="muted text-[11px] mb-3">
            Wipes all local store files under web/.data. This cannot be undone.
            Type <span className="mono text-white">DELETE</span> to confirm.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="DELETE"
              className="!w-40"
              aria-label="Type DELETE to confirm"
            />
            <Button
              type="button"
              variant="danger"
              disabled={confirm !== "DELETE" || busy}
              onClick={doDelete}
            >
              <span className="inline-flex items-center gap-1">
                <Trash size={12} weight="duotone" />
                {busy ? "Deleting" : "Delete all data"}
              </span>
            </Button>
          </div>
          {err && (
            <div className="text-[11px] text-[var(--red)] mono mt-2">
              {err}
            </div>
          )}
          {deleted && (
            <div className="text-[11px] mono mt-2">
              <Badge>Deleted {deleted.length}</Badge>{" "}
              <span className="muted">{deleted.join(", ") || "nothing to delete"}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Loading,
  ErrorBox,
  Button,
  Field,
  Input,
  Badge,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import {
  ShieldCheck,
  Buildings,
  Plus,
  Trash,
  PencilSimple,
  ArrowSquareOut,
  CheckCircle,
  Warning,
} from "@phosphor-icons/react/dist/ssr";

type Entry = {
  id: string;
  name: string;
  purpose: string;
  country: string;
  url: string;
  data_categories: string[];
  added_at: string;
  updated_at: string;
};
type Registry = {
  version: number;
  updated_at: string;
  entries: Entry[];
};

const EMPTY_FORM = {
  name: "",
  purpose: "",
  country: "",
  url: "",
  data_categories: "",
};

function parseCats(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function SubprocessorsAdmin() {
  const { data, error, isLoading, mutate } = useSWR<Registry>(
    "/admin/subprocessors",
    swrFetcher,
  );

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function resetForm() {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
  }

  function loadInto(e: Entry) {
    setEditingId(e.id);
    setForm({
      name: e.name,
      purpose: e.purpose,
      country: e.country,
      url: e.url,
      data_categories: e.data_categories.join(", "),
    });
    setErr(null);
    setMsg(null);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const body = {
        name: form.name.trim(),
        purpose: form.purpose.trim(),
        country: form.country.trim().toUpperCase(),
        url: form.url.trim(),
        data_categories: parseCats(form.data_categories),
      };
      if (editingId) {
        await api(`/admin/subprocessors/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        });
        setMsg(`Updated ${body.name}.`);
      } else {
        await api(`/admin/subprocessors`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        });
        setMsg(`Added ${body.name}.`);
      }
      resetForm();
      await mutate();
    } catch (e) {
      const m = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(m || "failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove subprocessor "${name}"? This is public-facing.`)) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(`/admin/subprocessors/${id}`, { method: "DELETE" });
      setMsg(`Removed ${name}.`);
      if (editingId === id) resetForm();
      await mutate();
    } catch (e) {
      const m = e instanceof ApiError ? e.body || e.message : (e as Error).message;
      setErr(m || "failed");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox err={error} />;

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">
            Compliance
          </div>
          <h1 className="text-lg font-semibold mono flex items-center gap-2">
            <ShieldCheck size={20} weight="duotone" /> Subprocessors
          </h1>
          <p className="text-xs text-zinc-400 mt-1 max-w-2xl">
            Public registry of third-party data processors. Surfaced at{" "}
            <Link
              href="/trust/subprocessors"
              className="underline hover:text-white"
              target="_blank"
            >
              /trust/subprocessors
            </Link>{" "}
            for prospect DPA reviews. Every change is audit logged.
          </p>
        </div>
        <Badge>v{data?.version ?? 0}</Badge>
      </header>

      {msg && (
        <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle size={14} weight="duotone" /> {msg}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300 flex items-start gap-2">
          <Warning size={14} weight="duotone" className="mt-0.5" />
          <pre className="whitespace-pre-wrap break-words">{err}</pre>
        </div>
      )}

      <Card>
        <div className="text-xs font-semibold mb-3">
          {editingId ? `Editing ${editingId}` : "Add subprocessor"}
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Vendor name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Stripe, Inc."
              disabled={!!editingId}
            />
          </Field>
          <Field label="Country (ISO-3166 alpha-2)">
            <Input
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              placeholder="US"
              maxLength={2}
            />
          </Field>
          <Field label="Purpose">
            <Input
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              placeholder="Payment processing for paid plans"
            />
          </Field>
          <Field label="Privacy / DPA URL">
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://stripe.com/privacy"
            />
          </Field>
          <Field label="Data categories (comma separated)">
            <Input
              value={form.data_categories}
              onChange={(e) =>
                setForm({ ...form, data_categories: e.target.value })
              }
              placeholder="email, billing_address, last4"
            />
          </Field>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Button onClick={submit} disabled={busy}>
            <Plus size={14} weight="duotone" />
            <span className="ml-1">{editingId ? "Save changes" : "Add"}</span>
          </Button>
          {editingId && (
            <Button variant="ghost" onClick={resetForm} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between text-xs mb-3">
          <span className="font-semibold">Active subprocessors</span>
          <span className="muted font-mono">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-500">
            <Buildings size={28} weight="duotone" className="mx-auto mb-2" />
            None yet. Add the first one above.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/80">
            {entries.map((e) => (
              <li
                key={e.id}
                className="py-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-zinc-100 truncate flex items-center gap-2">
                    {e.name}
                    <Badge>{e.country}</Badge>
                  </div>
                  <div className="text-[11px] text-zinc-400 truncate">
                    {e.purpose}
                  </div>
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-zinc-500 hover:text-white inline-flex items-center gap-1 mt-0.5"
                  >
                    {e.url} <ArrowSquareOut size={10} weight="duotone" />
                  </a>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" onClick={() => loadInto(e)} disabled={busy}>
                    <PencilSimple size={13} weight="duotone" />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => remove(e.id, e.name)}
                    disabled={busy}
                  >
                    <Trash size={13} weight="duotone" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <SubprocessorsAdmin />
      </div>
    </AuthGate>
  );
}

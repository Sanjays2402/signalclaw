"use client";
import useSWR from "swr";
import Link from "next/link";
import {
  ShieldCheck,
  Globe,
  Buildings,
  ClockClockwise,
  ArrowSquareOut,
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
type Change = {
  ts: string;
  version: number;
  action: "add" | "update" | "remove";
  actor: string;
  before: Entry | null;
  after: Entry | null;
};

const BASE = process.env.NEXT_PUBLIC_API_URL || "";

const fetcher = (path: string) =>
  fetch(`${BASE}${path}`, { cache: "no-store" }).then(async (r) => {
    const txt = await r.text();
    if (!r.ok) throw new Error(txt || `${r.status}`);
    return JSON.parse(txt);
  });

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function changeLabel(c: Change): string {
  const target = (c.after?.name ?? c.before?.name ?? "(unknown)") + "";
  if (c.action === "add") return `Added ${target}`;
  if (c.action === "remove") return `Removed ${target}`;
  return `Updated ${target}`;
}

export default function TrustSubprocessorsPage() {
  const { data, error, isLoading } = useSWR<Registry>(
    "/trust/subprocessors",
    fetcher,
    { refreshInterval: 60_000 },
  );
  const { data: histData } = useSWR<{ changes: Change[] }>(
    "/trust/subprocessors/history?limit=50",
    fetcher,
    { refreshInterval: 120_000 },
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="muted text-[10px] uppercase tracking-widest mb-1">
              Trust Center
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold flex items-center gap-2">
              <ShieldCheck size={28} weight="duotone" /> Subprocessors
            </h1>
            <p className="text-sm text-zinc-400 mt-2 max-w-2xl">
              The third parties Signalclaw uses to deliver the service.
              We give customers at least 30 days&apos; notice before adding
              a new subprocessor that handles customer data.
            </p>
          </div>
          <Link
            href="/"
            className="text-[11px] text-zinc-400 hover:text-white whitespace-nowrap"
          >
            Back to app
          </Link>
        </header>

        {isLoading && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-400">
            Loading subprocessors...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300 flex items-start gap-2">
            <Warning size={18} weight="duotone" className="mt-0.5" />
            <div>
              <div className="font-medium">Could not load registry.</div>
              <div className="text-xs text-red-400/80 mt-1">
                {(error as Error).message}
              </div>
            </div>
          </div>
        )}

        {data && (
          <>
            <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-3 font-mono">
              <span>
                version {data.version} &middot; updated {fmtDate(data.updated_at)}
              </span>
              <span>{data.entries.length} active</span>
            </div>

            {data.entries.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center">
                <Buildings size={32} weight="duotone" className="mx-auto mb-2 text-zinc-500" />
                <div className="text-sm text-zinc-300">No subprocessors listed.</div>
                <div className="text-xs text-zinc-500 mt-1">
                  Signalclaw does not currently use any third-party data processors.
                </div>
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {data.entries.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-zinc-100">{e.name}</div>
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 border border-zinc-800 rounded px-1.5 py-0.5">
                        <Globe size={11} weight="duotone" /> {e.country}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-2">{e.purpose}</p>
                    {e.data_categories.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {e.data_categories.map((c) => (
                          <span
                            key={c}
                            className="text-[10px] font-mono text-zinc-300 bg-zinc-800/60 rounded px-1.5 py-0.5"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-auto pt-3 flex items-center justify-between text-[11px]">
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-400 hover:text-white inline-flex items-center gap-1"
                      >
                        Privacy <ArrowSquareOut size={11} weight="duotone" />
                      </a>
                      <span className="text-zinc-500 font-mono">
                        since {fmtDate(e.added_at)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {histData && histData.changes.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-3 text-zinc-300">
              <ClockClockwise size={18} weight="duotone" /> Change history
            </h2>
            <ol className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/80">
              {histData.changes.map((c, i) => (
                <li
                  key={`${c.version}-${i}`}
                  className="px-4 py-2.5 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-zinc-500 w-20 shrink-0">
                      v{c.version}
                    </span>
                    <span className="text-zinc-300 truncate">{changeLabel(c)}</span>
                  </div>
                  <span className="font-mono text-zinc-500 shrink-0 ml-2">
                    {fmtDate(c.ts)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}

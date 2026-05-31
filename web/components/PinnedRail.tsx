"use client";
import useSWR from "swr";
import Link from "next/link";
import { PushPin } from "@phosphor-icons/react/dist/ssr";
import { Badge } from "@/components/ui";

type PinnedRun = {
  id: string;
  label: string;
  ticker: string;
  regime: string | null;
  confidence: number | null;
  created_at: string;
};
type Resp = { runs: PinnedRun[]; total: number };

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

function tone(regime: string | null): "up" | "down" | "warn" | "info" {
  if (regime === "bull") return "up";
  if (regime === "chop") return "warn";
  if (regime === "bear" || regime === "crash") return "down";
  return "info";
}

export default function PinnedRail() {
  const { data, isLoading } = useSWR<Resp>(
    "/api/runs?pinned=1&limit=8",
    fetcher,
    { refreshInterval: 0 },
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-10 w-44 shrink-0 rounded-sm border border-[var(--border)] animate-pulse bg-white/[0.02]"
          />
        ))}
      </div>
    );
  }
  const runs = data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <section className="panel p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <PushPin
          size={14}
          weight="fill"
          style={{ color: "var(--amber)" }}
          aria-hidden
        />
        <h2 className="text-[11px] mono uppercase tracking-widest font-semibold">
          Pinned ({runs.length})
        </h2>
        <span className="muted text-[10px] mono">
          Quick access to your starred runs
        </span>
      </div>
      <div
        className="flex items-stretch gap-2 overflow-x-auto pb-1"
        role="list"
        aria-label="Pinned runs"
      >
        {runs.map((r) => (
          <Link
            key={r.id}
            href={`/r/${r.id}`}
            role="listitem"
            className="shrink-0 min-w-[200px] max-w-[260px] border border-[var(--border-strong)] rounded-sm px-2.5 py-2 hover:bg-white/5 hover:border-[var(--amber)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
            title={`${r.label} (${r.ticker})`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className="mono text-[10px] uppercase tracking-widest muted">
                {r.ticker}
              </span>
              {r.regime && (
                <Badge tone={tone(r.regime)}>{r.regime.toUpperCase()}</Badge>
              )}
              {r.confidence !== null && (
                <span className="ml-auto mono text-[10px] muted">
                  {Math.round(r.confidence * 100)}%
                </span>
              )}
            </div>
            <div className="text-[12px] mono truncate font-semibold">
              {r.label}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

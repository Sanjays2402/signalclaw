"use client";
import Link from "next/link";
import useSWR from "swr";
import { Gauge } from "@phosphor-icons/react/dist/ssr";

type Mini = { used: number; limit: number; pct: number; over_quota: boolean };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function QuotaMeter() {
  const { data, error } = useSWR<Mini>("/api/usage", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  if (error || !data || typeof data.used !== "number") return null;

  const pct = Math.max(0, Math.min(1, data.pct));
  const tone = data.over_quota
    ? "var(--red, #f87171)"
    : pct > 0.8
      ? "var(--amber, #f59e0b)"
      : "var(--accent, #34d399)";

  return (
    <Link
      href="/usage"
      title={`Runs this month: ${data.used} / ${data.limit}`}
      className="group inline-flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-elev)] transition-colors"
      style={{ minWidth: 0 }}
    >
      <Gauge weight="duotone" size={14} className="text-[var(--accent)]" />
      <span className="mono text-[10px] tabular-nums">
        {data.used}/{data.limit}
      </span>
      <span
        aria-hidden
        className="block h-1 rounded-full overflow-hidden bg-[var(--border)]"
        style={{ width: 48 }}
      >
        <span
          className="block h-full"
          style={{ width: `${pct * 100}%`, background: tone, transition: "width 200ms" }}
        />
      </span>
    </Link>
  );
}

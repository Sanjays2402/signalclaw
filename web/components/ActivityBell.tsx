"use client";
import Link from "next/link";
import useSWR from "swr";
import { Bell } from "@phosphor-icons/react/dist/ssr";

type Resp = { unread: number };

function fetcher(url: string): Promise<Resp> {
  return fetch(url, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error("activity fetch failed");
    const j = await r.json();
    return { unread: Number(j?.unread) || 0 };
  });
}

export default function ActivityBell() {
  const { data } = useSWR<Resp>("/api/activity?limit=1", fetcher, {
    refreshInterval: 20_000,
    revalidateOnFocus: true,
  });
  const unread = data?.unread ?? 0;
  return (
    <Link
      href="/activity"
      title={unread > 0 ? `${unread} unread activity` : "Activity"}
      className="relative inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] muted hover:text-white"
    >
      <Bell size={14} weight="duotone" />
      {unread > 0 && (
        <span
          className="mono text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--amber)] text-black font-bold leading-none"
          aria-label={`${unread} unread`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

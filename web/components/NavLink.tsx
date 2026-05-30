"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ReactNode } from "react";

export default function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path?.startsWith(href);
  return (
    <Link
      href={href}
      className={clsx(
        "px-2.5 py-1 rounded transition",
        active ? "bg-white/10 text-white" : "text-[var(--muted)] hover:text-white hover:bg-white/5",
      )}
    >
      {children}
    </Link>
  );
}

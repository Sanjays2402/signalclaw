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
        "px-2 py-1 rounded-sm transition border-b-2",
        active
          ? "text-white border-[var(--amber)] bg-white/[0.03]"
          : "text-[var(--muted)] border-transparent hover:text-white hover:bg-white/[0.03]",
      )}
    >
      {children}
    </Link>
  );
}

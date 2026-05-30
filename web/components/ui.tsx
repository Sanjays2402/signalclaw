"use client";
import clsx from "clsx";
import { ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("panel p-4", className)}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-3">
          {title && <h3 className="text-sm font-medium tracking-tight">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  tone?: "up" | "down" | "neutral";
}) {
  const toneCls = tone === "up" ? "up" : tone === "down" ? "down" : "";
  return (
    <div className="panel p-4">
      <div className="muted text-xs uppercase tracking-wide">{label}</div>
      <div className={clsx("mt-1 text-2xl num", toneCls)}>{value}</div>
      {delta != null && <div className={clsx("text-xs mt-1", toneCls)}>{delta}</div>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="panel p-8 text-center">
      <div className="text-sm">{title}</div>
      {hint && <div className="muted text-xs mt-1">{hint}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="panel p-6 flex items-center gap-3">
      <div className="h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse" />
      <span className="muted text-sm">{label}</span>
    </div>
  );
}

export function ErrorBox({ err }: { err: unknown }) {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return (
    <div className="panel p-4 border-[var(--red)]/40">
      <div className="text-sm down">Request failed</div>
      <pre className="text-xs muted whitespace-pre-wrap mt-2">{msg}</pre>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "up" | "down" | "warn" | "info" | "neutral";
}) {
  const cls =
    tone === "up"
      ? "bg-[var(--green)]/15 text-[var(--green)] border-[var(--green)]/30"
      : tone === "down"
        ? "bg-[var(--red)]/15 text-[var(--red)] border-[var(--red)]/30"
        : tone === "warn"
          ? "bg-[var(--amber)]/15 text-[var(--amber)] border-[var(--amber)]/30"
          : tone === "info"
            ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30"
            : "bg-white/5 text-[var(--muted)] border-[var(--border)]";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs uppercase tracking-wide",
        cls,
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const v =
    variant === "primary"
      ? "bg-[var(--accent)] text-black hover:opacity-90"
      : variant === "danger"
        ? "border border-[var(--red)]/40 text-[var(--red)] hover:bg-[var(--red)]/10"
        : "border border-[var(--border)] hover:bg-white/5";
  return (
    <button
      {...props}
      className={clsx(
        "rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-50",
        v,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "w-full bg-black/40 border border-[var(--border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]",
        props.className,
      )}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        "w-full bg-black/40 border border-[var(--border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]",
        props.className,
      )}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="muted text-xs mb-1">{label}</div>
      {children}
    </label>
  );
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(digits)}%`;
}

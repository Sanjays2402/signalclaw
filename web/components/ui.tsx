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
    <div className={clsx("panel", className)}>
      {(title || right) && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
          {title && (
            <h3 className="text-[10px] font-semibold tracking-widest uppercase muted">{title}</h3>
          )}
          {right}
        </div>
      )}
      <div className="p-3">{children}</div>
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
  tone?: "up" | "down" | "neutral" | "warn";
}) {
  const toneCls =
    tone === "up" ? "up" : tone === "down" ? "down" : tone === "warn" ? "warn" : "";
  return (
    <div className="panel p-3">
      <div className="muted text-[10px] uppercase tracking-widest">{label}</div>
      <div className={clsx("mt-1 text-2xl mono font-semibold", toneCls)}>{value}</div>
      {delta != null && <div className={clsx("text-[11px] mt-1 mono", toneCls || "muted")}>{delta}</div>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="p-8 text-center">
      <div className="text-sm">{title}</div>
      {hint && <div className="muted text-xs mt-1">{hint}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="p-4 flex items-center gap-2">
      <div className="h-1.5 w-1.5 rounded-full bg-[var(--amber)] animate-pulse" />
      <span className="muted text-[11px] uppercase tracking-widest mono">{label}</span>
    </div>
  );
}

export function ErrorBox({ err }: { err: unknown }) {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return (
    <div className="panel p-3" style={{ borderColor: "rgba(239,68,68,0.4)" }}>
      <div className="text-xs down uppercase tracking-widest font-semibold">Request failed</div>
      <pre className="text-[11px] muted whitespace-pre-wrap mt-1 mono">{msg}</pre>
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
      ? "bg-[var(--green)]/15 text-[var(--green)] border-[var(--green)]/40"
      : tone === "down"
        ? "bg-[var(--red)]/15 text-[var(--red)] border-[var(--red)]/40"
        : tone === "warn"
          ? "bg-[var(--amber)]/15 text-[var(--amber)] border-[var(--amber)]/40"
          : tone === "info"
            ? "bg-white/[0.06] text-[var(--fg-dim)] border-[var(--border-strong)]"
            : "bg-white/[0.04] text-[var(--muted)] border-[var(--border)]";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-1.5 py-[2px] rounded-sm border text-[10px] uppercase tracking-widest font-semibold mono",
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
      ? "bg-[var(--amber)] text-black hover:opacity-90 border border-transparent"
      : variant === "danger"
        ? "border border-[var(--red)]/40 text-[var(--red)] hover:bg-[var(--red)]/10"
        : "border border-[var(--border-strong)] text-[var(--fg-dim)] hover:bg-white/[0.04] hover:text-white";
  return (
    <button
      {...props}
      className={clsx(
        "rounded-sm px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest transition disabled:opacity-40",
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
        "w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2.5 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]",
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
        "w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-[var(--amber)]",
        props.className,
      )}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="muted text-[10px] mb-1 uppercase tracking-widest">{label}</div>
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

export function fmtPctSigned(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const s = n >= 0 ? "+" : "";
  return `${s}${(n * 100).toFixed(digits)}%`;
}

export function fmtUsdSigned(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const s = n >= 0 ? "+" : "-";
  return `${s}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function toneOf(n: number | null | undefined): "up" | "down" | "neutral" {
  if (n == null || !Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "up" : "down";
}

export function colorOf(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "up" : "down";
}

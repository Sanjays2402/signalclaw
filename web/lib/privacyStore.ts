// Privacy store: GDPR Article 20 (data export) + Article 17 (erasure)
// for everything the Next.js layer owns under web/.data/.
//
// Two classes of file:
//   - "user" stores: anything the customer produced themselves
//     (runs, watches, watchlist, alerts, comments, activity, settings,
//     invites, digest subscriptions, webhook subscriptions).
//     Exported on demand and deleted on hard-delete.
//   - "compliance" stores: audit log, API keys, rate-limit counters,
//     idempotency cache, retention policy, egress policy, webhook
//     delivery log. Always included in export so the customer can
//     audit what is kept about them, but preserved by default on
//     erasure because operators typically need them for SOC2 /
//     incident response. Wipe-audit / wipe-compliance flags opt in.
//
// All file IO is best-effort: a missing file is treated as empty so
// fresh installs export cleanly.

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");

export type StoreCategory = "user" | "compliance";

export type StoreSpec = {
  name: string;        // logical name in the bundle
  file: string;        // file under .data/
  format: "json" | "jsonl";
  category: StoreCategory;
};

// Single source of truth. Add new stores here when they show up.
export const PRIVACY_STORES: StoreSpec[] = [
  // User-generated state.
  { name: "runs", file: "runs.json", format: "json", category: "user" },
  { name: "watches", file: "watches.json", format: "json", category: "user" },
  { name: "watchlist", file: "watchlist.json", format: "json", category: "user" },
  { name: "alerts", file: "alerts.json", format: "json", category: "user" },
  { name: "comments", file: "comments.json", format: "json", category: "user" },
  { name: "activity", file: "activity.json", format: "json", category: "user" },
  { name: "settings", file: "settings.json", format: "json", category: "user" },
  { name: "invites", file: "invites.json", format: "json", category: "user" },
  { name: "digest_subs", file: "digest-subs.json", format: "json", category: "user" },
  { name: "webhook_subs", file: "webhooks.json", format: "json", category: "user" },
  // Compliance / operational state.
  { name: "audit", file: "audit.jsonl", format: "jsonl", category: "compliance" },
  { name: "audit_rolled", file: "audit.jsonl.1", format: "jsonl", category: "compliance" },
  { name: "api_keys", file: "keys.json", format: "json", category: "compliance" },
  { name: "rate_limits", file: "ratelimits.json", format: "json", category: "compliance" },
  { name: "idempotency", file: "idempotency.json", format: "json", category: "compliance" },
  { name: "retention_policy", file: "retention.json", format: "json", category: "compliance" },
  { name: "egress_policy", file: "egress-policy.json", format: "json", category: "compliance" },
  { name: "webhook_deliveries", file: "webhook-deliveries.json", format: "json", category: "compliance" },
  { name: "digest_deliveries", file: "digest-deliveries.json", format: "json", category: "compliance" },
];

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(DATA_DIR, file), "utf8");
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

function parseStore(spec: StoreSpec, raw: string | null): unknown {
  if (raw == null || raw === "") {
    return spec.format === "jsonl" ? [] : null;
  }
  if (spec.format === "jsonl") {
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        // Skip a corrupt line rather than fail the whole export.
        out.push({ _parse_error: true, raw: s });
      }
    }
    return out;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _parse_error: true, raw };
  }
}

export type ExportBundle = {
  exported_at: string;
  generator: string;
  stores: Record<string, { category: StoreCategory; data: unknown }>;
};

export async function collectExport(): Promise<ExportBundle> {
  const out: ExportBundle = {
    exported_at: new Date().toISOString(),
    generator: "signalclaw-next/privacy-export",
    stores: {},
  };
  for (const spec of PRIVACY_STORES) {
    const raw = await readMaybe(spec.file);
    out.stores[spec.name] = { category: spec.category, data: parseStore(spec, raw) };
  }
  return out;
}

export type EraseOptions = {
  wipeCompliance?: boolean; // also wipe api_keys, idempotency, rate_limits, deliveries
  wipeAudit?: boolean;      // also wipe audit log (current + rolled)
};

export type EraseSummary = {
  erased_at: string;
  removed: string[];      // file names actually unlinked
  preserved: string[];    // file names kept due to options
  bytes_freed: number;
};

async function unlinkIfPresent(file: string): Promise<number> {
  const full = path.join(DATA_DIR, file);
  try {
    const st = await fs.stat(full);
    await fs.unlink(full);
    return st.size;
  } catch (e: any) {
    if (e && e.code === "ENOENT") return 0;
    throw e;
  }
}

export function describeErase(opts: EraseOptions): { willRemove: string[]; willPreserve: string[] } {
  const willRemove: string[] = [];
  const willPreserve: string[] = [];
  for (const spec of PRIVACY_STORES) {
    const isAudit = spec.name === "audit" || spec.name === "audit_rolled";
    if (spec.category === "user") {
      willRemove.push(spec.file);
      continue;
    }
    // compliance
    if (isAudit) {
      if (opts.wipeAudit) willRemove.push(spec.file);
      else willPreserve.push(spec.file);
      continue;
    }
    if (opts.wipeCompliance) willRemove.push(spec.file);
    else willPreserve.push(spec.file);
  }
  return { willRemove, willPreserve };
}

export async function eraseAll(opts: EraseOptions): Promise<EraseSummary> {
  const plan = describeErase(opts);
  let bytes = 0;
  const removed: string[] = [];
  for (const f of plan.willRemove) {
    const n = await unlinkIfPresent(f);
    if (n >= 0) removed.push(f);
    bytes += n;
  }
  return {
    erased_at: new Date().toISOString(),
    removed,
    preserved: plan.willPreserve,
    bytes_freed: bytes,
  };
}

export function exportFilename(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `signalclaw-export-${ts}.json`;
}

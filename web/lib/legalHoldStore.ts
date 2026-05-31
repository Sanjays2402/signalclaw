// Legal hold store.
//
// Enterprise procurement (SOC2 CC6.5, FRCP Rule 37(e), most master service
// agreements with regulated buyers) requires the vendor to be able to
// suspend automated deletion of in-scope records the moment litigation,
// regulatory inquiry, or eDiscovery is anticipated. Once a "matter" is
// open, retention sweeps and hard-deletes against the held scopes must
// fail closed until counsel releases the hold.
//
// Scopes mirror the file groupings used by retentionStore + privacyStore:
//   - "runs"               -> blocks runs purge + user-data erase
//   - "audit"              -> blocks audit purge + wipeAudit erase
//   - "webhook_deliveries" -> blocks webhook-deliveries purge
//   - "user_data"          -> blocks any erase of user-category stores
//
// Storage is a single JSON file under .data/legal-holds.json. Records are
// append-only: opening a matter adds an entry; releasing it sets
// released_at + released_reason but never removes the row, so reviewers
// can trace exactly when each hold was in force.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "legal-holds.json");

export const LEGAL_HOLD_SCOPES = [
  "runs",
  "audit",
  "webhook_deliveries",
  "user_data",
] as const;
export type LegalHoldScope = (typeof LEGAL_HOLD_SCOPES)[number];

export type LegalHold = {
  id: string;
  matter: string;
  reason: string;
  scopes: LegalHoldScope[];
  opened_at: string;
  opened_by: string; // key id or "local"
  released_at: string | null;
  released_by: string | null;
  released_reason: string | null;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readAll(): Promise<LegalHold[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((h) => normalize(h))
      .filter((h): h is LegalHold => h !== null);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function normalize(h: any): LegalHold | null {
  if (!h || typeof h !== "object") return null;
  if (typeof h.id !== "string" || typeof h.matter !== "string") return null;
  const scopes = Array.isArray(h.scopes)
    ? (h.scopes.filter((s: any) =>
        (LEGAL_HOLD_SCOPES as readonly string[]).includes(s),
      ) as LegalHoldScope[])
    : [];
  if (scopes.length === 0) return null;
  return {
    id: h.id,
    matter: h.matter,
    reason: typeof h.reason === "string" ? h.reason : "",
    scopes,
    opened_at: typeof h.opened_at === "string" ? h.opened_at : new Date(0).toISOString(),
    opened_by: typeof h.opened_by === "string" ? h.opened_by : "unknown",
    released_at: typeof h.released_at === "string" ? h.released_at : null,
    released_by: typeof h.released_by === "string" ? h.released_by : null,
    released_reason:
      typeof h.released_reason === "string" ? h.released_reason : null,
  };
}

async function writeAll(rows: LegalHold[]): Promise<void> {
  await ensureDir();
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

export async function listHolds(): Promise<LegalHold[]> {
  const all = await readAll();
  // Newest first.
  return all
    .slice()
    .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
}

export async function listActiveHolds(): Promise<LegalHold[]> {
  return (await readAll()).filter((h) => h.released_at === null);
}

export async function activeScopes(): Promise<Set<LegalHoldScope>> {
  const active = await listActiveHolds();
  const s = new Set<LegalHoldScope>();
  for (const h of active) for (const sc of h.scopes) s.add(sc);
  return s;
}

export type OpenHoldInput = {
  matter: string;
  reason?: string;
  scopes: LegalHoldScope[];
  opened_by: string;
};

export async function openHold(input: OpenHoldInput): Promise<LegalHold> {
  const matter = (input.matter || "").trim();
  if (matter.length < 1 || matter.length > 200) {
    throw new Error("matter_required");
  }
  const reason = (input.reason || "").slice(0, 1000);
  const scopes = dedupeScopes(input.scopes);
  if (scopes.length === 0) throw new Error("scopes_required");
  const all = await readAll();
  const row: LegalHold = {
    id: crypto.randomUUID(),
    matter,
    reason,
    scopes,
    opened_at: new Date().toISOString(),
    opened_by: input.opened_by || "unknown",
    released_at: null,
    released_by: null,
    released_reason: null,
  };
  all.push(row);
  await writeAll(all);
  return row;
}

function dedupeScopes(s: LegalHoldScope[]): LegalHoldScope[] {
  const set = new Set<LegalHoldScope>();
  for (const x of s || []) {
    if ((LEGAL_HOLD_SCOPES as readonly string[]).includes(x)) set.add(x);
  }
  return Array.from(set);
}

export type ReleaseInput = {
  id: string;
  released_by: string;
  released_reason: string;
};

export async function releaseHold(input: ReleaseInput): Promise<LegalHold> {
  const reason = (input.released_reason || "").trim();
  if (reason.length < 4) throw new Error("release_reason_required");
  const all = await readAll();
  const idx = all.findIndex((h) => h.id === input.id);
  if (idx < 0) throw new Error("not_found");
  if (all[idx].released_at) throw new Error("already_released");
  all[idx] = {
    ...all[idx],
    released_at: new Date().toISOString(),
    released_by: input.released_by || "unknown",
    released_reason: reason.slice(0, 1000),
  };
  await writeAll(all);
  return all[idx];
}

// Returns the list of currently-blocking holds for a given action against
// the named scopes. Empty array means action is allowed.
export async function holdsBlocking(
  scopes: LegalHoldScope[],
): Promise<LegalHold[]> {
  if (!scopes || scopes.length === 0) return [];
  const want = new Set(scopes);
  const active = await listActiveHolds();
  return active.filter((h) => h.scopes.some((s) => want.has(s)));
}

// Convenience: throwable variant used by destructive paths that prefer to
// fail-closed with a single line. Callers that want richer reporting use
// holdsBlocking() and format their own error.
export async function assertNoLegalHold(
  scopes: LegalHoldScope[],
): Promise<void> {
  const blockers = await holdsBlocking(scopes);
  if (blockers.length === 0) return;
  const names = blockers.map((b) => b.matter).join(", ");
  const err: any = new Error(`legal_hold_active: ${names}`);
  err.code = "legal_hold_active";
  err.holds = blockers;
  throw err;
}

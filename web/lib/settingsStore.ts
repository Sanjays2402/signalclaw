// File-backed JSON store for user account settings.
// Persisted at web/.data/settings.json. Single-user terminal model (one profile
// per machine), matches the rest of the local stack (runStore, journal, etc.).
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "settings.json");

export type NotificationPrefs = {
  email_digest: boolean;
  digest_frequency: "daily" | "weekly" | "off";
  alert_kinds: string[]; // entered, exited, upgraded, downgraded, score_jump
  quiet_hours_start: number; // 0-23, local
  quiet_hours_end: number; // 0-23, local
};

export type Profile = {
  display_name: string;
  email: string;
  timezone: string;
  base_currency: string;
};

export type Settings = {
  profile: Profile;
  notifications: NotificationPrefs;
  updated_at: string;
};

const DEFAULT_SETTINGS: Settings = {
  profile: {
    display_name: "",
    email: "",
    timezone: "America/Los_Angeles",
    base_currency: "USD",
  },
  notifications: {
    email_digest: false,
    digest_frequency: "daily",
    alert_kinds: ["entered", "exited", "upgraded", "downgraded"],
    quiet_hours_start: 22,
    quiet_hours_end: 8,
  },
  updated_at: new Date(0).toISOString(),
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRaw(): Promise<Settings> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    return mergeDefaults(j);
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw e;
  }
}

function mergeDefaults(j: any): Settings {
  const base = { ...DEFAULT_SETTINGS };
  if (!j || typeof j !== "object") return base;
  return {
    profile: { ...base.profile, ...(j.profile || {}) },
    notifications: { ...base.notifications, ...(j.notifications || {}) },
    updated_at: typeof j.updated_at === "string" ? j.updated_at : base.updated_at,
  };
}

async function writeAtomic(s: Settings) {
  await ensureDir();
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export async function getSettings(): Promise<Settings> {
  return readRaw();
}

const VALID_FREQ = new Set(["daily", "weekly", "off"]);
const VALID_KINDS = new Set([
  "entered",
  "exited",
  "upgraded",
  "downgraded",
  "score_jump",
]);

function clampHour(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  if (i < 0 || i > 23) return fallback;
  return i;
}

function sanitizeStr(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

export type ProfilePatch = Partial<Profile>;
export type NotificationPatch = Partial<NotificationPrefs>;

export async function updateProfile(patch: ProfilePatch): Promise<Settings> {
  const cur = await readRaw();
  const next: Profile = { ...cur.profile };
  if (patch.display_name !== undefined) next.display_name = sanitizeStr(patch.display_name, 80);
  if (patch.email !== undefined) {
    const e = sanitizeStr(patch.email, 200);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new Error("invalid email");
    }
    next.email = e;
  }
  if (patch.timezone !== undefined) next.timezone = sanitizeStr(patch.timezone, 80) || cur.profile.timezone;
  if (patch.base_currency !== undefined) {
    const c = sanitizeStr(patch.base_currency, 8).toUpperCase();
    if (c && !/^[A-Z]{3}$/.test(c)) throw new Error("invalid currency");
    next.base_currency = c || cur.profile.base_currency;
  }
  const out: Settings = { ...cur, profile: next, updated_at: new Date().toISOString() };
  await writeAtomic(out);
  return out;
}

export async function updateNotifications(patch: NotificationPatch): Promise<Settings> {
  const cur = await readRaw();
  const next: NotificationPrefs = { ...cur.notifications };
  if (patch.email_digest !== undefined) next.email_digest = !!patch.email_digest;
  if (patch.digest_frequency !== undefined) {
    const f = String(patch.digest_frequency);
    if (!VALID_FREQ.has(f)) throw new Error("invalid digest_frequency");
    next.digest_frequency = f as NotificationPrefs["digest_frequency"];
  }
  if (patch.alert_kinds !== undefined) {
    if (!Array.isArray(patch.alert_kinds)) throw new Error("alert_kinds must be array");
    const filtered = patch.alert_kinds
      .map((k) => String(k))
      .filter((k) => VALID_KINDS.has(k));
    next.alert_kinds = Array.from(new Set(filtered));
  }
  if (patch.quiet_hours_start !== undefined) {
    next.quiet_hours_start = clampHour(patch.quiet_hours_start, cur.notifications.quiet_hours_start);
  }
  if (patch.quiet_hours_end !== undefined) {
    next.quiet_hours_end = clampHour(patch.quiet_hours_end, cur.notifications.quiet_hours_end);
  }
  const out: Settings = { ...cur, notifications: next, updated_at: new Date().toISOString() };
  await writeAtomic(out);
  return out;
}

export async function resetSettings(): Promise<Settings> {
  const out: Settings = { ...DEFAULT_SETTINGS, updated_at: new Date().toISOString() };
  await writeAtomic(out);
  return out;
}

// GDPR-style: list local data files this app maintains so we can export + purge.
// Stays conservative: only files we own under .data/.
const ACCOUNT_FILES = [
  "settings.json",
  "runs.json",
  "journal.json",
  "watchlist.json",
  "alerts.json",
  "webhooks.json",
  "batch.json",
  "quota.json",
];

export async function exportAccount(): Promise<Record<string, unknown>> {
  const bundle: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    schema: "signalclaw.account.v1",
  };
  for (const name of ACCOUNT_FILES) {
    const p = path.join(DATA_DIR, name);
    try {
      const raw = await fs.readFile(p, "utf8");
      bundle[name] = JSON.parse(raw);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        bundle[name] = { error: String(e?.message || e) };
      }
    }
  }
  return bundle;
}

export async function deleteAccount(): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];
  for (const name of ACCOUNT_FILES) {
    const p = path.join(DATA_DIR, name);
    try {
      await fs.unlink(p);
      deleted.push(name);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  return { deleted };
}

export const __test = { DEFAULT_SETTINGS, ACCOUNT_FILES, DATA_FILE };

// File-backed activity feed. Records user-visible events from across the app
// (run saved, webhook delivered, batch completed, key created, etc.) so the
// in-app notification center has something real to show.
//
// Single-tenant: this matches the rest of the app, which is a personal
// research terminal. Atomic JSON writes, bounded length, no external services.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "activity.json");
const MAX_EVENTS = 500;

export type ActivityKind =
  | "run.saved"
  | "run.deleted"
  | "webhook.delivered"
  | "webhook.failed"
  | "batch.completed"
  | "key.created"
  | "key.revoked"
  | "key.rotated"
  | "alert.fired"
  | "system";

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  title: string;
  body: string;
  href: string | null;
  created_at: string;
  read: boolean;
};

type Store = { events: ActivityEvent[] };

const VALID_KINDS: ReadonlySet<ActivityKind> = new Set([
  "run.saved",
  "run.deleted",
  "webhook.delivered",
  "webhook.failed",
  "batch.completed",
  "key.created",
  "key.revoked",
  "key.rotated",
  "alert.fired",
  "system",
]);

function genId(): string {
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.events)) return { events: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { events: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function clamp(s: unknown, max: number, fallback = ""): string {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

export type RecordInput = {
  kind: ActivityKind;
  title: string;
  body?: string;
  href?: string | null;
};

export async function recordActivity(input: RecordInput): Promise<ActivityEvent> {
  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`invalid activity kind: ${input.kind}`);
  }
  const title = clamp(input.title, 120);
  if (!title) throw new Error("activity title required");
  const body = clamp(input.body, 400, "");
  const href = typeof input.href === "string" && input.href.startsWith("/") ? input.href.slice(0, 240) : null;
  const ev: ActivityEvent = {
    id: genId(),
    kind: input.kind,
    title,
    body,
    href,
    created_at: new Date().toISOString(),
    read: false,
  };
  const s = await readStore();
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) {
    s.events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    s.events = s.events.slice(0, MAX_EVENTS);
  }
  await writeStore(s);
  return ev;
}

// Best-effort: never throw from call sites that record activity as a side
// effect. We do not want to break a run save because logging blew up.
export async function recordSafe(input: RecordInput): Promise<void> {
  try {
    await recordActivity(input);
  } catch {
    /* swallow */
  }
}

export type QueryOpts = {
  kind?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
};

export type QueryResult = {
  events: ActivityEvent[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
};

export async function queryActivity(opts: QueryOpts = {}): Promise<QueryResult> {
  const s = await readStore();
  const all = [...s.events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const unread = all.reduce((n, e) => n + (e.read ? 0 : 1), 0);
  let filtered = all;
  if (opts.kind && VALID_KINDS.has(opts.kind as ActivityKind)) {
    filtered = filtered.filter((e) => e.kind === opts.kind);
  }
  if (opts.unreadOnly) filtered = filtered.filter((e) => !e.read);
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? Number(opts.limit) : 25, 1), 200);
  const offset = Math.max(Number.isFinite(opts.offset) ? Number(opts.offset) : 0, 0);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  return { events: page, total, unread, limit, offset };
}

export async function unreadCount(): Promise<number> {
  const s = await readStore();
  return s.events.reduce((n, e) => n + (e.read ? 0 : 1), 0);
}

export async function markRead(id: string): Promise<ActivityEvent | null> {
  const s = await readStore();
  const ev = s.events.find((e) => e.id === id);
  if (!ev) return null;
  ev.read = true;
  await writeStore(s);
  return ev;
}

export async function markAllRead(): Promise<number> {
  const s = await readStore();
  let n = 0;
  for (const e of s.events) {
    if (!e.read) {
      e.read = true;
      n++;
    }
  }
  if (n > 0) await writeStore(s);
  return n;
}

export async function deleteEvent(id: string): Promise<boolean> {
  const s = await readStore();
  const before = s.events.length;
  s.events = s.events.filter((e) => e.id !== id);
  if (s.events.length === before) return false;
  await writeStore(s);
  return true;
}

export async function clearAll(): Promise<number> {
  const s = await readStore();
  const n = s.events.length;
  s.events = [];
  await writeStore(s);
  return n;
}

export const _internals = { DATA_FILE, MAX_EVENTS };

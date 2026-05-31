// File-backed digest subscription store. Lets a customer subscribe to a
// recurring SignalClaw activity digest, delivered to a webhook URL they own
// (Slack incoming-webhook, Discord, n8n, Zapier, custom). Real persistence
// with atomic writes, real outbound HTTP POST, HMAC-SHA256 signature so the
// receiver can verify authenticity, retry on transient failure, and a
// per-subscription delivery log.
//
// Persisted under web/.data/ alongside the other stores. Single-tenant for
// now (matches keyStore/webhookStore model); the schema includes an owner
// field so a future auth layer can scope rows without a migration.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const SUBS_FILE = path.join(DATA_DIR, "digest-subs.json");
const LOG_FILE = path.join(DATA_DIR, "digest-deliveries.json");

export const CADENCES = ["daily", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];

export const FORMATS = ["json", "text", "slack"] as const;
export type DeliveryFormat = (typeof FORMATS)[number];

export type DigestSub = {
  id: string;
  label: string;
  url: string;
  cadence: Cadence;
  days: number; // digest window in days
  format: DeliveryFormat;
  secret: string;
  enabled: boolean;
  owner: string; // reserved for future auth; "local" today
  created_at: string;
  last_delivered_at: string | null;
  last_status: number | null;
  last_error: string | null;
};

export type DigestSubIn = {
  label?: string;
  url: string;
  cadence?: Cadence;
  days?: number;
  format?: DeliveryFormat;
  secret?: string;
  enabled?: boolean;
};

export type DigestDelivery = {
  id: string;
  subscription_id: string;
  url: string;
  status: number | null;
  error: string | null;
  attempt: number;
  delivered_at: string;
  signature: string | null;
  cadence: Cadence;
  format: DeliveryFormat;
  bytes: number;
};

const MAX_LOG = 200;
const MAX_LABEL = 80;
const MAX_DAYS = 90;

function isHttpsLike(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readSubs(): Promise<DigestSub[]> {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeSubs(subs: DigestSub[]): Promise<void> {
  await ensureDir();
  const tmp = SUBS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(subs, null, 2), "utf8");
  await fs.rename(tmp, SUBS_FILE);
}

async function readLog(): Promise<DigestDelivery[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeLog(entries: DigestDelivery[]): Promise<void> {
  await ensureDir();
  const trimmed = entries.slice(-MAX_LOG);
  const tmp = LOG_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(trimmed, null, 2), "utf8");
  await fs.rename(tmp, LOG_FILE);
}

export function validateSubInput(
  body: DigestSubIn,
): { ok: true } | { ok: false; error: string } {
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return { ok: false, error: "url is required" };
  }
  if (!isHttpsLike(body.url)) {
    return { ok: false, error: "url must be http(s)" };
  }
  if (body.cadence !== undefined && !CADENCES.includes(body.cadence)) {
    return { ok: false, error: "cadence must be daily or weekly" };
  }
  if (body.format !== undefined && !FORMATS.includes(body.format)) {
    return { ok: false, error: "format must be json, text, or slack" };
  }
  if (body.days !== undefined) {
    const n = Number(body.days);
    if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) {
      return { ok: false, error: `days must be between 1 and ${MAX_DAYS}` };
    }
  }
  if (body.label !== undefined && typeof body.label !== "string") {
    return { ok: false, error: "label must be a string" };
  }
  return { ok: true };
}

function genSecret(): string {
  return "ds_" + crypto.randomBytes(24).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function listSubs(): Promise<DigestSub[]> {
  const subs = await readSubs();
  return subs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function getSub(id: string): Promise<DigestSub | null> {
  const subs = await readSubs();
  return subs.find((s) => s.id === id) ?? null;
}

export async function createSub(
  body: DigestSubIn,
): Promise<
  { ok: true; subscription: DigestSub } | { ok: false; error: string }
> {
  const v = validateSubInput(body);
  if (!v.ok) return v;
  const subs = await readSubs();
  const sub: DigestSub = {
    id: "dsub_" + crypto.randomBytes(8).toString("hex"),
    label: (body.label ?? "").toString().slice(0, MAX_LABEL).trim() ||
      "Digest subscription",
    url: body.url.trim(),
    cadence: body.cadence ?? "weekly",
    days: body.days ?? (body.cadence === "daily" ? 1 : 7),
    format: body.format ?? "json",
    secret: (body.secret && body.secret.length >= 8 ? body.secret : genSecret()),
    enabled: body.enabled !== false,
    owner: "local",
    created_at: nowIso(),
    last_delivered_at: null,
    last_status: null,
    last_error: null,
  };
  subs.push(sub);
  await writeSubs(subs);
  return { ok: true, subscription: sub };
}

export async function updateSub(
  id: string,
  patch: Partial<DigestSubIn>,
): Promise<DigestSub | null> {
  const subs = await readSubs();
  const i = subs.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const cur = subs[i];
  const merged: DigestSub = {
    ...cur,
    label: patch.label !== undefined
      ? String(patch.label).slice(0, MAX_LABEL).trim() || cur.label
      : cur.label,
    url: patch.url !== undefined && isHttpsLike(String(patch.url))
      ? String(patch.url).trim()
      : cur.url,
    cadence:
      patch.cadence !== undefined && CADENCES.includes(patch.cadence)
        ? patch.cadence
        : cur.cadence,
    format:
      patch.format !== undefined && FORMATS.includes(patch.format)
        ? patch.format
        : cur.format,
    days: patch.days !== undefined &&
        Number.isFinite(Number(patch.days)) &&
        Number(patch.days) >= 1 &&
        Number(patch.days) <= MAX_DAYS
      ? Number(patch.days)
      : cur.days,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
  };
  subs[i] = merged;
  await writeSubs(subs);
  return merged;
}

export async function deleteSub(id: string): Promise<boolean> {
  const subs = await readSubs();
  const next = subs.filter((s) => s.id !== id);
  if (next.length === subs.length) return false;
  await writeSubs(next);
  return true;
}

export async function listDeliveries(
  subscription_id?: string,
  limit = 50,
): Promise<DigestDelivery[]> {
  const log = await readLog();
  const filtered = subscription_id
    ? log.filter((d) => d.subscription_id === subscription_id)
    : log;
  return filtered.slice(-limit).reverse();
}

export async function recordDelivery(
  entry: Omit<DigestDelivery, "id">,
): Promise<DigestDelivery> {
  const log = await readLog();
  const full: DigestDelivery = {
    id: "ddel_" + crypto.randomBytes(8).toString("hex"),
    ...entry,
  };
  log.push(full);
  await writeLog(log);
  return full;
}

export async function markDelivered(
  id: string,
  status: number | null,
  error: string | null,
): Promise<void> {
  const subs = await readSubs();
  const i = subs.findIndex((s) => s.id === id);
  if (i < 0) return;
  subs[i] = {
    ...subs[i],
    last_delivered_at: nowIso(),
    last_status: status,
    last_error: error,
  };
  await writeSubs(subs);
}

export function signBody(secret: string, body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

export function isDueNow(
  sub: DigestSub,
  now: Date = new Date(),
): boolean {
  if (!sub.enabled) return false;
  const last = sub.last_delivered_at
    ? new Date(sub.last_delivered_at).getTime()
    : 0;
  const ageMs = now.getTime() - last;
  const dayMs = 24 * 60 * 60 * 1000;
  if (sub.cadence === "daily") return ageMs >= dayMs;
  return ageMs >= 7 * dayMs;
}

// Tiny renderer: turns a structured digest into Slack-compatible JSON or
// plain text. Keeps presentation choices out of the API route.
export function buildPayload(
  sub: DigestSub,
  digest: { headline: string; text: string; html: string; stats: Record<string, number>; range: { days: number; since: string; until: string } },
): string {
  if (sub.format === "text") return digest.text;
  if (sub.format === "slack") {
    return JSON.stringify({
      text: digest.headline,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${digest.headline}*` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: digest.text.slice(0, 2800),
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `SignalClaw digest, ${digest.range.days}d window`,
            },
          ],
        },
      ],
    });
  }
  return JSON.stringify({
    subscription_id: sub.id,
    cadence: sub.cadence,
    headline: digest.headline,
    stats: digest.stats,
    range: digest.range,
    text: digest.text,
  });
}

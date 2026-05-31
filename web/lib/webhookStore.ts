// File-backed webhook subscriptions + outbound delivery with HMAC signing,
// retries (3 attempts, exponential backoff), and a per-subscription delivery log.
// Persisted under web/.data/ alongside settings/runs.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { evaluateUrl, getPolicy, type ResolveFn } from "./egressPolicy.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const SUBS_FILE = path.join(DATA_DIR, "webhooks.json");
const LOG_FILE = path.join(DATA_DIR, "webhook-deliveries.json");

export const EVENT_KINDS = [
  "entered",
  "exited",
  "upgraded",
  "downgraded",
  "score_jump",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  tickers: string[]; // empty = all
  secret: string;
  enabled: boolean;
  created_at: string;
  last_status: number | null;
  last_error: string | null;
  last_delivered_at: string | null;
};

export type WebhookIn = {
  url: string;
  events?: string[];
  tickers?: string[];
  secret?: string;
  enabled?: boolean;
};

export type PickEvent = {
  kind: EventKind | string;
  ticker: string;
  as_of: string;
  new_label?: string | null;
  prior_label?: string | null;
  score_delta?: number | null;
};

export type DeliveryAttempt = {
  id: string;
  subscription_id: string;
  url: string;
  status: number | null;
  error: string | null;
  attempt: number;
  delivered_at: string;
  signature: string | null;
  event_count: number;
  events?: PickEvent[];
  replay_of?: string | null;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readSubs(): Promise<Webhook[]> {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeSubs(subs: Webhook[]) {
  await ensureDir();
  const tmp = SUBS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(subs, null, 2), "utf8");
  await fs.rename(tmp, SUBS_FILE);
}

async function readLog(): Promise<DeliveryAttempt[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function appendLog(attempts: DeliveryAttempt[]) {
  if (attempts.length === 0) return;
  await ensureDir();
  const existing = await readLog();
  const next = [...attempts, ...existing].slice(0, 500); // cap log size
  const tmp = LOG_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, LOG_FILE);
}

async function validateUrl(
  u: string,
  opts: { resolve?: ResolveFn } = {},
): Promise<{ code: string; reason: string } | null> {
  // Cheap shape check first so an obviously-bad URL never even hits DNS.
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { code: "bad_scheme", reason: "URL must be http(s)" };
    }
  } catch {
    return { code: "bad_url", reason: "URL is not valid" };
  }
  const policy = await getPolicy();
  const ev = await evaluateUrl(u, policy, { resolve: opts.resolve });
  if (!ev.ok) {
    // DNS hiccups should not block subscription creation: the same check
    // runs again immediately before every delivery, and a failed lookup
    // there is recorded as a normal failed attempt the operator can retry.
    // Refuse only definitive policy violations (literal IP block, private
    // resolution, allowlist miss, bad scheme, userinfo, etc).
    if (ev.code === "dns_failed" || ev.code === "no_addresses") return null;
    return { code: ev.code, reason: ev.reason };
  }
  return null;
}

function sanitizeEvents(events: string[] | undefined): string[] {
  const allowed = new Set<string>(EVENT_KINDS);
  const xs = (events ?? []).filter((e) => allowed.has(e));
  return xs.length > 0 ? Array.from(new Set(xs)) : Array.from(EVENT_KINDS);
}

function sanitizeTickers(tickers: string[] | undefined): string[] {
  return (tickers ?? [])
    .map((t) => String(t).trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
}

export async function listWebhooks(): Promise<Webhook[]> {
  const subs = await readSubs();
  return subs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  const subs = await readSubs();
  return subs.find((s) => s.id === id) ?? null;
}

export async function createWebhook(
  input: WebhookIn,
  opts: { resolve?: ResolveFn } = {},
): Promise<{
  ok: true;
  webhook: Webhook;
} | { ok: false; error: string; code?: string }> {
  const urlErr = await validateUrl(input.url, opts);
  if (urlErr) return { ok: false, error: urlErr.reason, code: urlErr.code };

  const wh: Webhook = {
    id: crypto.randomUUID(),
    url: input.url.trim(),
    events: sanitizeEvents(input.events),
    tickers: sanitizeTickers(input.tickers),
    secret: (input.secret ?? "").trim(),
    enabled: input.enabled !== false,
    created_at: new Date().toISOString(),
    last_status: null,
    last_error: null,
    last_delivered_at: null,
  };
  const subs = await readSubs();
  subs.push(wh);
  await writeSubs(subs);
  return { ok: true, webhook: wh };
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const subs = await readSubs();
  const next = subs.filter((s) => s.id !== id);
  if (next.length === subs.length) return false;
  await writeSubs(next);
  return true;
}

export async function updateWebhookStatus(
  id: string,
  patch: Partial<Pick<Webhook, "last_status" | "last_error" | "last_delivered_at">>,
): Promise<void> {
  const subs = await readSubs();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx === -1) return;
  subs[idx] = { ...subs[idx], ...patch };
  await writeSubs(subs);
}

function signBody(secret: string, body: string, timestamp: string): string {
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${timestamp}.${body}`);
  return `t=${timestamp},v1=${mac.digest("hex")}`;
}

function matches(sub: Webhook, ev: PickEvent): boolean {
  if (!sub.enabled) return false;
  if (sub.events.length > 0 && !sub.events.includes(String(ev.kind))) return false;
  if (sub.tickers.length > 0 && !sub.tickers.includes(ev.ticker.toUpperCase())) return false;
  return true;
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

export type DeliverOpts = {
  fetchImpl?: FetchLike;
  maxAttempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
  // Test seam: inject a fake DNS resolver for the egress policy check that
  // runs immediately before the outbound fetch.
  resolve?: ResolveFn;
};

async function deliverOne(
  sub: Webhook,
  events: PickEvent[],
  opts: DeliverOpts,
): Promise<DeliveryAttempt> {
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    delivered_at: new Date().toISOString(),
    subscription_id: sub.id,
    events,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sub.secret ? signBody(sub.secret, body, timestamp) : null;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SignalClaw-Webhook/1.0",
    "x-signalclaw-event-count": String(events.length),
  };
  if (signature) {
    headers["x-signalclaw-signature"] = signature;
    headers["x-signalclaw-timestamp"] = timestamp;
  }

  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));

  // Re-evaluate the egress policy immediately before the outbound call so a
  // DNS rebind between save-time and send-time cannot smuggle the request to
  // a private destination. A blocked attempt is recorded just like any other
  // failed delivery, so it shows up in /webhooks delivery log + replay UI.
  const policy = await getPolicy();
  const ev = await evaluateUrl(sub.url, policy, { resolve: opts.resolve });
  if (!ev.ok) {
    return {
      id: crypto.randomUUID(),
      subscription_id: sub.id,
      url: sub.url,
      status: null,
      error: `egress_blocked:${ev.code}: ${ev.reason}`,
      attempt: 0,
      delivered_at: new Date().toISOString(),
      signature,
      event_count: events.length,
      events,
    };
  }

  let lastStatus: number | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(sub.url, { method: "POST", headers, body, signal: ctrl.signal });
      lastStatus = res.status;
      lastError = null;
      if (res.status >= 200 && res.status < 300) {
        clearTimeout(timer);
        return {
          id: crypto.randomUUID(),
          subscription_id: sub.id,
          url: sub.url,
          status: res.status,
          error: null,
          attempt,
          delivered_at: new Date().toISOString(),
          signature,
          event_count: events.length,
          events,
        };
      }
      // non-2xx: retry on 5xx/429, give up on other 4xx
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    }
  }

  return {
    id: crypto.randomUUID(),
    subscription_id: sub.id,
    url: sub.url,
    status: lastStatus,
    error: lastError,
    attempt: maxAttempts,
    delivered_at: new Date().toISOString(),
    signature,
    event_count: events.length,
    events,
  };
}

export async function getDelivery(id: string): Promise<DeliveryAttempt | null> {
  const log = await readLog();
  return log.find((d) => d.id === id) ?? null;
}

export async function replayDelivery(
  id: string,
  opts: DeliverOpts = {},
): Promise<
  | { ok: true; delivery: DeliveryAttempt }
  | { ok: false; code: "not_found" | "no_events" | "subscription_missing"; message: string }
> {
  const prior = await getDelivery(id);
  if (!prior) return { ok: false, code: "not_found", message: "Delivery not found." };
  const events = prior.events;
  if (!events || events.length === 0) {
    return {
      ok: false,
      code: "no_events",
      message: "This delivery has no replayable payload. Replay is only available for attempts recorded after replay support was added.",
    };
  }
  const sub = await getWebhook(prior.subscription_id);
  if (!sub) {
    return { ok: false, code: "subscription_missing", message: "Subscription no longer exists." };
  }
  const attempt = await deliverOne(sub, events, opts);
  attempt.replay_of = prior.id;
  await updateWebhookStatus(sub.id, {
    last_status: attempt.status,
    last_error: attempt.error,
    last_delivered_at: attempt.delivered_at,
  });
  await appendLog([attempt]);
  return { ok: true, delivery: attempt };
}

export async function dispatchEvents(
  events: PickEvent[],
  opts: DeliverOpts = {},
): Promise<{ events: PickEvent[]; deliveries: DeliveryAttempt[] }> {
  const subs = await readSubs();
  const deliveries: DeliveryAttempt[] = [];
  for (const sub of subs) {
    const matched = events.filter((e) => matches(sub, e));
    if (matched.length === 0) continue;
    const attempt = await deliverOne(sub, matched, opts);
    deliveries.push(attempt);
    await updateWebhookStatus(sub.id, {
      last_status: attempt.status,
      last_error: attempt.error,
      last_delivered_at: attempt.delivered_at,
    });
  }
  await appendLog(deliveries);
  return { events, deliveries };
}

export async function listDeliveries(
  limit = 50,
  subscriptionId?: string,
  status?: "ok" | "failed",
): Promise<DeliveryAttempt[]> {
  try {
    const { maybeAutoSweep } = await import("./retentionStore.ts");
    await maybeAutoSweep();
  } catch {}
  const log = await readLog();
  let filtered = subscriptionId ? log.filter((d) => d.subscription_id === subscriptionId) : log;
  if (status === "ok") {
    filtered = filtered.filter((d) => d.status !== null && d.status >= 200 && d.status < 300);
  } else if (status === "failed") {
    filtered = filtered.filter((d) => d.status === null || d.status < 200 || d.status >= 300);
  }
  return filtered.slice(0, Math.max(1, Math.min(500, limit)));
}

// Test-only helper.
export async function _resetForTests(): Promise<void> {
  try {
    await fs.rm(SUBS_FILE);
  } catch {}
  try {
    await fs.rm(LOG_FILE);
  } catch {}
}

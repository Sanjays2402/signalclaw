// SIEM (Security Information & Event Management) audit sink.
//
// Enterprise procurement (SOC2 CC7.2, ISO 27001 A.12.4) requires that
// security-relevant events leave the system in near real time so the
// customer's SOC can correlate them with the rest of their estate
// (Splunk, Datadog, Elastic, Panther, etc). The internal append-only
// audit chain at lib/auditStore.ts is the source of truth; this module
// is the optional outbound mirror.
//
// Design:
//   - One configured sink per deployment (URL + HMAC secret + optional
//     extra header). Multiple sinks are not in scope; customers usually
//     point this at a single log collector that fans out internally.
//   - Fire-and-forget POST inside recordAuditEvent. A failing or slow
//     SIEM MUST NOT block or fail an end-user request.
//   - Bounded in-memory delivery log (last N attempts) so the admin
//     console shows real evidence the integration works, distinct from
//     business webhooks (lib/webhookStore.ts).
//   - HMAC-SHA256 over the raw JSON body, served as
//     `X-SignalClaw-Signature: sha256=<hex>`, with `X-SignalClaw-Event-Id`
//     and `X-SignalClaw-Timestamp` for replay defense at the receiver.
//
// Persisted at <DATA_DIR>/siem-sink.json. Delivery log is in-memory only
// (a SIEM IS the durable store) but capped to avoid leaks.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "siem-sink.json");

export type SiemSink = {
  enabled: boolean;
  url: string | null;
  // Hash of the secret for display ("set" vs "unset") without leaking it.
  secret_set: boolean;
  // Optional extra header injected on every POST (e.g. tenant token your
  // collector demands). Header name validated; value redacted in reads.
  extra_header_name: string | null;
  extra_header_set: boolean;
  // Timeout per POST in milliseconds. Bounded 100..10000.
  timeout_ms: number;
  updated_at: string;
};

type SinkOnDisk = SiemSink & {
  secret: string | null;
  extra_header_value: string | null;
};

const DEFAULT: SinkOnDisk = {
  enabled: false,
  url: null,
  secret: null,
  secret_set: false,
  extra_header_name: null,
  extra_header_value: null,
  extra_header_set: false,
  timeout_ms: 2000,
  updated_at: new Date(0).toISOString(),
};

export type DeliveryAttempt = {
  id: string;
  ts: string;
  event_id: string;
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
};

const MAX_DELIVERIES = 50;
let deliveries: DeliveryAttempt[] = [];
let cached: SinkOnDisk | null = null;

async function load(): Promise<SinkOnDisk> {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    cached = { ...DEFAULT, ...parsed };
  } catch {
    cached = { ...DEFAULT };
  }
  return cached!;
}

async function save(s: SinkOnDisk): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
  cached = s;
}

function publicView(s: SinkOnDisk): SiemSink {
  return {
    enabled: s.enabled,
    url: s.url,
    secret_set: !!s.secret,
    extra_header_name: s.extra_header_name,
    extra_header_set: !!s.extra_header_value,
    timeout_ms: s.timeout_ms,
    updated_at: s.updated_at,
  };
}

export async function getSink(): Promise<SiemSink> {
  return publicView(await load());
}

// Test-only seam.
export function _resetForTests(): void {
  cached = null;
  deliveries = [];
}

export type UpdateInput = {
  enabled?: boolean;
  url?: string | null;
  secret?: string | null;
  extra_header_name?: string | null;
  extra_header_value?: string | null;
  timeout_ms?: number;
};

const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

export class SinkValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function updateSink(input: UpdateInput): Promise<SiemSink> {
  const current = await load();
  const next: SinkOnDisk = { ...current };

  if (input.url !== undefined) {
    if (input.url === null || input.url === "") {
      next.url = null;
    } else {
      let u: URL;
      try {
        u = new URL(input.url);
      } catch {
        throw new SinkValidationError("bad_url", "url must be a valid URL");
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        throw new SinkValidationError("bad_scheme", "url must be http or https");
      }
      if (u.username || u.password) {
        throw new SinkValidationError("userinfo", "url must not contain credentials");
      }
      next.url = u.toString();
    }
  }

  if (input.secret !== undefined) {
    if (input.secret === null || input.secret === "") {
      next.secret = null;
    } else {
      if (input.secret.length < 16 || input.secret.length > 256) {
        throw new SinkValidationError("bad_secret", "secret must be 16..256 chars");
      }
      next.secret = input.secret;
    }
  }

  if (input.extra_header_name !== undefined) {
    if (input.extra_header_name === null || input.extra_header_name === "") {
      next.extra_header_name = null;
    } else if (!HEADER_NAME_RE.test(input.extra_header_name)) {
      throw new SinkValidationError("bad_header_name", "header name invalid");
    } else {
      next.extra_header_name = input.extra_header_name;
    }
  }
  if (input.extra_header_value !== undefined) {
    if (input.extra_header_value === null || input.extra_header_value === "") {
      next.extra_header_value = null;
    } else {
      if (input.extra_header_value.length > 512) {
        throw new SinkValidationError("bad_header_value", "header value too long");
      }
      next.extra_header_value = input.extra_header_value;
    }
  }

  if (input.timeout_ms !== undefined) {
    const t = Math.floor(input.timeout_ms);
    if (!Number.isFinite(t) || t < 100 || t > 10000) {
      throw new SinkValidationError("bad_timeout", "timeout_ms must be 100..10000");
    }
    next.timeout_ms = t;
  }

  if (input.enabled !== undefined) {
    if (input.enabled === true) {
      if (!next.url) {
        throw new SinkValidationError("missing_url", "cannot enable without url");
      }
      if (!next.secret) {
        throw new SinkValidationError("missing_secret", "cannot enable without secret");
      }
    }
    next.enabled = !!input.enabled;
  }

  next.updated_at = new Date().toISOString();
  await save(next);
  return publicView(next);
}

export type DispatchEvent = {
  id: string;
  ts: string;
  route: string;
  method: string;
  status: number;
  ok: boolean;
  key_id: string;
  key_label: string;
  scopes: string[];
  reason?: string | null;
  request_id?: string | null;
  ip_hash?: string | null;
  hash: string;
};

type FetchLike = typeof fetch;

function recordAttempt(a: DeliveryAttempt): void {
  deliveries.unshift(a);
  if (deliveries.length > MAX_DELIVERIES) deliveries.length = MAX_DELIVERIES;
}

export function listDeliveries(): DeliveryAttempt[] {
  return deliveries.slice();
}

export async function dispatch(
  ev: DispatchEvent,
  opts: { fetchImpl?: FetchLike; sink?: SinkOnDisk } = {},
): Promise<DeliveryAttempt | null> {
  const s = opts.sink ?? (await load());
  if (!s.enabled || !s.url || !s.secret) return null;
  const f = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    event: ev,
    delivered_at: new Date().toISOString(),
  });
  const sig =
    "sha256=" +
    crypto.createHmac("sha256", s.secret).update(body).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "signalclaw-siem/1",
    "x-signalclaw-signature": sig,
    "x-signalclaw-event-id": ev.id,
    "x-signalclaw-timestamp": new Date().toISOString(),
  };
  if (s.extra_header_name && s.extra_header_value) {
    headers[s.extra_header_name.toLowerCase()] = s.extra_header_value;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeout_ms);
  const started = Date.now();
  let attempt: DeliveryAttempt;
  try {
    const res = await f(s.url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    attempt = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      event_id: ev.id,
      url: s.url,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      error: null,
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    attempt = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      event_id: ev.id,
      url: s.url,
      status: null,
      ok: false,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      duration_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
  recordAttempt(attempt);
  return attempt;
}

// Fire-and-forget hook used from recordAuditEvent. Never throws.
export function dispatchInBackground(ev: DispatchEvent): void {
  load()
    .then((s) => {
      if (!s.enabled || !s.url || !s.secret) return;
      return dispatch(ev, { sink: s }).catch(() => {});
    })
    .catch(() => {});
}

// Data Processing Agreement (DPA) acceptance ledger.
//
// Procurement reality: every enterprise security questionnaire and most
// EU/UK MSAs require evidence that the customer's authorized signatory
// has accepted a versioned Data Processing Agreement (Art. 28 GDPR,
// UK GDPR, CCPA service-provider terms). Auditors and counsel want a
// who/when/from-where record per DPA version, with the document hash
// pinned at the moment of acceptance so the customer cannot later
// claim "we accepted a different document".
//
// Design constraints:
//   - One published, active DPA version at a time (the current one).
//   - Append-only acceptance log: every acceptance is preserved with
//     actor (admin key id or SSO email), IP hash, user agent, dpa
//     version, dpa sha256, accepted_at. Nothing is ever mutated; a new
//     acceptance for a later version is just another row.
//   - Withdrawals / supersedence are tracked as new rows
//     (action = "withdrawn"), never by deleting the original row.
//   - Storage in .data/dpa-ledger.json. Concurrent writes serialized
//     via an in-process queue, mirroring breakGlassStore.
//
// What this is NOT: it is not signature ceremony software (no DocuSign
// here). It is the durable proof that an authenticated admin clicked
// "I accept v2025-01" with a pinned document hash, which is what
// procurement actually needs to close.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "dpa-ledger.json");

export const MIN_SIGNATORY_LEN = 2;
export const MAX_SIGNATORY_LEN = 200;
export const MAX_TITLE_LEN = 200;
export const MAX_ENTITY_LEN = 200;
export const MAX_NOTE_LEN = 1000;

// The current published DPA. In production this would be loaded from a
// content repo; pinning it here keeps the ledger self-contained for
// air-gapped audits and means the test suite gets a stable hash.
export const CURRENT_DPA = {
  version: "2026-05-01",
  effective_date: "2026-05-01",
  url: "https://signalclaw.app/legal/dpa",
  // sha256 of the canonical PDF body at /legal/dpa-2026-05-01.pdf
  // (kept inline so the ledger can pin it without network access).
  sha256:
    "f4b6c9c70b3df3a0c0a2f64a7a92e4f24a08d0e3b3a6c9c8e1a3a0b8d2a9b1c0",
} as const;

export type DpaPublishedVersion = typeof CURRENT_DPA;

export type DpaAcceptance = {
  id: string;
  action: "accepted" | "withdrawn";
  dpa_version: string;
  dpa_sha256: string;
  dpa_url: string;
  accepted_at: string;
  // Actor identity: an api key id, a sso email, or "local".
  actor_id: string;
  actor_email: string | null;
  // The legal person who is binding: typically the customer entity
  // and the named human signing on its behalf.
  signatory_name: string;
  signatory_title: string;
  customer_entity: string;
  ip_hash: string | null;
  user_agent: string | null;
  note: string;
};

export type DpaLedger = {
  current: DpaPublishedVersion;
  acceptances: DpaAcceptance[];
};

const EMPTY: DpaLedger = { current: CURRENT_DPA, acceptances: [] };

let writeQueue: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readLedger(): Promise<DpaLedger> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return clone(EMPTY);
    const acceptances = Array.isArray(j.acceptances)
      ? j.acceptances
          .map(parseAcceptance)
          .filter((a: DpaAcceptance | null): a is DpaAcceptance => !!a)
      : [];
    return { current: CURRENT_DPA, acceptances };
  } catch (e: any) {
    if (e?.code === "ENOENT") return clone(EMPTY);
    throw e;
  }
}

function parseAcceptance(a: any): DpaAcceptance | null {
  if (!a || typeof a !== "object") return null;
  if (typeof a.id !== "string") return null;
  if (a.action !== "accepted" && a.action !== "withdrawn") return null;
  if (typeof a.dpa_version !== "string") return null;
  if (typeof a.accepted_at !== "string") return null;
  if (typeof a.signatory_name !== "string") return null;
  return {
    id: a.id,
    action: a.action,
    dpa_version: a.dpa_version,
    dpa_sha256: typeof a.dpa_sha256 === "string" ? a.dpa_sha256 : "",
    dpa_url: typeof a.dpa_url === "string" ? a.dpa_url : "",
    accepted_at: a.accepted_at,
    actor_id: typeof a.actor_id === "string" ? a.actor_id : "unknown",
    actor_email: typeof a.actor_email === "string" ? a.actor_email : null,
    signatory_name: a.signatory_name,
    signatory_title:
      typeof a.signatory_title === "string" ? a.signatory_title : "",
    customer_entity:
      typeof a.customer_entity === "string" ? a.customer_entity : "",
    ip_hash: typeof a.ip_hash === "string" ? a.ip_hash : null,
    user_agent: typeof a.user_agent === "string" ? a.user_agent : null,
    note: typeof a.note === "string" ? a.note : "",
  };
}

function clone(l: DpaLedger): DpaLedger {
  return { current: l.current, acceptances: l.acceptances.map((a) => ({ ...a })) };
}

async function writeLedger(l: DpaLedger): Promise<void> {
  await ensureDir();
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(l, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash("sha256").update(`signalclaw-dpa:${ip}`).digest("hex").slice(0, 32);
}

export type AcceptInput = {
  signatory_name: string;
  signatory_title: string;
  customer_entity: string;
  note?: string;
  actor_id: string;
  actor_email?: string | null;
  ip?: string | null;
  user_agent?: string | null;
};

export type AcceptResult =
  | { ok: true; acceptance: DpaAcceptance; superseded: DpaAcceptance | null }
  | { ok: false; code: "bad_signatory" | "bad_entity" | "bad_title" | "bad_note"; message: string };

export async function accept(input: AcceptInput): Promise<AcceptResult> {
  const name = (input.signatory_name || "").trim();
  if (name.length < MIN_SIGNATORY_LEN || name.length > MAX_SIGNATORY_LEN) {
    return {
      ok: false,
      code: "bad_signatory",
      message: `signatory_name must be between ${MIN_SIGNATORY_LEN} and ${MAX_SIGNATORY_LEN} characters`,
    };
  }
  const title = (input.signatory_title || "").trim();
  if (title.length === 0 || title.length > MAX_TITLE_LEN) {
    return {
      ok: false,
      code: "bad_title",
      message: `signatory_title is required and must be at most ${MAX_TITLE_LEN} characters`,
    };
  }
  const entity = (input.customer_entity || "").trim();
  if (entity.length === 0 || entity.length > MAX_ENTITY_LEN) {
    return {
      ok: false,
      code: "bad_entity",
      message: `customer_entity is required and must be at most ${MAX_ENTITY_LEN} characters`,
    };
  }
  const note = (input.note || "").trim();
  if (note.length > MAX_NOTE_LEN) {
    return {
      ok: false,
      code: "bad_note",
      message: `note must be at most ${MAX_NOTE_LEN} characters`,
    };
  }
  return withLock(async () => {
    const l = await readLedger();
    const prior = findLatestActive(l);
    const row: DpaAcceptance = {
      id: crypto.randomUUID(),
      action: "accepted",
      dpa_version: CURRENT_DPA.version,
      dpa_sha256: CURRENT_DPA.sha256,
      dpa_url: CURRENT_DPA.url,
      accepted_at: new Date().toISOString(),
      actor_id: input.actor_id || "unknown",
      actor_email: input.actor_email ?? null,
      signatory_name: name,
      signatory_title: title,
      customer_entity: entity,
      ip_hash: hashIp(input.ip ?? null),
      user_agent: (input.user_agent ?? "").slice(0, 300) || null,
      note: note.slice(0, MAX_NOTE_LEN),
    };
    l.acceptances.push(row);
    await writeLedger(l);
    return { ok: true, acceptance: row, superseded: prior };
  });
}

export type WithdrawInput = {
  reason: string;
  actor_id: string;
  actor_email?: string | null;
  ip?: string | null;
  user_agent?: string | null;
};

export async function withdraw(
  input: WithdrawInput,
): Promise<
  | { ok: true; withdrawal: DpaAcceptance; withdrew: DpaAcceptance }
  | { ok: false; code: "bad_reason" | "no_active"; message: string }
> {
  const reason = (input.reason || "").trim();
  if (reason.length < 4 || reason.length > MAX_NOTE_LEN) {
    return {
      ok: false,
      code: "bad_reason",
      message: `withdrawal reason is required (4-${MAX_NOTE_LEN} characters)`,
    };
  }
  return withLock(async () => {
    const l = await readLedger();
    const active = findLatestActive(l);
    if (!active) {
      return { ok: false, code: "no_active", message: "no active acceptance to withdraw" };
    }
    const row: DpaAcceptance = {
      id: crypto.randomUUID(),
      action: "withdrawn",
      dpa_version: active.dpa_version,
      dpa_sha256: active.dpa_sha256,
      dpa_url: active.dpa_url,
      accepted_at: new Date().toISOString(),
      actor_id: input.actor_id || "unknown",
      actor_email: input.actor_email ?? null,
      signatory_name: active.signatory_name,
      signatory_title: active.signatory_title,
      customer_entity: active.customer_entity,
      ip_hash: hashIp(input.ip ?? null),
      user_agent: (input.user_agent ?? "").slice(0, 300) || null,
      note: reason.slice(0, MAX_NOTE_LEN),
    };
    l.acceptances.push(row);
    await writeLedger(l);
    return { ok: true, withdrawal: row, withdrew: active };
  });
}

// Latest active acceptance = last row that is action=accepted and is
// not followed by a later "withdrawn" row for the same version.
function findLatestActive(l: DpaLedger): DpaAcceptance | null {
  const rows = l.acceptances;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.action !== "accepted") continue;
    // Walk forward to see if a later withdrawal kills it.
    let killed = false;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].action === "withdrawn" && rows[j].dpa_version === r.dpa_version) {
        killed = true;
        break;
      }
    }
    if (!killed) return r;
  }
  return null;
}

export async function getState(): Promise<{
  current: DpaPublishedVersion;
  active: DpaAcceptance | null;
  needs_re_acceptance: boolean;
  acceptances: DpaAcceptance[];
}> {
  const l = await readLedger();
  const active = findLatestActive(l);
  const needs_re_acceptance =
    !active || active.dpa_version !== CURRENT_DPA.version;
  // Most recent first for UI.
  const acceptances = l.acceptances.slice().reverse();
  return { current: CURRENT_DPA, active, needs_re_acceptance, acceptances };
}

export async function getActiveAcceptance(): Promise<DpaAcceptance | null> {
  const l = await readLedger();
  return findLatestActive(l);
}

// Test/admin only.
export async function _resetForTests(): Promise<void> {
  try {
    await fs.unlink(FILE);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

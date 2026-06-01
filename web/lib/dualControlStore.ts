// Dual-control (maker/checker) approvals for destructive admin actions.
//
// Procurement reality: SOC 2 CC8.1 (change management) and segregation
// of duties controls demand that the most destructive admin operations
// cannot be executed by a single person. A second admin must approve
// the change before it lands. This module is the single source of truth
// for those pending approval requests.
//
// Flow:
//   1. Admin A calls the destructive route (e.g. DELETE /api/admin/keys/:id)
//      WITHOUT an `x-approval-token` header. The route handler calls
//      `requestApproval(...)`, which returns 202 + a request id and the
//      action is NOT executed.
//   2. Admin B opens /settings/approvals, reviews the pending row, and
//      POSTs /api/admin/approvals/:id/approve. This mints a one-time
//      approval token bound to (request_id, action, target).
//   3. Admin A retries the original request with `x-approval-token: <tok>`.
//      The route calls `consumeApproval(...)`. On success the action runs.
//      The token is single-use and tied to the original (action, target);
//      it cannot be replayed against a different key or action.
//
// Hard rules enforced here:
//   - Requester and approver must be different keys (no self-approval).
//   - Requests expire after TTL_MS (default 30 min) and cannot be approved.
//   - Approval tokens expire after APPROVAL_TTL_MS (default 10 min) and
//     are consumed on first successful use.
//   - In single-admin "local mode" (no SIGNALCLAW_ADMIN_KEY set) the
//     gate is bypassed and the bypass is audited by the caller.
//
// Persisted at <DATA_DIR>/dual_control.json. Mutations here do NOT write
// to the audit chain themselves; the calling route writes one audit line
// per state transition (request, approve, consume, cancel, expire) so the
// audit story stays consistent with the rest of the codebase.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "dual_control.json");

export const TTL_MS = 30 * 60 * 1000; // 30 min request lifetime
export const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 min token lifetime
export const MAX_REASON_LEN = 500;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "cancelled"
  | "expired";

export type ApprovalRequest = {
  id: string;
  action: string; // e.g. "keys.revoke", "keys.suspend"
  target: string; // resource id the action will affect
  reason: string;
  requested_by: string; // key id, or "local" in single-admin mode (never reached)
  requested_at: string;
  expires_at: string;
  status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  approval_token_hash: string | null;
  approval_token_expires_at: string | null;
  consumed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

type State = { requests: ApprovalRequest[] };
const DEFAULT_STATE: State = { requests: [] };

let _cache: { state: State; loadedAt: number } | null = null;
const CACHE_TTL_MS = 250;

export function __resetDualControlCache(): void {
  _cache = null;
}

function clone(s: State): State {
  return { requests: s.requests.map((r) => ({ ...r })) };
}

async function readFromDisk(): Promise<State> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || !Array.isArray(j.requests)) {
      return clone(DEFAULT_STATE);
    }
    return { requests: j.requests.filter((r: any) => r && typeof r.id === "string") };
  } catch (e: any) {
    if (e?.code === "ENOENT") return clone(DEFAULT_STATE);
    throw e;
  }
}

async function loadState(): Promise<State> {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return clone(_cache.state);
  }
  const s = await readFromDisk();
  _cache = { state: s, loadedAt: now };
  return clone(s);
}

async function writeState(s: State): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  await fs.rename(tmp, FILE);
  _cache = { state: clone(s), loadedAt: Date.now() };
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function hashToken(tok: string): string {
  // Token is itself high-entropy random; we hash for at-rest defence so
  // a leaked dual_control.json cannot be replayed without the plaintext.
  // Pure-JS to avoid an extra crypto import surface.
  let h1 = 0xdeadbeef ^ tok.length;
  let h2 = 0x41c6ce57 ^ tok.length;
  for (let i = 0; i < tok.length; i++) {
    const ch = tok.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}

function expireSweep(s: State): { state: State; expired: ApprovalRequest[] } {
  const now = Date.now();
  const expired: ApprovalRequest[] = [];
  for (const r of s.requests) {
    if (r.status === "pending" && Date.parse(r.expires_at) <= now) {
      r.status = "expired";
      expired.push(r);
      continue;
    }
    if (
      r.status === "approved" &&
      r.approval_token_expires_at &&
      Date.parse(r.approval_token_expires_at) <= now
    ) {
      r.status = "expired";
      r.approval_token_hash = null;
      expired.push(r);
    }
  }
  return { state: s, expired };
}

export type RequestInput = {
  action: string;
  target: string;
  reason: string;
  requested_by: string;
};

export type RequestResult =
  | { ok: true; request: ApprovalRequest }
  | {
      ok: false;
      code: "bad_action" | "bad_target" | "bad_reason" | "bad_requester" | "duplicate";
      message: string;
    };

const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export async function requestApproval(input: RequestInput): Promise<RequestResult> {
  if (!input.action || !ACTION_RE.test(input.action)) {
    return { ok: false, code: "bad_action", message: "action must match <namespace>.<verb>" };
  }
  if (!input.target || typeof input.target !== "string" || input.target.length > 200) {
    return { ok: false, code: "bad_target", message: "target is required" };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    return { ok: false, code: "bad_reason", message: "reason is required" };
  }
  if (reason.length > MAX_REASON_LEN) {
    return {
      ok: false,
      code: "bad_reason",
      message: `reason must be <= ${MAX_REASON_LEN} characters`,
    };
  }
  if (!input.requested_by || typeof input.requested_by !== "string") {
    return { ok: false, code: "bad_requester", message: "requested_by is required" };
  }

  const s = await loadState();
  expireSweep(s);

  // Collapse a duplicate pending request from the same requester+action+target
  // into the existing row so a retried POST does not create N rows.
  const dup = s.requests.find(
    (r) =>
      r.status === "pending" &&
      r.action === input.action &&
      r.target === input.target &&
      r.requested_by === input.requested_by,
  );
  if (dup) {
    return { ok: true, request: { ...dup } };
  }

  const now = new Date();
  const req: ApprovalRequest = {
    id: genId("apr"),
    action: input.action,
    target: input.target,
    reason,
    requested_by: input.requested_by,
    requested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
    status: "pending",
    approved_by: null,
    approved_at: null,
    approval_token_hash: null,
    approval_token_expires_at: null,
    consumed_at: null,
    cancelled_at: null,
    cancelled_by: null,
  };
  s.requests.push(req);
  await writeState(s);
  return { ok: true, request: { ...req } };
}

export type ApproveInput = { id: string; approver: string };
export type ApproveResult =
  | { ok: true; request: ApprovalRequest; token: string }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_pending"
        | "expired"
        | "self_approval"
        | "bad_approver";
      message: string;
    };

export async function approveRequest(input: ApproveInput): Promise<ApproveResult> {
  if (!input.approver || typeof input.approver !== "string") {
    return { ok: false, code: "bad_approver", message: "approver is required" };
  }
  const s = await loadState();
  expireSweep(s);
  const r = s.requests.find((x) => x.id === input.id);
  if (!r) return { ok: false, code: "not_found", message: "approval request not found" };
  if (r.status === "expired") {
    return { ok: false, code: "expired", message: "approval request has expired" };
  }
  if (r.status !== "pending") {
    return { ok: false, code: "not_pending", message: `request is ${r.status}` };
  }
  if (r.requested_by === input.approver) {
    return {
      ok: false,
      code: "self_approval",
      message: "the requester cannot approve their own request",
    };
  }
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  r.status = "approved";
  r.approved_by = input.approver;
  r.approved_at = now.toISOString();
  r.approval_token_hash = hashToken(token);
  r.approval_token_expires_at = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  await writeState(s);
  return { ok: true, request: { ...r }, token };
}

export type CancelInput = { id: string; actor: string };
export type CancelResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; code: "not_found" | "not_cancellable"; message: string };

export async function cancelRequest(input: CancelInput): Promise<CancelResult> {
  const s = await loadState();
  expireSweep(s);
  const r = s.requests.find((x) => x.id === input.id);
  if (!r) return { ok: false, code: "not_found", message: "approval request not found" };
  if (r.status !== "pending" && r.status !== "approved") {
    return { ok: false, code: "not_cancellable", message: `request is ${r.status}` };
  }
  r.status = "cancelled";
  r.cancelled_at = new Date().toISOString();
  r.cancelled_by = input.actor || null;
  r.approval_token_hash = null;
  await writeState(s);
  return { ok: true, request: { ...r } };
}

export type ConsumeInput = {
  action: string;
  target: string;
  token: string;
  caller: string; // key id consuming
};
export type ConsumeResult =
  | { ok: true; request: ApprovalRequest }
  | {
      ok: false;
      code:
        | "missing_token"
        | "bad_token"
        | "not_approved"
        | "expired"
        | "action_mismatch"
        | "target_mismatch"
        | "wrong_caller";
      message: string;
    };

// consumeApproval is called by the destructive route after admin gate passes
// and BEFORE the action runs. It validates the supplied token, checks the
// token was minted for THIS (action, target), and consumes it (single-use).
export async function consumeApproval(input: ConsumeInput): Promise<ConsumeResult> {
  if (!input.token) {
    return { ok: false, code: "missing_token", message: "approval token required" };
  }
  const s = await loadState();
  expireSweep(s);
  const hash = hashToken(input.token);
  const r = s.requests.find((x) => x.approval_token_hash === hash);
  if (!r) return { ok: false, code: "bad_token", message: "approval token not recognised" };
  if (r.status !== "approved") {
    return { ok: false, code: "not_approved", message: `request is ${r.status}` };
  }
  if (
    !r.approval_token_expires_at ||
    Date.parse(r.approval_token_expires_at) <= Date.now()
  ) {
    r.status = "expired";
    r.approval_token_hash = null;
    await writeState(s);
    return { ok: false, code: "expired", message: "approval token has expired" };
  }
  if (r.action !== input.action) {
    return {
      ok: false,
      code: "action_mismatch",
      message: `token was minted for ${r.action}, not ${input.action}`,
    };
  }
  if (r.target !== input.target) {
    return {
      ok: false,
      code: "target_mismatch",
      message: "token was minted for a different target",
    };
  }
  if (r.requested_by !== input.caller) {
    return {
      ok: false,
      code: "wrong_caller",
      message: "approval tokens can only be redeemed by the original requester",
    };
  }
  r.status = "consumed";
  r.consumed_at = new Date().toISOString();
  r.approval_token_hash = null;
  await writeState(s);
  return { ok: true, request: { ...r } };
}

export async function listRequests(opts?: {
  status?: ApprovalStatus;
}): Promise<ApprovalRequest[]> {
  const s = await loadState();
  expireSweep(s);
  await writeState(s); // persist expirations so listings stay stable
  const rows = s.requests.slice().sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
  if (opts?.status) return rows.filter((r) => r.status === opts.status);
  return rows;
}

export async function getRequest(id: string): Promise<ApprovalRequest | null> {
  const s = await loadState();
  expireSweep(s);
  const r = s.requests.find((x) => x.id === id);
  return r ? { ...r } : null;
}

// Public view never exposes the token hash field.
export function publicView(r: ApprovalRequest) {
  const { approval_token_hash: _h, ...rest } = r;
  return rest;
}

// File-backed invitation store for seat-based onboarding.
//
// An invite is a one-time (or N-time, capped) redemption token. The owner
// or admin mints it with a desired label, scopes, and optional expiry.
// The invitee redeems it via POST /api/invites/{token}/accept to receive
// a freshly minted API key secret (revealed exactly once).
//
// What we store:
//   token            random url-safe string, used as the public id
//   label            display name proposed for the minted key
//   scopes           subset of {"read","trade"} (admin never via invite)
//   max_uses         positive integer cap; default 1
//   used_count       monotonically increasing on each successful redeem
//   accepted_by      [{ key_id, at, ip_hash }]
//   expires_at       ISO timestamp or null
//   revoked          bool
//   created_at       ISO
//   created_by_key_id  id of the admin key that minted (or "anon" in
//                    local mode where the admin surface is unauthenticated)
//
// Atomic writes (tmp + rename). Sequential append queue. The token is
// never reused as a credential: the redeemed API key secret is what the
// caller persists.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "invites.json");

export type InviteScope = "read" | "trade";

export type AcceptedRedemption = {
  key_id: string;
  at: string;
  ip_hash: string;
};

export type Invite = {
  token: string;
  label: string;
  scopes: InviteScope[];
  max_uses: number;
  used_count: number;
  accepted_by: AcceptedRedemption[];
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
  created_by_key_id: string;
};

type Store = { invites: Invite[] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.invites)) return { invites: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { invites: [] };
    throw e;
  }
}

let writeChain: Promise<void> = Promise.resolve();

async function writeStore(s: Store): Promise<void> {
  const run = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await fs.rename(tmp, DATA_FILE);
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function genToken(): string {
  return "inv_" + crypto.randomBytes(24).toString("base64url");
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip || "").digest("hex").slice(0, 32);
}

export function publicView(inv: Invite) {
  return {
    token: inv.token,
    label: inv.label,
    scopes: inv.scopes,
    max_uses: inv.max_uses,
    used_count: inv.used_count,
    remaining: Math.max(0, inv.max_uses - inv.used_count),
    expires_at: inv.expires_at,
    revoked: inv.revoked,
    created_at: inv.created_at,
    created_by_key_id: inv.created_by_key_id,
    accepted_by: inv.accepted_by.map((a) => ({ key_id: a.key_id, at: a.at })),
    status: statusOf(inv),
  };
}

export function redeemerView(inv: Invite) {
  return {
    token: inv.token,
    label: inv.label,
    scopes: inv.scopes,
    expires_at: inv.expires_at,
    status: statusOf(inv),
  };
}

export type InviteStatus = "pending" | "exhausted" | "expired" | "revoked";

export function statusOf(inv: Invite): InviteStatus {
  if (inv.revoked) return "revoked";
  if (inv.expires_at && Date.parse(inv.expires_at) <= Date.now()) return "expired";
  if (inv.used_count >= inv.max_uses) return "exhausted";
  return "pending";
}

export type CreateInviteInput = {
  label: string;
  scopes: InviteScope[];
  max_uses?: number;
  expires_in_seconds?: number | null;
  created_by_key_id?: string;
};

export async function createInvite(input: CreateInviteInput): Promise<Invite> {
  const label = (input.label || "").trim().slice(0, 80) || "invited member";
  const scopes = Array.from(
    new Set(
      (input.scopes || []).filter(
        (s): s is InviteScope => s === "read" || s === "trade",
      ),
    ),
  );
  if (scopes.length === 0) scopes.push("read");
  let max_uses = Number(input.max_uses ?? 1);
  if (!Number.isFinite(max_uses) || max_uses < 1) max_uses = 1;
  if (max_uses > 100) max_uses = 100;
  let expires_at: string | null = null;
  if (input.expires_in_seconds && input.expires_in_seconds > 0) {
    const ttl = Math.min(
      Math.floor(input.expires_in_seconds),
      90 * 24 * 3600,
    );
    expires_at = new Date(Date.now() + ttl * 1000).toISOString();
  }
  const inv: Invite = {
    token: genToken(),
    label,
    scopes,
    max_uses,
    used_count: 0,
    accepted_by: [],
    expires_at,
    revoked: false,
    created_at: new Date().toISOString(),
    created_by_key_id: (input.created_by_key_id || "anon").slice(0, 64),
  };
  const s = await readStore();
  s.invites.push(inv);
  await writeStore(s);
  return inv;
}

export async function listInvites(): Promise<Invite[]> {
  const s = await readStore();
  return [...s.invites].sort((a, b) => (b.created_at < a.created_at ? -1 : 1));
}

export async function getInvite(token: string): Promise<Invite | null> {
  const s = await readStore();
  return s.invites.find((i) => i.token === token) || null;
}

export async function revokeInvite(token: string): Promise<boolean> {
  const s = await readStore();
  const inv = s.invites.find((i) => i.token === token);
  if (!inv) return false;
  if (inv.revoked) return true;
  inv.revoked = true;
  await writeStore(s);
  return true;
}

export async function consumeInvite(
  token: string,
  key_id: string,
  client_ip: string,
): Promise<Invite | null> {
  const s = await readStore();
  const inv = s.invites.find((i) => i.token === token);
  if (!inv) return null;
  if (statusOf(inv) !== "pending") return null;
  inv.used_count += 1;
  inv.accepted_by.push({
    key_id,
    at: new Date().toISOString(),
    ip_hash: hashIp(client_ip),
  });
  await writeStore(s);
  return inv;
}

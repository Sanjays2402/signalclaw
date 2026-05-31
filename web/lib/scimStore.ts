// SCIM 2.0 provisioning store (RFC 7643 / RFC 7644 subset).
//
// Procurement reality: any enterprise that ships SSO with Okta, Azure AD,
// or Google Workspace at scale also requires SCIM lifecycle provisioning,
// so IT can grant/revoke dashboard access from the IdP without filing a
// ticket. Without /scim/v2 the buyer's identity team will reject the
// purchase even if SAML/OIDC works perfectly.
//
// This module persists a list of provisioned users plus the bearer token
// that the IdP uses to authenticate against /scim/v2/*. Tokens are stored
// as SHA-256 hashes; plaintext is shown exactly once at mint time. Every
// state change goes through the same atomic JSON write the rest of the
// app uses, and every mutation is appended to the tamper-evident audit
// chain by the route handlers.
//
// Scope of what we model:
//   * Users with userName (email), name.givenName/familyName, active flag,
//     externalId (the IdP's stable id), and timestamps. This is the
//     "core User schema" subset Okta/Azure AD actually exercise.
//   * Soft delete via active=false (PATCH replace) AND hard delete via
//     DELETE; both are honoured because Okta uses PATCH and Azure AD uses
//     DELETE during deprovisioning.
//
// Out of scope (documented in ServiceProviderConfig):
//   * Groups, bulk, password change, ETag, sort/filter beyond userName eq.
//
// Seat enforcement: creating or re-activating a user consumes one of the
// workspace seats accounted by lib/seats.ts (same pool as API keys), so a
// runaway IdP push cannot exceed the contracted seat count.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const USERS_FILE = path.join(DATA_DIR, "scim-users.json");
const TOKEN_FILE = path.join(DATA_DIR, "scim-token.json");

export type ScimUser = {
  id: string; // server-assigned uuid
  externalId: string | null; // IdP-side stable id
  userName: string; // canonical email
  givenName: string | null;
  familyName: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type UsersStore = { users: ScimUser[] };

type TokenStore = {
  prefix: string | null; // first 10 chars of plaintext, e.g. "scim_live_"
  hash: string | null; // sha256(plaintext) hex
  created_at: string | null;
  last_used_at: string | null;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readUsers(): Promise<UsersStore> {
  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.users)) return { users: [] };
    return j as UsersStore;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { users: [] };
    throw e;
  }
}

async function writeUsers(s: UsersStore): Promise<void> {
  await ensureDir();
  const tmp = USERS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, USERS_FILE);
}

async function readToken(): Promise<TokenStore> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    const j = JSON.parse(raw);
    return {
      prefix: j.prefix ?? null,
      hash: j.hash ?? null,
      created_at: j.created_at ?? null,
      last_used_at: j.last_used_at ?? null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT")
      return { prefix: null, hash: null, created_at: null, last_used_at: null };
    throw e;
  }
}

async function writeToken(t: TokenStore): Promise<void> {
  await ensureDir();
  const tmp = TOKEN_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(t, null, 2), "utf8");
  await fs.rename(tmp, TOKEN_FILE);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeEmail(e: string): string {
  return String(e || "")
    .trim()
    .toLowerCase();
}

// --- Token management -------------------------------------------------

export type TokenStatus = {
  configured: boolean;
  prefix: string | null;
  created_at: string | null;
  last_used_at: string | null;
};

export async function getTokenStatus(): Promise<TokenStatus> {
  const t = await readToken();
  return {
    configured: !!t.hash,
    prefix: t.prefix,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
  };
}

export async function rotateToken(): Promise<{ token: string } & TokenStatus> {
  const plaintext = "scim_live_" + crypto.randomBytes(24).toString("hex");
  const prefix = plaintext.slice(0, 10);
  const t: TokenStore = {
    prefix,
    hash: sha256(plaintext),
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  await writeToken(t);
  return {
    token: plaintext,
    configured: true,
    prefix,
    created_at: t.created_at,
    last_used_at: null,
  };
}

export async function revokeToken(): Promise<void> {
  await writeToken({
    prefix: null,
    hash: null,
    created_at: null,
    last_used_at: null,
  });
}

export async function verifyToken(plaintext: string | null): Promise<boolean> {
  if (!plaintext) return false;
  const t = await readToken();
  if (!t.hash) return false;
  const got = sha256(plaintext);
  // timing-safe compare
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(t.hash, "hex");
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  // Stamp last_used_at (best-effort, swallow write errors so a transient
  // disk hiccup doesn't break the IdP).
  try {
    await writeToken({ ...t, last_used_at: new Date().toISOString() });
  } catch {
    /* ignore */
  }
  return true;
}

// --- User CRUD --------------------------------------------------------

export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function listUsers(filter?: string): Promise<ScimUser[]> {
  const s = await readUsers();
  if (!filter) return s.users;
  // Minimal SCIM filter: userName eq "x"
  const m = filter.match(/^userName\s+eq\s+"([^"]+)"$/i);
  if (m) {
    const want = normalizeEmail(m[1]);
    return s.users.filter((u) => u.userName === want);
  }
  return s.users;
}

export async function getUser(id: string): Promise<ScimUser | null> {
  const s = await readUsers();
  return s.users.find((u) => u.id === id) ?? null;
}

export async function findByUserName(userName: string): Promise<ScimUser | null> {
  const s = await readUsers();
  const want = normalizeEmail(userName);
  return s.users.find((u) => u.userName === want) ?? null;
}

export type CreateUserInput = {
  userName: string;
  externalId?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  active?: boolean;
};

export async function createUser(input: CreateUserInput): Promise<ScimUser> {
  const userName = normalizeEmail(input.userName);
  if (!userName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userName)) {
    const e: any = new Error("invalid userName (must be email)");
    e.status = 400;
    throw e;
  }
  const s = await readUsers();
  if (s.users.some((u) => u.userName === userName)) {
    const e: any = new Error("user already exists");
    e.status = 409;
    e.scimType = "uniqueness";
    throw e;
  }
  const now = new Date().toISOString();
  const u: ScimUser = {
    id: crypto.randomUUID(),
    externalId: input.externalId ?? null,
    userName,
    givenName: input.givenName ?? null,
    familyName: input.familyName ?? null,
    active: input.active !== false,
    created_at: now,
    updated_at: now,
  };
  s.users.push(u);
  await writeUsers(s);
  return u;
}

export async function replaceUser(
  id: string,
  input: CreateUserInput,
): Promise<ScimUser | null> {
  const s = await readUsers();
  const i = s.users.findIndex((u) => u.id === id);
  if (i < 0) return null;
  const prev = s.users[i];
  const userName = normalizeEmail(input.userName || prev.userName);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userName)) {
    const e: any = new Error("invalid userName (must be email)");
    e.status = 400;
    throw e;
  }
  // Uniqueness check (excluding self).
  if (s.users.some((u, j) => j !== i && u.userName === userName)) {
    const e: any = new Error("user already exists");
    e.status = 409;
    e.scimType = "uniqueness";
    throw e;
  }
  const next: ScimUser = {
    ...prev,
    userName,
    externalId: input.externalId ?? prev.externalId,
    givenName: input.givenName ?? prev.givenName,
    familyName: input.familyName ?? prev.familyName,
    active: input.active !== false,
    updated_at: new Date().toISOString(),
  };
  s.users[i] = next;
  await writeUsers(s);
  return next;
}

export type PatchOp = {
  op: string; // add | replace | remove
  path?: string;
  value?: any;
};

export async function patchUser(
  id: string,
  ops: PatchOp[],
): Promise<ScimUser | null> {
  const s = await readUsers();
  const i = s.users.findIndex((u) => u.id === id);
  if (i < 0) return null;
  const u = { ...s.users[i] };
  for (const op of ops || []) {
    const opName = String(op.op || "").toLowerCase();
    // Azure AD pushes value as { active: false } with no path.
    if (!op.path && op.value && typeof op.value === "object") {
      if (typeof op.value.active === "boolean") u.active = op.value.active;
      if (typeof op.value.userName === "string")
        u.userName = normalizeEmail(op.value.userName);
      if (typeof op.value.externalId === "string")
        u.externalId = op.value.externalId;
      if (op.value.name && typeof op.value.name === "object") {
        if (typeof op.value.name.givenName === "string")
          u.givenName = op.value.name.givenName;
        if (typeof op.value.name.familyName === "string")
          u.familyName = op.value.name.familyName;
      }
      continue;
    }
    // Okta pushes path-based ops.
    const p = String(op.path || "").toLowerCase();
    if (p === "active") {
      const v = op.value;
      // Okta sends value as boolean or string "False".
      if (typeof v === "boolean") u.active = v;
      else if (typeof v === "string") u.active = v.toLowerCase() === "true";
    } else if (p === "username") {
      if (opName === "remove") {
        // Refuse: userName is required.
      } else if (typeof op.value === "string") {
        u.userName = normalizeEmail(op.value);
      }
    } else if (p === "name.givenname") {
      u.givenName = opName === "remove" ? null : String(op.value ?? "");
    } else if (p === "name.familyname") {
      u.familyName = opName === "remove" ? null : String(op.value ?? "");
    } else if (p === "externalid") {
      u.externalId = opName === "remove" ? null : String(op.value ?? "");
    }
    // Unknown paths are silently ignored per RFC 7644 §3.5.2.
  }
  u.updated_at = new Date().toISOString();
  s.users[i] = u;
  await writeUsers(s);
  return u;
}

export async function deleteUser(id: string): Promise<boolean> {
  const s = await readUsers();
  const before = s.users.length;
  s.users = s.users.filter((u) => u.id !== id);
  if (s.users.length === before) return false;
  await writeUsers(s);
  return true;
}

// --- SCIM resource formatting ----------------------------------------

export function toScimResource(u: ScimUser, baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: u.id,
    externalId: u.externalId ?? undefined,
    userName: u.userName,
    name: {
      givenName: u.givenName ?? undefined,
      familyName: u.familyName ?? undefined,
    },
    active: u.active,
    emails: [{ value: u.userName, primary: true, type: "work" }],
    meta: {
      resourceType: "User",
      created: u.created_at,
      lastModified: u.updated_at,
      location: `${baseUrl}/scim/v2/Users/${u.id}`,
    },
  };
}

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
    scimType,
  };
}

export function parseScimUserBody(body: any): CreateUserInput {
  if (!body || typeof body !== "object") {
    const e: any = new Error("body must be a JSON object");
    e.status = 400;
    throw e;
  }
  const name = body.name && typeof body.name === "object" ? body.name : {};
  // Prefer explicit primary email if userName missing.
  let userName: string | undefined = body.userName;
  if (!userName && Array.isArray(body.emails)) {
    const primary = body.emails.find((e: any) => e?.primary);
    userName = (primary?.value || body.emails[0]?.value) as string | undefined;
  }
  if (!userName) {
    const e: any = new Error("userName is required");
    e.status = 400;
    throw e;
  }
  return {
    userName,
    externalId: body.externalId ?? null,
    givenName: name.givenName ?? null,
    familyName: name.familyName ?? null,
    active: body.active !== false,
  };
}

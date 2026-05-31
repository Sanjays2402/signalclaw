// File-backed API key store. Real persistence (atomic JSON writes), real
// SHA-256 hashing at rest. Plaintext is shown exactly once at creation time.
//
// Not a multi-tenant auth system. It is, however, real wiring: keys minted
// here unlock the public /v1/* endpoints in this app.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "keys.json");

export type Scope = "read" | "trade" | "admin";

export type StoredKey = {
  id: string;
  label: string;
  prefix: string; // first 8 chars of the plaintext, e.g. "sc_live_ab"
  hash: string; // sha256(plaintext) hex, never exposed via API
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
};

type Store = { keys: StoredKey[] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.keys)) return { keys: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { keys: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function genId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function genSecret(): string {
  // sc_live_<22 url-safe chars>, ~130 bits entropy.
  const raw = crypto.randomBytes(18).toString("base64url");
  return `sc_live_${raw}`;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function publicView(k: StoredKey) {
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    scopes: k.scopes,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    revoked: k.revoked,
  };
}

export async function listKeys(): Promise<StoredKey[]> {
  const s = await readStore();
  // Newest first.
  return [...s.keys].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export type CreateInput = { label: string; scopes: Scope[] };

export async function createKey(
  input: CreateInput,
): Promise<{ key: StoredKey; secret: string }> {
  const label = input.label.trim().slice(0, 80) || "unlabeled";
  // Admin scope can only be granted via env, never via the API, to prevent
  // a freshly-minted "read" key from escalating itself.
  const scopes = Array.from(
    new Set(input.scopes.filter((s) => s === "read" || s === "trade")),
  );
  if (scopes.length === 0) scopes.push("read");

  const secret = genSecret();
  const key: StoredKey = {
    id: genId(),
    label,
    prefix: secret.slice(0, 10),
    hash: sha256(secret),
    scopes,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
  };
  const store = await readStore();
  store.keys.push(key);
  await writeStore(store);
  return { key, secret };
}

export async function revokeKey(id: string): Promise<boolean> {
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return false;
  if (k.revoked) return true;
  k.revoked = true;
  await writeStore(store);
  return true;
}

// Used by /v1/* routes: returns the matching, non-revoked key and bumps
// last_used_at. Returns null if nothing matches.
export async function authenticate(
  secret: string,
): Promise<StoredKey | null> {
  if (!secret) return null;
  // Env-provided admin key, useful for the keys management page itself.
  const adminEnv = process.env.SIGNALCLAW_ADMIN_KEY;
  if (adminEnv && timingSafeEqual(secret, adminEnv)) {
    return {
      id: "env-admin",
      label: "env admin",
      prefix: adminEnv.slice(0, 10),
      hash: sha256(adminEnv),
      scopes: ["admin", "read", "trade"],
      created_at: "1970-01-01T00:00:00.000Z",
      last_used_at: new Date().toISOString(),
      revoked: false,
    };
  }
  const h = sha256(secret);
  const store = await readStore();
  const k = store.keys.find((x) => x.hash === h && !x.revoked);
  if (!k) return null;
  k.last_used_at = new Date().toISOString();
  await writeStore(store).catch(() => {});
  return k;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Extracts a bearer token from a Request, accepting either:
//   Authorization: Bearer sc_live_...
//   x-api-key: sc_live_...
export function extractKey(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^bearer\s+(\S+)/i);
  if (m) return m[1];
  return req.headers.get("x-api-key") || "";
}

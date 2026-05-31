// Framework-free core for the admin gate. Keeps the actual policy
// (`SIGNALCLAW_ADMIN_KEY` opt-in, require admin scope when set) in one
// place so it can be unit-tested without booting Next, and so a non-Next
// caller (cron, internal scripts) could reuse the exact same check.
import { authenticate, extractKey, type StoredKey } from "./keyStore.ts";

export type AdminDecision =
  | { allowed: true; key: StoredKey | null; mode: "local" | "admin"; reason: "local-mode" | "admin-key" }
  | { allowed: false; key: StoredKey | null; mode: "admin"; reason: "forbidden:admin-required" };

export async function decideAdmin(req: Request): Promise<AdminDecision> {
  const k = await authenticate(extractKey(req));
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    return { allowed: true, key: k, mode: "local", reason: "local-mode" };
  }
  if (!k || !k.scopes.includes("admin")) {
    return { allowed: false, key: k ?? null, mode: "admin", reason: "forbidden:admin-required" };
  }
  return { allowed: true, key: k, mode: "admin", reason: "admin-key" };
}

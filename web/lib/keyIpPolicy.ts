import {
  clientIpFromRequest,
  ipMatchesAny,
  parseCidr,
  type ParsedCidr,
} from "./ipMatch";
import type { StoredKey } from "./keyStore";

export type IpDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// Pure (no NextResponse, no audit) per-key IP allowlist decision. Exported
// so it can be unit-tested without importing the Next.js route runtime.
// The route guard in lib/v1Guard.ts calls this and translates the decision
// into a 403 + audit record on block.
export function decideKeyIpAllowed(
  req: Request,
  key: StoredKey,
): IpDecision {
  const list = Array.isArray(key.ip_allowlist) ? key.ip_allowlist : [];
  if (list.length === 0) return { allowed: true };
  const parsed: ParsedCidr[] = [];
  for (const c of list) {
    const p = parseCidr(c);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) return { allowed: true };
  const ip = clientIpFromRequest(req);
  if (ip && ipMatchesAny(ip, parsed)) return { allowed: true };
  return {
    allowed: false,
    reason: ip ? `ip_not_allowed:${ip}` : "ip_not_allowed:unknown",
  };
}

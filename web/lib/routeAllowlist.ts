// Per-API-key route allowlist (least-privilege scope-narrowing).
//
// Scopes (read/trade/admin) decide *what kind* of operation a key can do.
// A route allowlist decides *which v1 paths* it can reach at all. An
// allowlist of [] (or absent) means "any v1 path the scope already allows".
// A non-empty allowlist additionally requires the request path to match at
// least one entry; any other v1 path is denied with 403:route_not_allowed.
//
// Entries are prefix patterns, e.g. "/api/v1/runs" matches "/api/v1/runs"
// and "/api/v1/runs/abc/export". Optional trailing "*" makes the wildcard
// explicit but is not required — every entry is treated as a path prefix
// after trailing-slash normalization.
//
// Validation rules enforced at admin write time:
//   - must start with "/api/v1/"
//   - max 32 entries per key
//   - max 200 chars per entry
//   - characters limited to [A-Za-z0-9_./*-:]
//   - duplicates and trailing "/" / "*" are normalized away
//
// Pure module (no Next imports) so it can be unit-tested without a server.

export const MAX_ROUTE_ENTRIES = 32;
export const MAX_ROUTE_ENTRY_LEN = 200;
const V1_PREFIX = "/api/v1/";
const ALLOWED_CHARS = /^[A-Za-z0-9_./*:-]+$/;

export type RouteAllowlistError = Error & { code: string };

function fail(code: string, message: string): never {
  const e = new Error(message) as RouteAllowlistError;
  e.code = code;
  throw e;
}

function normalizeEntry(raw: string): string {
  let s = raw.trim();
  while (s.endsWith("*")) s = s.slice(0, -1);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function canonicalizeRouteList(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    fail("bad_request", "route_allowlist must be an array of path strings");
  }
  if (input.length > MAX_ROUTE_ENTRIES) {
    fail(
      "too_many_entries",
      `route_allowlist supports a maximum of ${MAX_ROUTE_ENTRIES} entries`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") {
      fail("bad_request", "each route_allowlist entry must be a string");
    }
    if (raw.length > MAX_ROUTE_ENTRY_LEN) {
      fail(
        "bad_request",
        `route_allowlist entry exceeds ${MAX_ROUTE_ENTRY_LEN} chars`,
      );
    }
    const s = normalizeEntry(raw);
    if (s.length === 0) continue;
    if (!ALLOWED_CHARS.test(s)) {
      fail(
        "bad_request",
        `invalid characters in route_allowlist entry: ${JSON.stringify(raw)}`,
      );
    }
    if (!s.startsWith(V1_PREFIX) && s !== "/api/v1") {
      fail(
        "bad_request",
        `route_allowlist entries must start with ${V1_PREFIX} (got ${JSON.stringify(raw)})`,
      );
    }
    if (s.includes("//")) {
      fail(
        "bad_request",
        `route_allowlist entry has empty path segment: ${JSON.stringify(raw)}`,
      );
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function isRouteAllowed(
  path: string,
  allowlist: string[] | null | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const p = normalizeEntry(path);
  for (const entry of allowlist) {
    if (p === entry) return true;
    if (p.startsWith(entry + "/")) return true;
  }
  return false;
}

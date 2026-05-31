// Pure (Next-free) dry-run detection. Split from lib/dryRun.ts so unit tests
// can exercise this without pulling NextResponse into the runtime.
//
// A request opts in by sending `?dry_run=true` (or `1`/`yes`), an
// `X-Dry-Run: true` header, or a top-level `"dry_run": true` JSON body field.

export function isDryRun(req: Request, body?: unknown): boolean {
  try {
    const url = new URL((req as any).url ?? "http://localhost/");
    const q = url.searchParams.get("dry_run");
    if (q != null) {
      const v = q.toLowerCase();
      if (v === "1" || v === "true" || v === "yes") return true;
      if (v === "0" || v === "false" || v === "no") return false;
    }
  } catch {
    // not a URL we can parse; fall through
  }
  const hdr = req.headers.get("x-dry-run");
  if (hdr && /^(1|true|yes)$/i.test(hdr.trim())) return true;
  if (body && typeof body === "object" && (body as any).dry_run === true) {
    return true;
  }
  return false;
}

export type WouldEffect = {
  // Short verb describing the side-effect: "create" | "delete" | "update" |
  // "evaluate" — used by audit log and dashboards.
  action: string;
  // Resource type the action targets: "run" | "alert" | "watchlist_entry" ...
  resource: string;
  // Optional id (may be null when the resource id is not yet allocated).
  id?: string | null;
  // Resource-specific preview payload. Should be safe to render in the UI.
  preview?: unknown;
};

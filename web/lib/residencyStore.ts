// Per-workspace data residency policy.
//
// Enterprise procurement and GDPR Article 44 require that customers be
// able to pin where their data is allowed to be written from. This module
// is the policy. Enforcement lives in v1Guard.enforceDataResidency, which
// runs on every authenticated /api/v1/* request after the IP allowlist
// and rotation checks.
//
// Policy state lives at .data/residency-policy.json. Defaults come from
// SIGNALCLAW_DATA_REGION / SIGNALCLAW_RESIDENCY_MODE so existing installs
// are unaffected until an operator opts in. Mode "off" disables all
// checks (back-compat). Mode "monitor" passes the request through and
// records an audit warning when the request region does not match. Mode
// "enforce" blocks mismatched mutating requests with HTTP 451.
//
// The request region is read from x-data-region (explicit client hint),
// otherwise from x-vercel-ip-country / cf-ipcountry / x-forwarded-country
// (uppercased ISO 3166-1 alpha-2). Country codes are bucketed into one of
// the supported regions by REGION_COUNTRIES below.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "residency-policy.json");

export type Region = "us" | "eu" | "ap" | "global";
export type ResidencyMode = "off" | "monitor" | "enforce";

export type ResidencyPolicy = {
  // The pinned region. "global" means any region is acceptable; the
  // policy still records an audit line in monitor mode but never blocks.
  region: Region;
  mode: ResidencyMode;
  updated_at: string;
  updated_by: string | null;
};

const REGION_VALUES: ReadonlyArray<Region> = ["us", "eu", "ap", "global"];
const MODE_VALUES: ReadonlyArray<ResidencyMode> = ["off", "monitor", "enforce"];

// ISO 3166-1 alpha-2 country code => region bucket. Kept conservative on
// purpose: countries we do not list resolve to "global" so the policy
// never blocks on geo data we cannot vouch for.
const REGION_COUNTRIES: Readonly<Record<string, Region>> = Object.freeze({
  // North America (us bucket)
  US: "us", CA: "us", MX: "us",
  // European Economic Area + UK + CH (eu bucket)
  AT: "eu", BE: "eu", BG: "eu", HR: "eu", CY: "eu", CZ: "eu", DK: "eu",
  EE: "eu", FI: "eu", FR: "eu", DE: "eu", GR: "eu", HU: "eu", IE: "eu",
  IT: "eu", LV: "eu", LT: "eu", LU: "eu", MT: "eu", NL: "eu", PL: "eu",
  PT: "eu", RO: "eu", SK: "eu", SI: "eu", ES: "eu", SE: "eu", IS: "eu",
  LI: "eu", NO: "eu", CH: "eu", GB: "eu",
  // Asia Pacific (ap bucket)
  JP: "ap", KR: "ap", SG: "ap", AU: "ap", NZ: "ap", IN: "ap", HK: "ap",
  TW: "ap", MY: "ap", ID: "ap", PH: "ap", TH: "ap", VN: "ap",
});

function envRegion(): Region {
  const raw = (process.env.SIGNALCLAW_DATA_REGION || "").toLowerCase();
  return REGION_VALUES.includes(raw as Region) ? (raw as Region) : "global";
}

function envMode(): ResidencyMode {
  const raw = (process.env.SIGNALCLAW_RESIDENCY_MODE || "").toLowerCase();
  return MODE_VALUES.includes(raw as ResidencyMode)
    ? (raw as ResidencyMode)
    : "off";
}

export function defaultPolicy(): ResidencyPolicy {
  return {
    region: envRegion(),
    mode: envMode(),
    updated_at: "1970-01-01T00:00:00.000Z",
    updated_by: null,
  };
}

function normalize(p: Partial<ResidencyPolicy>): ResidencyPolicy {
  const d = defaultPolicy();
  const region =
    typeof p.region === "string" && REGION_VALUES.includes(p.region as Region)
      ? (p.region as Region)
      : d.region;
  const mode =
    typeof p.mode === "string" && MODE_VALUES.includes(p.mode as ResidencyMode)
      ? (p.mode as ResidencyMode)
      : d.mode;
  return {
    region,
    mode,
    updated_at: typeof p.updated_at === "string" ? p.updated_at : d.updated_at,
    updated_by: typeof p.updated_by === "string" ? p.updated_by : null,
  };
}

export async function getResidencyPolicy(): Promise<ResidencyPolicy> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return normalize(JSON.parse(raw) || {});
  } catch (e: any) {
    if (e?.code === "ENOENT") return defaultPolicy();
    throw e;
  }
}

export type PolicyInput = {
  region?: Region;
  mode?: ResidencyMode;
  updated_by?: string | null;
};

export async function setResidencyPolicy(
  input: PolicyInput,
): Promise<ResidencyPolicy> {
  if (
    input.region !== undefined &&
    !REGION_VALUES.includes(input.region)
  ) {
    throw new Error(
      `invalid_policy: region must be one of ${REGION_VALUES.join(", ")}`,
    );
  }
  if (input.mode !== undefined && !MODE_VALUES.includes(input.mode)) {
    throw new Error(
      `invalid_policy: mode must be one of ${MODE_VALUES.join(", ")}`,
    );
  }
  const current = await getResidencyPolicy();
  const next: ResidencyPolicy = {
    region: input.region ?? current.region,
    mode: input.mode ?? current.mode,
    updated_at: new Date().toISOString(),
    updated_by:
      input.updated_by !== undefined ? input.updated_by : current.updated_by,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
  return next;
}

// Header sources we accept in priority order. Explicit client hint wins
// over edge-provided country headers so server-to-server calls can assert
// their own provenance.
const COUNTRY_HEADERS = [
  "x-vercel-ip-country",
  "cf-ipcountry",
  "x-forwarded-country",
  "x-country",
];

export type RequestRegion = {
  region: Region;
  source: "explicit" | "country" | "unknown";
  raw: string | null;
};

export function detectRequestRegion(req: Request): RequestRegion {
  const explicit = (req.headers.get("x-data-region") || "").trim().toLowerCase();
  if (explicit && REGION_VALUES.includes(explicit as Region)) {
    return { region: explicit as Region, source: "explicit", raw: explicit };
  }
  for (const h of COUNTRY_HEADERS) {
    const v = (req.headers.get(h) || "").trim().toUpperCase();
    if (!v) continue;
    const region = REGION_COUNTRIES[v];
    if (region) return { region, source: "country", raw: v };
  }
  return { region: "global", source: "unknown", raw: null };
}

export type ResidencyDecision = {
  allowed: boolean;
  // When false, the route should respond 451. When true with status
  // "warn", the audit log gets a warning line but the request proceeds.
  status: "ok" | "warn" | "blocked";
  policy_region: Region;
  request_region: Region;
  request_source: RequestRegion["source"];
  mode: ResidencyMode;
  reason: string | null;
};

// HTTP methods we consider mutating. Read-only requests never get blocked
// by residency; the cost of refusing a GET is too high relative to the
// data sovereignty risk it poses.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export function decideResidency(
  req: Request,
  policy: ResidencyPolicy,
  method: string,
): ResidencyDecision {
  const detected = detectRequestRegion(req);
  const base = {
    policy_region: policy.region,
    request_region: detected.region,
    request_source: detected.source,
    mode: policy.mode,
  };
  if (policy.mode === "off" || policy.region === "global") {
    return { allowed: true, status: "ok", reason: null, ...base };
  }
  const match = detected.region === policy.region;
  if (match) {
    return { allowed: true, status: "ok", reason: null, ...base };
  }
  const reason =
    `residency_mismatch: workspace pinned to ${policy.region}, ` +
    `request resolved to ${detected.region} (source=${detected.source})`;
  if (policy.mode === "monitor" || !isMutating(method)) {
    return { allowed: true, status: "warn", reason, ...base };
  }
  return { allowed: false, status: "blocked", reason, ...base };
}

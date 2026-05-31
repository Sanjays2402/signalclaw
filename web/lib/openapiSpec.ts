// OpenAPI 3.1 spec for the public /api/v1 surface.
//
// Single source of truth: the spec is generated programmatically so it
// cannot rot against the route table. The /v1/openapi.json endpoint and
// the /docs page both consume this module.
//
// Add a new v1 route by appending to PATHS below and (separately) wiring
// the route handler under web/app/api/v1/. The build-time test asserts
// that every path declared here has a corresponding route.ts file on disk,
// so the two cannot drift silently.

export const OPENAPI_VERSION = "3.1.0";
export const API_VERSION = "1.0.0";

type Scope = "read" | "trade" | "admin";

type Param = {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description: string;
  schema: Record<string, unknown>;
};

type Op = {
  summary: string;
  description?: string;
  scopes: Scope[];
  parameters?: Param[];
  requestBody?: {
    description: string;
    schema: Record<string, unknown>;
    required?: boolean;
  };
  responseSchemaRef?: string;
  responseExample?: unknown;
};

type PathSpec = {
  path: string;
  ops: Partial<Record<"get" | "post" | "patch" | "delete", Op>>;
};

// All public v1 paths. Kept in declaration order to match the route tree.
export const PATHS: PathSpec[] = [
  {
    path: "/api/v1/whoami",
    ops: {
      get: {
        summary: "Identify the calling key",
        description:
          "Returns a redacted view of the API key making the request. Use this as a connectivity check before any real call. Any scope is accepted.",
        scopes: ["read"],
        responseSchemaRef: "Whoami",
        responseExample: {
          id: "ab12cd34ef56",
          label: "laptop",
          prefix: "sc_live_ab",
          scopes: ["read"],
          created_at: "2026-05-30T18:02:11.000Z",
          last_used_at: "2026-05-31T07:14:09.000Z",
          server_time: "2026-05-31T07:14:09.000Z",
        },
      },
    },
  },
  {
    path: "/api/v1/usage",
    ops: {
      get: {
        summary: "Read free-tier usage and quota",
        scopes: ["read"],
        responseSchemaRef: "UsageSummary",
      },
    },
  },
  {
    path: "/api/v1/runs",
    ops: {
      get: {
        summary: "List regime runs",
        scopes: ["read"],
        parameters: [
          { name: "q", in: "query", required: false, description: "Free-text label filter.", schema: { type: "string" } },
          { name: "ticker", in: "query", required: false, description: "Filter by ticker symbol.", schema: { type: "string" } },
          { name: "regime", in: "query", required: false, description: "Filter by classified regime label.", schema: { type: "string" } },
          { name: "limit", in: "query", required: false, description: "Page size (1-200).", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "offset", in: "query", required: false, description: "Page offset.", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responseSchemaRef: "RunList",
      },
      post: {
        summary: "Create a regime run",
        scopes: ["trade"],
        requestBody: {
          description: "Run parameters.",
          required: true,
          schema: {
            type: "object",
            required: ["ticker"],
            properties: {
              ticker: { type: "string", description: "Ticker symbol, e.g. SPY." },
              lookback_days: { type: "integer", minimum: 5, maximum: 720, default: 60 },
              label: { type: "string", description: "Optional human label." },
            },
          },
        },
        responseSchemaRef: "Run",
      },
    },
  },
  {
    path: "/api/v1/runs/{id}",
    ops: {
      get: {
        summary: "Fetch a single run by id",
        scopes: ["read"],
        parameters: [{ name: "id", in: "path", required: true, description: "Run id.", schema: { type: "string" } }],
        responseSchemaRef: "Run",
      },
      delete: {
        summary: "Delete a run",
        scopes: ["trade"],
        parameters: [{ name: "id", in: "path", required: true, description: "Run id.", schema: { type: "string" } }],
        responseSchemaRef: "DeletedAck",
      },
    },
  },
  {
    path: "/api/v1/runs/{id}/pdf",
    ops: {
      get: {
        summary: "Download a run as PDF",
        scopes: ["read"],
        parameters: [{ name: "id", in: "path", required: true, description: "Run id.", schema: { type: "string" } }],
      },
    },
  },
  {
    path: "/api/v1/runs/{id}/export",
    ops: {
      get: {
        summary: "Export a single run as JSON",
        scopes: ["read"],
        parameters: [{ name: "id", in: "path", required: true, description: "Run id.", schema: { type: "string" } }],
      },
    },
  },
  {
    path: "/api/v1/runs/export",
    ops: {
      get: {
        summary: "Export all runs (JSON or CSV)",
        scopes: ["read"],
        parameters: [
          { name: "format", in: "query", required: false, description: "json or csv.", schema: { type: "string", enum: ["json", "csv"], default: "json" } },
        ],
      },
    },
  },
  {
    path: "/api/v1/watchlist",
    ops: {
      get: { summary: "List watched tickers", scopes: ["read"], responseSchemaRef: "WatchlistList" },
      post: {
        summary: "Add a ticker to the watchlist",
        scopes: ["trade"],
        requestBody: {
          description: "Watchlist add request.",
          required: true,
          schema: {
            type: "object",
            required: ["ticker"],
            properties: { ticker: { type: "string" }, note: { type: "string" } },
          },
        },
        responseSchemaRef: "WatchlistItem",
      },
    },
  },
  {
    path: "/api/v1/watchlist/{ticker}",
    ops: {
      get: {
        summary: "Fetch one watchlist entry",
        scopes: ["read"],
        parameters: [{ name: "ticker", in: "path", required: true, description: "Ticker symbol.", schema: { type: "string" } }],
        responseSchemaRef: "WatchlistItem",
      },
      patch: {
        summary: "Update a watchlist entry",
        scopes: ["trade"],
        parameters: [{ name: "ticker", in: "path", required: true, description: "Ticker symbol.", schema: { type: "string" } }],
        requestBody: {
          description: "Fields to update.",
          required: true,
          schema: { type: "object", properties: { note: { type: "string" } } },
        },
        responseSchemaRef: "WatchlistItem",
      },
      delete: {
        summary: "Remove a watchlist entry",
        scopes: ["trade"],
        parameters: [{ name: "ticker", in: "path", required: true, description: "Ticker symbol.", schema: { type: "string" } }],
        responseSchemaRef: "DeletedAck",
      },
    },
  },
  {
    path: "/api/v1/alerts",
    ops: {
      get: { summary: "List configured alerts", scopes: ["read"], responseSchemaRef: "AlertList" },
      post: {
        summary: "Create an alert",
        scopes: ["trade"],
        requestBody: {
          description: "Alert definition.",
          required: true,
          schema: {
            type: "object",
            required: ["ticker", "kind"],
            properties: {
              ticker: { type: "string" },
              kind: { type: "string", enum: ["entered", "exited", "upgraded", "downgraded", "score_jump"] },
              threshold: { type: "number" },
            },
          },
        },
        responseSchemaRef: "Alert",
      },
    },
  },
  {
    path: "/api/v1/alerts/{id}",
    ops: {
      delete: {
        summary: "Delete an alert",
        scopes: ["trade"],
        parameters: [{ name: "id", in: "path", required: true, description: "Alert id.", schema: { type: "string" } }],
        responseSchemaRef: "DeletedAck",
      },
    },
  },
  {
    path: "/api/v1/alerts/check",
    ops: {
      post: {
        summary: "Force an alert evaluation pass",
        scopes: ["trade"],
        responseSchemaRef: "AlertCheckResult",
      },
    },
  },
  {
    path: "/api/v1/audit",
    ops: {
      get: {
        summary: "Read the tamper-evident audit log",
        description: "Returns recent audit events. Admin scope required. Supports day-range filtering and CSV export via Accept: text/csv.",
        scopes: ["admin"],
        parameters: [
          { name: "from", in: "query", required: false, description: "ISO date (UTC) lower bound.", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", required: false, description: "ISO date (UTC) upper bound.", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query", required: false, description: "Max events (1-1000).", schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 } },
        ],
        responseSchemaRef: "AuditPage",
      },
    },
  },
];

// Reusable component schemas. Kept intentionally small so the spec stays
// readable; client codegen still gets useful types.
const COMPONENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", description: "Stable machine-readable error code." },
          message: { type: "string", description: "Human-readable explanation." },
        },
      },
    },
  },
  Whoami: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      prefix: { type: "string" },
      scopes: { type: "array", items: { type: "string", enum: ["read", "trade", "admin"] } },
      created_at: { type: "string", format: "date-time" },
      last_used_at: { type: ["string", "null"], format: "date-time" },
      server_time: { type: "string", format: "date-time" },
    },
  },
  UsageSummary: {
    type: "object",
    properties: {
      window: { type: "string", description: "Window identifier, e.g. day:2026-05-31." },
      limit: { type: "integer" },
      used: { type: "integer" },
      remaining: { type: "integer" },
      reset_at: { type: "string", format: "date-time" },
    },
  },
  Run: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      ticker: { type: "string" },
      created_at: { type: "string", format: "date-time" },
      regime: { type: "string" },
      score: { type: "number" },
    },
  },
  RunList: {
    type: "object",
    properties: {
      runs: { type: "array", items: { $ref: "#/components/schemas/Run" } },
      total: { type: "integer" },
      limit: { type: "integer" },
      offset: { type: "integer" },
    },
  },
  WatchlistItem: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      note: { type: "string" },
      added_at: { type: "string", format: "date-time" },
    },
  },
  WatchlistList: {
    type: "object",
    properties: { items: { type: "array", items: { $ref: "#/components/schemas/WatchlistItem" } } },
  },
  Alert: {
    type: "object",
    properties: {
      id: { type: "string" },
      ticker: { type: "string" },
      kind: { type: "string", enum: ["entered", "exited", "upgraded", "downgraded", "score_jump"] },
      threshold: { type: ["number", "null"] },
      created_at: { type: "string", format: "date-time" },
    },
  },
  AlertList: {
    type: "object",
    properties: { alerts: { type: "array", items: { $ref: "#/components/schemas/Alert" } } },
  },
  AlertCheckResult: {
    type: "object",
    properties: {
      evaluated: { type: "integer" },
      fired: { type: "integer" },
      at: { type: "string", format: "date-time" },
    },
  },
  AuditEvent: {
    type: "object",
    properties: {
      ts: { type: "string", format: "date-time" },
      route: { type: "string" },
      method: { type: "string" },
      status: { type: "integer" },
      key_id: { type: ["string", "null"] },
      key_label: { type: ["string", "null"] },
      reason: { type: ["string", "null"] },
      ip_hash: { type: ["string", "null"] },
      chain_hash: { type: "string", description: "HMAC chain hash; tamper-evident." },
    },
  },
  AuditPage: {
    type: "object",
    properties: {
      events: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } },
      from: { type: ["string", "null"] },
      to: { type: ["string", "null"] },
      limit: { type: "integer" },
    },
  },
  DeletedAck: {
    type: "object",
    properties: { deleted: { type: "boolean" }, id: { type: "string" } },
  },
};

function scopeLine(scopes: readonly Scope[]): string {
  if (!scopes.length) return "Any authenticated key.";
  return `Required scope: one of [${scopes.join(", ")}] (admin satisfies all).`;
}

function buildOperation(op: Op, method: string, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    summary: op.summary,
    description: [op.description, scopeLine(op.scopes)].filter(Boolean).join("\n\n"),
    operationId: `${method.toLowerCase()}_${path
      .replace(/^\/api\/v1\//, "")
      .replace(/[{}]/g, "")
      .replace(/[/-]/g, "_") || "root"}`,
    tags: [path.split("/")[3] || "v1"],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  };
  if (op.parameters?.length) out.parameters = op.parameters;
  if (op.requestBody) {
    out.requestBody = {
      required: !!op.requestBody.required,
      description: op.requestBody.description,
      content: { "application/json": { schema: op.requestBody.schema } },
    };
  }
  const okContent: Record<string, unknown> = {};
  if (op.responseSchemaRef) {
    okContent["application/json"] = {
      schema: { $ref: `#/components/schemas/${op.responseSchemaRef}` },
      ...(op.responseExample !== undefined ? { example: op.responseExample } : {}),
    };
  } else {
    okContent["application/json"] = { schema: { type: "object" } };
  }
  out.responses = {
    "200": { description: "OK", content: okContent },
    "401": {
      description: "Missing or invalid API key.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
    "403": {
      description: "Authenticated but missing the required scope, or blocked by key IP allowlist.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
    "429": {
      description: "Rate-limited. Inspect X-RateLimit-* and Retry-After headers.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      headers: {
        "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed per window." },
        "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests remaining in the window." },
        "X-RateLimit-Reset": { schema: { type: "integer" }, description: "Unix seconds when the window resets." },
        "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait before retrying." },
      },
    },
  };
  return out;
}

export type Spec = Record<string, unknown>;

export function buildSpec(origin?: string): Spec {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const p of PATHS) {
    // Normalize Next.js [param] segments to OpenAPI {param}.
    const oasPath = p.path.replace(/\[([^\]]+)\]/g, "{$1}");
    const item: Record<string, unknown> = {};
    for (const [m, op] of Object.entries(p.ops)) {
      if (!op) continue;
      item[m] = buildOperation(op, m, oasPath);
    }
    paths[oasPath] = item;
  }
  const servers = origin
    ? [{ url: origin, description: "Caller origin" }]
    : [{ url: "/", description: "Same-origin" }];
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Signalclaw v1 API",
      version: API_VERSION,
      summary: "Public REST surface for the Signalclaw regime classifier.",
      description:
        "Programmatic access to runs, watchlist, alerts, usage, and the tamper-evident audit log. Authenticate with an API key minted under Settings → API keys; pass it as Authorization: Bearer <key> or x-api-key: <key>. All responses are JSON unless a route explicitly documents otherwise. Errors use a stable {error:{code,message}} envelope.",
      contact: { name: "Signalclaw", url: "https://github.com/Sanjays2402/signalclaw" },
      license: { name: "MIT" },
    },
    servers,
    tags: [
      { name: "whoami", description: "Identity and connectivity." },
      { name: "usage", description: "Quota and usage meter." },
      { name: "runs", description: "Regime classifier runs." },
      { name: "watchlist", description: "Tracked tickers." },
      { name: "alerts", description: "Regime-change alerts." },
      { name: "audit", description: "Tamper-evident audit log." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "API key as bearer token. Mint under Settings → API keys.",
        },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "API key in the x-api-key header (alternative to Authorization).",
        },
      },
      schemas: COMPONENT_SCHEMAS,
    },
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    paths,
  };
}

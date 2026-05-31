"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Code,
  Copy,
  Check,
  PlayCircle,
  Key,
  ShieldCheck,
  Lightning,
  Lock,
  ArrowSquareOut,
} from "@phosphor-icons/react/dist/ssr";
import { Card, Badge, Loading, ErrorBox } from "@/components/ui";

type Scope = "read" | "trade" | "admin";

type Endpoint = {
  id: string;
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  scopes: Scope[];
  summary: string;
  body?: string;
  responseSample: string;
};

const ENDPOINTS: Endpoint[] = [
  {
    id: "whoami",
    method: "GET",
    path: "/api/v1/whoami",
    scopes: ["read"],
    summary:
      "Identify the calling key. Use this from a notebook or CI job to confirm credentials are wired up before any real call.",
    responseSample: `{
  "id": "ab12cd34ef56",
  "label": "laptop",
  "prefix": "sc_live_ab",
  "scopes": ["read"],
  "created_at": "2026-05-30T18:02:11.000Z",
  "last_used_at": "2026-05-31T07:14:09.000Z",
  "server_time": "2026-05-31T07:14:09.000Z"
}`,
  },
  {
    id: "runs-list",
    method: "GET",
    path: "/api/v1/runs?limit=10",
    scopes: ["read"],
    summary:
      "List saved regime runs in reverse chronological order. Supports q, ticker, regime, limit, and offset.",
    responseSample: `{
  "runs": [
    {
      "id": "r_8f3c2a",
      "label": "SPY \\u00b7 60d \\u00b7 api",
      "ticker": "SPY",
      "lookback_days": 60,
      "created_at": "2026-05-31T07:10:00.000Z",
      "bars": 60,
      "regime": "bull",
      "confidence": 0.72,
      "share_url": "/r/r_8f3c2a"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0,
  "has_more": false
}`,
  },
  {
    id: "runs-create",
    method: "POST",
    path: "/api/v1/runs",
    scopes: ["trade"],
    summary:
      "Classify a caller-supplied price series, persist the run, fire webhook subscribers, and return the saved run id plus a public share URL.",
    body: `{
  "ticker": "SPY",
  "close": [410.1, 412.4, 411.8, 415.2, 418.0, 420.6, 422.1],
  "lookback_days": 7,
  "label": "spy short window",
  "tags": ["api", "smoke-test"]
}`,
    responseSample: `{
  "id": "r_8f3c2a",
  "label": "spy short window",
  "ticker": "SPY",
  "created_at": "2026-05-31T07:10:00.000Z",
  "lookback_days": 7,
  "bars": 7,
  "snapshot": {
    "label": "bull",
    "as_of": "2026-05-31",
    "confidence": 0.71,
    "risk_scale": 1.0
  },
  "tags": ["api", "smoke-test"],
  "share_url": "/r/r_8f3c2a"
}`,
  },
  {
    id: "runs-get",
    method: "GET",
    path: "/api/v1/runs/{id}",
    scopes: ["read"],
    summary:
      "Fetch a single saved run by id. Returns the full payload including the dates, close series, regime labels per bar, and the snapshot.",
    responseSample: `{
  "id": "r_8f3c2a",
  "label": "spy short window",
  "ticker": "SPY",
  "payload": { "dates": ["..."], "close": [], "regime": [], "snapshot": {} }
}`,
  },
  {
    id: "runs-pdf",
    method: "GET",
    path: "/api/v1/runs/{id}/pdf",
    scopes: ["read"],
    summary:
      "Render a one-page PDF report for any saved run. Suitable for archiving or sharing with a non-technical reviewer.",
    responseSample: `<binary PDF, content-type application/pdf>`,
  },
  {
    id: "alerts-list",
    method: "GET",
    path: "/api/v1/alerts",
    scopes: ["read"],
    summary:
      "List every armed price or percent alert. Use this from a watchdog job to confirm what is currently being monitored.",
    responseSample: `{
  "alerts": [
    { "id": "...", "ticker": "NVDA", "condition": "price_above", "value": 150 }
  ],
  "total": 1,
  "limit": 200
}`,
  },
  {
    id: "alerts-create",
    method: "POST",
    path: "/api/v1/alerts",
    scopes: ["trade"],
    summary:
      "Arm a new alert. Conditions: price_above, price_below, pct_change_above, pct_change_below. Cooldown is in hours and defaults to 12.",
    body: `{
  "ticker": "NVDA",
  "condition": "price_above",
  "value": 150,
  "cooldown_hours": 6,
  "note": "breakout watch"
}`,
    responseSample: `{
  "alert": {
    "id": "a_8f3c2a",
    "ticker": "NVDA",
    "condition": "price_above",
    "value": 150,
    "enabled": true
  }
}`,
  },
  {
    id: "alerts-delete",
    method: "DELETE",
    path: "/api/v1/alerts/{id}",
    scopes: ["trade"],
    summary:
      "Disarm a single alert by id. Returns 404 if the alert is already gone.",
    responseSample: `{ "ok": true, "id": "a_8f3c2a" }`,
  },
  {
    id: "alerts-check",
    method: "POST",
    path: "/api/v1/alerts/check",
    scopes: ["trade"],
    summary:
      "Evaluate every armed alert against supplied prices, or the built-in quote source when prices is omitted. Hits are logged to alert history and the activity feed.",
    body: `{ "prices": { "NVDA": 152.4 } }`,
    responseSample: `{
  "hits": [
    { "alert_id": "a_8f3c2a", "ticker": "NVDA", "observed": 152.4 }
  ],
  "checked": 1,
  "quotes": { "NVDA": { "last": 152.4, "prev": 150 } }
}`,
  },
  {
    id: "watchlist-list",
    method: "GET",
    path: "/api/v1/watchlist",
    scopes: ["read"],
    summary:
      "List every tracked ticker in stable insertion order. Returns both the rich entry view and a flat ticker array for legacy clients.",
    responseSample: `{
  "entries": [
    { "ticker": "NVDA", "added_at": "2025-01-04T18:22:11Z", "note": "breakout watch" }
  ],
  "tickers": ["NVDA"],
  "total": 1,
  "limit": 100
}`,
  },
  {
    id: "watchlist-add",
    method: "POST",
    path: "/api/v1/watchlist",
    scopes: ["trade"],
    summary:
      "Add a ticker to the watchlist. Re-posting an existing ticker with a note updates the note. Returns 409 when the cap of 100 tickers is reached.",
    body: `{ "ticker": "NVDA", "note": "breakout watch" }`,
    responseSample: `{
  "entry": { "ticker": "NVDA", "added_at": "2025-01-04T18:22:11Z", "note": "breakout watch" }
}`,
  },
  {
    id: "watchlist-update",
    method: "PATCH",
    path: "/api/v1/watchlist/{ticker}",
    scopes: ["trade"],
    summary:
      "Update the note on an existing watchlist entry. Send {\"note\": null} to clear it. Returns 404 if the ticker is not tracked.",
    body: `{ "note": "earnings on the 24th" }`,
    responseSample: `{
  "entry": { "ticker": "NVDA", "added_at": "2025-01-04T18:22:11Z", "note": "earnings on the 24th" }
}`,
  },
  {
    id: "watchlist-remove",
    method: "DELETE",
    path: "/api/v1/watchlist/{ticker}",
    scopes: ["trade"],
    summary:
      "Remove a ticker from the watchlist. Returns 404 if the ticker was not tracked.",
    responseSample: `{ "ok": true, "ticker": "NVDA" }`,
  },
];

const SCOPE_TONE: Record<Scope, "up" | "warn" | "down"> = {
  read: "up",
  trade: "warn",
  admin: "down",
};

function methodTone(m: Endpoint["method"]): string {
  if (m === "GET") return "var(--green, #4ade80)";
  if (m === "POST") return "var(--amber)";
  if (m === "PATCH") return "var(--amber)";
  return "var(--red, #f87171)";
}

function maskedKey(key: string): string {
  if (!key) return "sc_live_YOUR_KEY";
  if (key.length <= 12) return key;
  return key.slice(0, 10) + "..." + key.slice(-4);
}

function buildCurl(ep: Endpoint, origin: string, key: string): string {
  const url = `${origin}${ep.path}`;
  const lines: string[] = [`curl -X ${ep.method} '${url}' \\`];
  lines.push(`  -H 'Authorization: Bearer ${key || "sc_live_YOUR_KEY"}' \\`);
  if (ep.body) {
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '${ep.body.replace(/'/g, "'\\''")}'`);
  } else {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, "");
  }
  return lines.join("\n");
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  }
  return (
    <div className="relative group">
      <pre className="bg-black/40 border border-[var(--border)] rounded-sm p-3 text-[11px] mono overflow-x-auto whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] bg-[var(--bg-elev)] hover:bg-white/5 uppercase tracking-widest mono flex items-center gap-1 opacity-70 group-hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
      >
        {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function EndpointCard({
  ep,
  origin,
  apiKey,
}: {
  ep: Endpoint;
  origin: string;
  apiKey: string;
}) {
  const [tryState, setTryState] = useState<"idle" | "loading" | "ok" | "err">(
    "idle",
  );
  const [tryResp, setTryResp] = useState<string>("");
  const [tryStatus, setTryStatus] = useState<number | null>(null);

  const supportsTry = ep.method === "GET" && !ep.path.includes("{id}");
  const curl = buildCurl(ep, origin, apiKey);

  async function onTry() {
    if (!supportsTry) return;
    setTryState("loading");
    setTryResp("");
    setTryStatus(null);
    try {
      const r = await fetch(ep.path, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey || ""}`,
        },
        cache: "no-store",
      });
      setTryStatus(r.status);
      const text = await r.text();
      try {
        setTryResp(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setTryResp(text);
      }
      setTryState(r.ok ? "ok" : "err");
    } catch (e) {
      setTryState("err");
      setTryResp(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Code size={12} weight="duotone" />
          {ep.id}
        </span>
      }
      right={
        <div className="flex items-center gap-1.5">
          {ep.scopes.map((s) => (
            <Badge key={s} tone={SCOPE_TONE[s]}>
              {s}
            </Badge>
          ))}
        </div>
      }
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span
          className="mono text-[10px] uppercase font-bold px-2 py-0.5 rounded-sm border border-[var(--border-strong)]"
          style={{ color: methodTone(ep.method) }}
        >
          {ep.method}
        </span>
        <span className="mono text-[12px] break-all">{ep.path}</span>
      </div>
      <p className="text-[12px] muted leading-relaxed mb-3">{ep.summary}</p>

      {ep.body && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-widest muted mb-1">
            Request body
          </div>
          <CodeBlock text={ep.body} />
        </div>
      )}

      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest muted mb-1">
          curl
        </div>
        <CodeBlock text={curl} />
      </div>

      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest muted mb-1">
          Sample response
        </div>
        <CodeBlock text={ep.responseSample} />
      </div>

      {supportsTry && (
        <div className="border-t border-[var(--border)] pt-3">
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              onClick={onTry}
              disabled={tryState === "loading" || !apiKey}
              className="text-[11px] px-3 py-1.5 rounded-sm border border-[var(--border-strong)] bg-[var(--amber)] text-black font-semibold uppercase tracking-widest mono flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
            >
              <PlayCircle size={12} weight="bold" />
              {tryState === "loading" ? "Running" : "Try it"}
            </button>
            {!apiKey && (
              <span className="text-[10px] muted uppercase tracking-widest">
                Sign in first to enable
              </span>
            )}
            {tryStatus !== null && (
              <Badge tone={tryState === "ok" ? "up" : "down"}>
                {tryStatus}
              </Badge>
            )}
          </div>
          {tryResp && (
            <pre className="bg-black/40 border border-[var(--border)] rounded-sm p-3 text-[11px] mono overflow-x-auto whitespace-pre max-h-72">
              {tryResp}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

export default function DocsPage() {
  const [apiKey, setApiKey] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const k = typeof window !== "undefined"
      ? localStorage.getItem("sc_api_key") || ""
      : "";
    setApiKey(k);
    setOrigin(typeof window !== "undefined" ? window.location.origin : "");
    setReady(true);
  }, []);

  const masked = useMemo(() => maskedKey(apiKey), [apiKey]);

  return (
    <div className="max-w-5xl mx-auto">
      <header className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <BookOpen size={16} weight="duotone" />
          <h1 className="text-base font-semibold mono uppercase tracking-widest">
            API reference
          </h1>
        </div>
        <p className="text-[12px] muted leading-relaxed max-w-3xl">
          Programmatic access to SignalClaw runs. All endpoints live under{" "}
          <span className="mono">/api/v1</span>. Authenticate with the same key
          you minted on the{" "}
          <Link href="/settings/keys" className="underline decoration-dotted">
            keys page
          </Link>
          , sent as <span className="mono">Authorization: Bearer ...</span> or{" "}
          <span className="mono">x-api-key</span>. Errors are returned as{" "}
          <span className="mono">{`{ error: { code, message } }`}</span>.
        </p>
      </header>

      <div className="grid md:grid-cols-3 gap-3 mb-5">
        <Card
          title={
            <span className="flex items-center gap-2">
              <Key size={12} weight="duotone" />
              your key
            </span>
          }
        >
          {!ready ? (
            <Loading />
          ) : apiKey ? (
            <div>
              <div className="mono text-[12px] mb-2 break-all">{masked}</div>
              <p className="text-[11px] muted leading-relaxed">
                This is the key your browser is using. Examples below are
                prefilled with it.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-[11px] muted leading-relaxed mb-2">
                You are not signed in. Mint a key to make the examples below
                runnable.
              </p>
              <Link
                href="/settings/keys"
                className="text-[11px] mono uppercase tracking-widest text-[var(--amber)] hover:underline flex items-center gap-1"
              >
                Manage keys
                <ArrowSquareOut size={11} weight="bold" />
              </Link>
            </div>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck size={12} weight="duotone" />
              scopes
            </span>
          }
        >
          <ul className="space-y-1.5 text-[11px]">
            <li className="flex items-center gap-2">
              <Badge tone="up">read</Badge>
              <span className="muted">list, fetch, export, pdf</span>
            </li>
            <li className="flex items-center gap-2">
              <Badge tone="warn">trade</Badge>
              <span className="muted">create runs, fire webhooks</span>
            </li>
            <li className="flex items-center gap-2">
              <Badge tone="down">admin</Badge>
              <span className="muted">all of the above, plus key management</span>
            </li>
          </ul>
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              <Lightning size={12} weight="duotone" />
              rate limits
            </span>
          }
        >
          <p className="text-[11px] muted leading-relaxed">
            Free tier: 200 runs per month per account. Monitor live usage on
            the{" "}
            <Link href="/usage" className="underline decoration-dotted">
              usage page
            </Link>
            . Bursts above 10 requests per second may be queued.
          </p>
        </Card>
      </div>

      <Card
        title={
          <span className="flex items-center gap-2">
            <Lock size={12} weight="duotone" />
            base URL and auth
          </span>
        }
        className="mb-5"
      >
        <p className="text-[11px] muted mb-2 leading-relaxed">
          Substitute the host with your deployment. For local development the
          base is shown below.
        </p>
        <CodeBlock
          text={`# Base URL
${origin || "http://localhost:3000"}

# Header form 1
Authorization: Bearer ${apiKey || "sc_live_YOUR_KEY"}

# Header form 2 (equivalent)
x-api-key: ${apiKey || "sc_live_YOUR_KEY"}`}
        />
      </Card>

      <section className="space-y-3">
        {ENDPOINTS.map((ep) => (
          <EndpointCard
            key={ep.id}
            ep={ep}
            origin={origin || "http://localhost:3000"}
            apiKey={apiKey}
          />
        ))}
      </section>

      <p className="text-[10px] muted uppercase tracking-widest mt-6">
        All payloads are JSON unless noted. Research only. Not advice.
      </p>
    </div>
  );
}

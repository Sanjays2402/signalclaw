// File-backed JSON store for saved demo runs.
// Persisted at web/.data/runs.json so saves survive process restarts.
// Not a real DB, but real persistence with atomic writes.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "runs.json");
const MAX_RUNS = 500;

export type SavedRun = {
  id: string;
  label: string;
  ticker: string;
  lookback_days: number;
  created_at: string;
  payload: {
    ticker: string;
    dates: string[];
    close: number[];
    regime: (string | null)[];
    counts: Record<string, number>;
    snapshot: {
      label: string;
      realized_vol: number;
      trend_slope: number;
      drawdown: number;
      confidence: number;
      risk_scale: number;
      as_of: string;
    } | null;
    disclaimer: string;
  };
};

type Store = { runs: SavedRun[] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.runs)) return { runs: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { runs: [] };
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
  // 10-char URL-safe id, ~60 bits entropy. Good enough for unguessable share links.
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

export async function listRuns(): Promise<SavedRun[]> {
  const s = await readStore();
  return [...s.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function getRun(id: string): Promise<SavedRun | null> {
  const s = await readStore();
  return s.runs.find((r) => r.id === id) ?? null;
}

export async function createRun(
  input: Omit<SavedRun, "id" | "created_at">,
): Promise<SavedRun> {
  const s = await readStore();
  const run: SavedRun = {
    ...input,
    id: genId(),
    created_at: new Date().toISOString(),
  };
  s.runs.push(run);
  // Bound store size.
  if (s.runs.length > MAX_RUNS) {
    s.runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    s.runs = s.runs.slice(0, MAX_RUNS);
  }
  await writeStore(s);
  return run;
}

export async function deleteRun(id: string): Promise<boolean> {
  const s = await readStore();
  const before = s.runs.length;
  s.runs = s.runs.filter((r) => r.id !== id);
  if (s.runs.length === before) return false;
  await writeStore(s);
  return true;
}

export async function renameRun(id: string, label: string): Promise<SavedRun | null> {
  const s = await readStore();
  const r = s.runs.find((r) => r.id === id);
  if (!r) return null;
  r.label = label;
  await writeStore(s);
  return r;
}

export type QueryOpts = {
  q?: string;
  regime?: string;
  ticker?: string;
  limit?: number;
  offset?: number;
};

export type QueryResult = {
  runs: SavedRun[];
  total: number;
  limit: number;
  offset: number;
};

export async function queryRuns(opts: QueryOpts = {}): Promise<QueryResult> {
  const s = await readStore();
  const q = (opts.q ?? "").trim().toLowerCase();
  const regime = (opts.regime ?? "").trim().toLowerCase();
  const ticker = (opts.ticker ?? "").trim().toUpperCase();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  let filtered = s.runs;
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.ticker.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q),
    );
  }
  if (regime && regime !== "all") {
    filtered = filtered.filter(
      (r) => (r.payload.snapshot?.label ?? "").toLowerCase() === regime,
    );
  }
  if (ticker) {
    filtered = filtered.filter((r) => r.ticker.toUpperCase() === ticker);
  }
  filtered = [...filtered].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  return { runs: page, total, limit, offset };
}

// Pure CSV serializer for one or many saved runs. Each row = one bar.
export function runsToCSV(runs: SavedRun[]): string {
  const header = [
    "run_id",
    "label",
    "ticker",
    "lookback_days",
    "created_at",
    "regime_label",
    "confidence",
    "risk_scale",
    "bar_date",
    "close",
    "bar_regime",
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines: string[] = [header.join(",")];
  for (const r of runs) {
    const snap = r.payload.snapshot;
    const dates = r.payload.dates ?? [];
    const close = r.payload.close ?? [];
    const reg = r.payload.regime ?? [];
    if (dates.length === 0) {
      lines.push(
        [
          r.id,
          r.label,
          r.ticker,
          r.lookback_days,
          r.created_at,
          snap?.label ?? "",
          snap?.confidence ?? "",
          snap?.risk_scale ?? "",
          "",
          "",
          "",
        ]
          .map(esc)
          .join(","),
      );
      continue;
    }
    for (let i = 0; i < dates.length; i++) {
      lines.push(
        [
          r.id,
          r.label,
          r.ticker,
          r.lookback_days,
          r.created_at,
          snap?.label ?? "",
          snap?.confidence ?? "",
          snap?.risk_scale ?? "",
          dates[i],
          close[i] ?? "",
          reg[i] ?? "",
        ]
          .map(esc)
          .join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}

// Test helper: in-memory reset, only used by unit tests.
export async function _resetForTests(): Promise<void> {
  try {
    await fs.unlink(DATA_FILE);
  } catch {}
}

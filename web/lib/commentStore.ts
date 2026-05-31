// File-backed JSON store for public comments on shared runs.
// Persisted at web/.data/comments.json with atomic writes.
//
// Real wiring: anyone visiting /r/<id> can leave a comment (rate-limited
// per IP). The run owner can delete comments via the admin-scoped endpoint.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "comments.json");

export const MAX_AUTHOR_LEN = 40;
export const MAX_BODY_LEN = 1000;
export const MAX_COMMENTS_PER_RUN = 500;
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 3;

export type Comment = {
  id: string;
  run_id: string;
  author: string;
  body: string;
  created_at: string;
  ip_hash: string;
};

type Store = { comments: Comment[] };

function sanitize(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

export function normalizeAuthor(input: unknown): string {
  if (typeof input !== "string") return "anon";
  const cleaned = sanitize(input, MAX_AUTHOR_LEN);
  return cleaned || "anon";
}

export function normalizeBody(input: unknown): string {
  if (typeof input !== "string") return "";
  return sanitize(input, MAX_BODY_LEN);
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(`signalclaw|${ip}`).digest("hex").slice(0, 24);
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.comments)) return { comments: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { comments: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export async function listComments(runId: string): Promise<Comment[]> {
  const s = await readStore();
  return s.comments
    .filter((c) => c.run_id === runId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export async function countByIpSince(ipHash: string, sinceMs: number): Promise<number> {
  const s = await readStore();
  const cutoff = Date.now() - sinceMs;
  return s.comments.filter(
    (c) => c.ip_hash === ipHash && new Date(c.created_at).getTime() >= cutoff,
  ).length;
}

export type AddResult =
  | { ok: true; comment: Comment }
  | { ok: false; code: "rate_limited" | "empty_body" | "run_full" };

export async function addComment(input: {
  run_id: string;
  author: unknown;
  body: unknown;
  ip: string;
}): Promise<AddResult> {
  const body = normalizeBody(input.body);
  if (!body) return { ok: false, code: "empty_body" };
  const author = normalizeAuthor(input.author);
  const ip_hash = hashIp(input.ip || "0.0.0.0");

  const s = await readStore();
  // per-run cap
  const forRun = s.comments.filter((c) => c.run_id === input.run_id);
  if (forRun.length >= MAX_COMMENTS_PER_RUN) return { ok: false, code: "run_full" };
  // per-ip window
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const recent = s.comments.filter(
    (c) => c.ip_hash === ip_hash && new Date(c.created_at).getTime() >= cutoff,
  ).length;
  if (recent >= RATE_MAX_PER_WINDOW) return { ok: false, code: "rate_limited" };

  const comment: Comment = {
    id: crypto.randomBytes(8).toString("hex"),
    run_id: input.run_id,
    author,
    body,
    created_at: new Date().toISOString(),
    ip_hash,
  };
  s.comments.push(comment);
  await writeStore(s);
  return { ok: true, comment };
}

export async function deleteComment(runId: string, commentId: string): Promise<boolean> {
  const s = await readStore();
  const before = s.comments.length;
  s.comments = s.comments.filter((c) => !(c.run_id === runId && c.id === commentId));
  if (s.comments.length === before) return false;
  await writeStore(s);
  return true;
}

export function publicView(c: Comment) {
  // Never expose ip_hash to the public.
  const { ip_hash: _ih, ...rest } = c;
  return rest;
}

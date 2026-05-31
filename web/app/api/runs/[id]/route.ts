import { NextRequest, NextResponse } from "next/server";
import { getRun, deleteRun, renameRun, setRunTags, setRunNotes, setRunPinned, MAX_NOTES_LEN } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  return NextResponse.json(run);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteRun(id);
  if (!ok) return err(404, "not_found", "run not found");
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const hasLabel = Object.prototype.hasOwnProperty.call(body ?? {}, "label");
  const hasTags = Object.prototype.hasOwnProperty.call(body ?? {}, "tags");
  const hasNotes = Object.prototype.hasOwnProperty.call(body ?? {}, "notes");
  const hasPinned = Object.prototype.hasOwnProperty.call(body ?? {}, "pinned");

  if (!hasLabel && !hasTags && !hasNotes && !hasPinned) {
    return err(400, "no_fields", "provide label, tags, notes, or pinned");
  }

  let current = await getRun(id);
  if (!current) return err(404, "not_found", "run not found");

  if (hasLabel) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return err(400, "bad_label", "label must be a non-empty string");
    if (label.length > 80) return err(400, "label_too_long", "label exceeds 80 chars");
    current = await renameRun(id, label);
    if (!current) return err(404, "not_found", "run not found");
  }

  if (hasTags) {
    if (!Array.isArray(body.tags)) {
      return err(400, "bad_tags", "tags must be an array of strings");
    }
    current = await setRunTags(id, body.tags);
    if (!current) return err(404, "not_found", "run not found");
  }

  if (hasNotes) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return err(400, "bad_notes", "notes must be a string or null");
    }
    if (typeof body.notes === "string" && body.notes.length > MAX_NOTES_LEN * 2) {
      return err(400, "notes_too_long", `notes exceeds ${MAX_NOTES_LEN} chars`);
    }
    current = await setRunNotes(id, body.notes ?? "");
    if (!current) return err(404, "not_found", "run not found");
  }

  if (hasPinned) {
    if (typeof body.pinned !== "boolean") {
      return err(400, "bad_pinned", "pinned must be a boolean");
    }
    current = await setRunPinned(id, body.pinned);
    if (!current) return err(404, "not_found", "run not found");
  }

  return NextResponse.json({
    id: current.id,
    label: current.label,
    tags: current.tags,
    notes: current.notes ?? "",
    pinned: current.pinned === true,
    pinned_at: current.pinned_at ?? null,
  });
}

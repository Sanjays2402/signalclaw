"use client";
import { useEffect, useState } from "react";
import { ChatCircleDots, PaperPlaneTilt, Trash } from "@phosphor-icons/react/dist/ssr";

type Comment = {
  id: string;
  run_id: string;
  author: string;
  body: string;
  created_at: string;
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toUTCString().slice(0, 16);
}

export default function RunComments({ runId }: { runId: string }) {
  const [items, setItems] = useState<Comment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      setApiKey(localStorage.getItem("sc_api_key"));
      const saved = localStorage.getItem("sc_comment_author");
      if (saved) setAuthor(saved);
    } catch {}
  }, []);

  async function load() {
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${runId}/comments`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || "failed to load");
      setItems(j.comments || []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setItems([]);
    }
  }

  useEffect(() => {
    load();
  }, [runId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${runId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: author.trim(), body: body.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || "failed to post");
      try {
        if (author.trim()) localStorage.setItem("sc_comment_author", author.trim());
      } catch {}
      setBody("");
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  async function del(cid: string) {
    if (!apiKey) return;
    if (!confirm("Delete this comment?")) return;
    try {
      const r = await fetch(`/api/runs/${runId}/comments/${cid}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || "delete failed");
      }
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <ChatCircleDots size={18} weight="duotone" style={{ color: "var(--amber)" }} />
        <div className="text-[12px] font-semibold">Discussion</div>
        <div className="muted text-[10px] mono uppercase tracking-widest">
          {items === null ? "loading" : `${items.length}`}
        </div>
      </div>

      <form onSubmit={submit} className="space-y-2 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value.slice(0, 40))}
            placeholder="display name (optional)"
            className="bg-black/40 border border-[var(--border-strong)] rounded-sm px-2.5 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
          />
          <input
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 1000))}
            placeholder="share a thought on this run"
            className="bg-black/40 border border-[var(--border-strong)] rounded-sm px-2.5 py-1.5 text-[12px] focus:outline-none focus:border-[var(--amber)]"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="muted text-[10px] mono">
            {body.length}/1000 · rate limited per IP
          </span>
          <button
            type="submit"
            disabled={!body.trim() || submitting}
            className="flex items-center gap-1.5 bg-[var(--amber)] text-black font-semibold rounded-sm px-3 py-1.5 text-[11px] uppercase tracking-widest disabled:opacity-40"
          >
            <PaperPlaneTilt size={14} weight="duotone" />
            {submitting ? "posting" : "post"}
          </button>
        </div>
      </form>

      {err && (
        <div className="mb-3 text-[11px] border border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)] rounded-sm px-2.5 py-1.5">
          {err}
        </div>
      )}

      {items === null ? (
        <div className="muted text-[11px]">loading comments...</div>
      ) : items.length === 0 ? (
        <div className="muted text-[11px]">No comments yet. Be the first.</div>
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <li
              key={c.id}
              className="border border-[var(--border)] rounded-sm p-3 bg-black/20"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold mono">{c.author}</span>
                  <span className="muted text-[10px]">{fmtWhen(c.created_at)}</span>
                </div>
                {apiKey && (
                  <button
                    onClick={() => del(c.id)}
                    title="Delete (owner)"
                    className="muted hover:text-[var(--red)]"
                  >
                    <Trash size={14} weight="duotone" />
                  </button>
                )}
              </div>
              <div className="text-[12px] whitespace-pre-wrap break-words">{c.body}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

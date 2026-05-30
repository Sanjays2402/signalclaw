"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Field, fmtPct } from "@/components/ui";
import {
  api,
  swrFetcher,
  type NewsEventList,
  type NewsEventIn,
  type EventStudy,
} from "@/lib/api";
import { Newspaper, Trash, Plus, ChartLine, ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export default function NewsPage() {
  return (
    <AuthGate>
      <News />
    </AuthGate>
  );
}

function News() {
  const [ticker, setTicker] = useState("");
  const [tag, setTag] = useState("");
  const qs = new URLSearchParams();
  if (ticker.trim()) qs.set("ticker", ticker.trim().toUpperCase());
  if (tag.trim()) qs.set("tag", tag.trim());
  const key = `/news-events${qs.toString() ? "?" + qs.toString() : ""}`;
  const { data, error, isLoading } = useSWR<NewsEventList>(key, swrFetcher);

  const studyKey = `/news-events/study?horizons=1,5,20${tag.trim() ? `&tag=${encodeURIComponent(tag.trim())}` : ""}`;
  const study = useSWR<EventStudy>(studyKey, swrFetcher);

  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function create(body: NewsEventIn) {
    setFormErr(null);
    setBusy("create");
    try {
      await api("/news-events", { method: "POST", body: JSON.stringify(body) });
      await mutate(key);
      await mutate(studyKey);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api(`/news-events/${encodeURIComponent(id)}`, { method: "DELETE" });
      await mutate(key);
      await mutate(studyKey);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Newspaper weight="duotone" size={22} className="text-[var(--accent)]" />
            News & events
          </h1>
          <p className="muted text-xs">Catalysts and event study across registered horizons.</p>
        </div>
        <div className="flex gap-2 items-end">
          <Field label="Ticker filter">
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="all"
              className="w-32"
            />
          </Field>
          <Field label="Tag filter">
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="all"
              className="w-32"
            />
          </Field>
        </div>
      </header>

      <Card title="Log an event">
        <CreateForm onSubmit={create} busy={busy === "create"} />
        {formErr && <div className="mt-3 text-xs down">{formErr}</div>}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-3">
          {isLoading && <Loading label="Loading events" />}
          {error && <ErrorBox err={error} />}
          {data && data.events.length === 0 && (
            <Empty title="No events" hint="Add one above or clear filters." />
          )}
          {data && data.events.length > 0 && (
            <Card title={`${data.events.length} events`}>
              <ul className="divide-y divide-[var(--border)]">
                {data.events
                  .slice()
                  .sort((a, b) => b.event_date.localeCompare(a.event_date))
                  .map((e) => (
                    <li key={e.id} className="py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            href={`/ticker/${e.ticker}`}
                            className="font-medium hover:text-[var(--accent)]"
                          >
                            {e.ticker}
                          </Link>
                          <span className="muted text-xs num">{e.event_date}</span>
                          {e.tags.map((t) => (
                            <Badge key={t} tone="info">
                              {t}
                            </Badge>
                          ))}
                        </div>
                        <div className="text-sm mt-1 break-words">{e.headline}</div>
                        <div className="muted text-xs mt-1 flex items-center gap-2">
                          {e.source && <span>source: {e.source}</span>}
                          {e.url && (
                            <a
                              href={e.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 hover:text-[var(--accent)]"
                            >
                              link <ArrowSquareOut weight="duotone" size={12} />
                            </a>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="danger"
                        disabled={busy === e.id}
                        onClick={() => remove(e.id)}
                      >
                        <Trash weight="duotone" size={14} />
                      </Button>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-3">
          <Card
            title="Event study"
            right={
              <span className="muted text-xs inline-flex items-center gap-1">
                <ChartLine weight="duotone" size={14} /> 1, 5, 20d
              </span>
            }
          >
            {study.isLoading && <div className="muted text-xs">Loading</div>}
            {study.error && (
              <div className="text-xs down">Study unavailable. Need price history for tickers.</div>
            )}
            {study.data && <StudyView s={study.data} />}
          </Card>
        </div>
      </div>
    </div>
  );
}

function StudyView({ s }: { s: EventStudy }) {
  if (!s.n_events) {
    return <div className="muted text-xs">No events match the current filter.</div>;
  }
  const horizons = s.horizons;
  return (
    <div className="space-y-4">
      <div className="text-xs muted">n_events: {s.n_events}</div>
      <table className="w-full text-xs">
        <thead className="text-left muted uppercase tracking-wide">
          <tr>
            <th className="py-1 pr-2">Horizon</th>
            <th className="py-1 pr-2">Hit rate</th>
            <th className="py-1 pr-2">Mean</th>
            <th className="py-1 pr-2">Median</th>
            <th className="py-1 pr-2">N</th>
          </tr>
        </thead>
        <tbody>
          {horizons.map((h) => {
            const k = `h${h}`;
            const st = s.overall[k];
            if (!st) return null;
            return (
              <tr key={h} className="border-t border-[var(--border)]">
                <td className="py-1 pr-2 num">{h}d</td>
                <td className={`py-1 pr-2 num ${st.hit_rate >= 0.5 ? "up" : "down"}`}>
                  {fmtPct(st.hit_rate)}
                </td>
                <td className={`py-1 pr-2 num ${st.mean >= 0 ? "up" : "down"}`}>
                  {fmtPct(st.mean)}
                </td>
                <td className={`py-1 pr-2 num ${st.median >= 0 ? "up" : "down"}`}>
                  {fmtPct(st.median)}
                </td>
                <td className="py-1 pr-2 num muted">{st.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.keys(s.by_tag).length > 0 && (
        <div>
          <div className="muted text-xs mb-1 uppercase tracking-wide">By tag</div>
          <ul className="space-y-1">
            {Object.entries(s.by_tag).map(([tg, hs]) => {
              const first = hs[`h${horizons[0]}`];
              return (
                <li key={tg} className="flex items-center justify-between text-xs">
                  <Badge tone="info">{tg}</Badge>
                  <span className="muted">
                    n={first?.n ?? 0} hit={fmtPct(first?.hit_rate ?? 0)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  onSubmit,
  busy,
}: {
  onSubmit: (body: NewsEventIn) => Promise<void>;
  busy: boolean;
}) {
  const [t, setT] = useState("");
  const [h, setH] = useState("");
  const [d, setD] = useState("");
  const [tags, setTags] = useState("");
  const [src, setSrc] = useState("");
  const [url, setUrl] = useState("");

  return (
    <form
      className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!t.trim() || !h.trim() || !d.trim()) return;
        await onSubmit({
          ticker: t.trim().toUpperCase(),
          headline: h.trim(),
          event_date: d,
          tags: tags
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          source: src.trim(),
          url: url.trim(),
        });
        setT("");
        setH("");
        setD("");
        setTags("");
        setSrc("");
        setUrl("");
      }}
    >
      <Field label="Ticker">
        <Input required value={t} onChange={(e) => setT(e.target.value.toUpperCase())} placeholder="AAPL" />
      </Field>
      <Field label="Date">
        <Input required type="date" value={d} onChange={(e) => setD(e.target.value)} />
      </Field>
      <div className="md:col-span-2">
        <Field label="Headline">
          <Input required value={h} onChange={(e) => setH(e.target.value)} />
        </Field>
      </div>
      <Field label="Tags (comma)">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="guidance,8k" />
      </Field>
      <Field label="Source">
        <Input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="PR, 8-K" />
      </Field>
      <div className="md:col-span-5">
        <Field label="URL (optional)">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        <span className="inline-flex items-center gap-1">
          <Plus weight="duotone" size={14} /> Log event
        </span>
      </Button>
    </form>
  );
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api";
import { Card, Button, Input, Loading, ErrorBox, Empty } from "@/components/ui";
import { ArrowRight, Trash } from "@phosphor-icons/react/dist/ssr";

export default function Page() { return <AuthGate><WL /></AuthGate>; }

function WL() {
  const [tickers, setTickers] = useState<string[] | null>(null);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(null);
    try {
      const d = await api<{ tickers: string[] }>("/watchlist");
      setTickers(d.tickers);
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!val.trim()) return;
    setBusy(true);
    try {
      await api("/watchlist", { method: "POST", body: JSON.stringify({ ticker: val.toUpperCase() }) });
      setVal("");
      await load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const remove = async (t: string) => {
    try {
      await api(`/watchlist/${t}`, { method: "DELETE" });
      await load();
    } catch (e) { setErr(e); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <p className="muted text-xs">Tickers tracked by the daily pipeline. Click any symbol for detail.</p>
      </div>

      <Card>
        <form onSubmit={add} className="flex gap-2">
          <Input value={val} onChange={(e) => setVal(e.target.value.toUpperCase())}
                 placeholder="AAPL" className="mono flex-1" />
          <Button type="submit" disabled={busy || !val.trim()}>{busy ? "Adding" : "Add"}</Button>
        </form>
      </Card>

      {err ? <ErrorBox err={err} /> :
        tickers == null ? <Loading label="Loading watchlist" /> :
          tickers.length === 0 ? (
            <Empty title="No tickers yet" hint="Add a symbol above to seed the daily pipeline." />
          ) : (
            <ul className="panel divide-y divide-[var(--border)]">
              {tickers.map((t) => (
                <li key={t} className="flex justify-between items-center px-4 py-2 hover:bg-white/[0.02]">
                  <Link href={`/ticker/${t}`} className="mono inline-flex items-center gap-2 hover:text-[var(--accent)]">
                    {t} <ArrowRight weight="duotone" size={12} className="opacity-60" />
                  </Link>
                  <button onClick={() => remove(t)} className="text-xs muted hover:text-[var(--red)] inline-flex items-center gap-1">
                    <Trash weight="duotone" size={12} /> remove
                  </button>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

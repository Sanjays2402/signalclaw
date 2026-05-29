"use client";
import { useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api";

export default function Page() { return <AuthGate><WL /></AuthGate>; }

function WL() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [val, setVal] = useState("");
  const load = () => api<{tickers:string[]}>("/watchlist").then(d => setTickers(d.tickers));
  useEffect(() => { load(); }, []);
  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-xl mb-4">Watchlist</h1>
      <div className="flex gap-2 mb-4">
        <input value={val} onChange={e=>setVal(e.target.value.toUpperCase())}
          placeholder="TSLA" className="flex-1 bg-black/40 border border-[var(--border)] rounded px-3 py-2 mono" />
        <button onClick={async()=>{await api("/watchlist",{method:"POST",body:JSON.stringify({ticker:val})}); setVal(""); load();}}
          className="px-4 py-2 bg-[var(--accent)] text-black rounded">Add</button>
      </div>
      <ul className="panel divide-y divide-[var(--border)]">
        {tickers.map(t => (
          <li key={t} className="flex justify-between items-center px-4 py-2">
            <span className="mono">{t}</span>
            <button onClick={async()=>{await api(`/watchlist/${t}`,{method:"DELETE"}); load();}}
              className="text-xs down">remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

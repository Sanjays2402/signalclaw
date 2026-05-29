"use client";
import { useState } from "react";
import AuthGate from "@/components/AuthGate";
import EquityChart from "@/components/EquityChart";
import { api, type Backtest } from "@/lib/api";

export default function Page() { return <AuthGate><BT /></AuthGate>; }

function BT() {
  const [t, setT] = useState("SPY");
  const [bt, setBt] = useState<Backtest | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl mb-4">Backtest</h1>
      <div className="flex gap-2 mb-4">
        <input value={t} onChange={e=>setT(e.target.value.toUpperCase())}
          className="bg-black/40 border border-[var(--border)] rounded px-3 py-2 mono" />
        <button disabled={loading} onClick={async()=>{setLoading(true); try{setBt(await api(`/backtest/${t}`));}finally{setLoading(false);}}}
          className="px-4 py-2 bg-[var(--accent)] text-black rounded">{loading?"...":"Run"}</button>
      </div>
      {bt && (
        <>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
            {[["Sharpe", bt.sharpe.toFixed(2)],
              ["Sortino", bt.sortino.toFixed(2)],
              ["Max DD", `${(bt.max_drawdown*100).toFixed(1)}%`],
              ["Hit", `${(bt.hit_rate*100).toFixed(1)}%`],
              ["CAGR", `${(bt.cagr*100).toFixed(1)}%`],
              ["Trades", String(bt.n_trades)]].map(([k,v])=>(
              <div key={k} className="panel p-3">
                <div className="muted text-xs">{k}</div>
                <div className="num text-lg">{v}</div>
              </div>
            ))}
          </div>
          <div className="panel p-3"><EquityChart dates={bt.dates} values={bt.equity_curve} /></div>
        </>
      )}
    </div>
  );
}

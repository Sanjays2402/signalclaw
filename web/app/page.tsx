"use client";
import { useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import Sparkline from "@/components/Sparkline";
import { api, type Report } from "@/lib/api";

function Disclaimer() {
  return (
    <div className="panel p-3 mb-4 text-xs">
      <strong className="text-[var(--amber)]">NOT FINANCIAL ADVICE.</strong>
      &nbsp;SignalClaw is a personal research tool. Outputs may be wrong.
    </div>
  );
}

export default function Page() { return <AuthGate><Today /></AuthGate>; }

function Today() {
  const [r, setR] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Report>("/picks").then(setR).catch(e => setErr(String(e))).finally(() => setLoading(false));
  }, []);
  return (
    <div className="max-w-5xl mx-auto">
      <Disclaimer />
      <h1 className="text-xl mb-4">Today {r ? <span className="muted text-sm">{r.as_of}</span> : null}</h1>
      {loading && <p className="muted">Loading...</p>}
      {err && <pre className="text-[var(--red)] text-xs">{err}</pre>}
      {r && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left muted border-b border-[var(--border)]">
              <th className="py-2">Ticker</th><th>Label</th>
              <th className="text-right">Score</th>
              <th className="text-right">E[5d]</th>
              <th>Spark</th><th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {r.picks.map(p => (
              <tr key={p.ticker} className="border-b border-[var(--border)]">
                <td className="py-2 mono">{p.ticker}</td>
                <td className={p.label === "watch" ? "up" : p.label === "skip" ? "down" : ""}>
                  <span className="uppercase text-xs">{p.label}</span>
                </td>
                <td className="num text-right">{p.score.toFixed(2)}</td>
                <td className={`num text-right ${p.expected_return >= 0 ? "up" : "down"}`}>
                  {(p.expected_return * 100).toFixed(2)}%
                </td>
                <td><Sparkline data={Array.from({length:24},(_,i)=>Math.sin(i/3+p.score))}
                  color={p.label==="watch"?"#00d68f":p.label==="skip"?"#ff4d6d":"#8a8a93"} /></td>
                <td className="muted text-xs">{p.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

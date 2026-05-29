"use client";
import { useEffect, useState } from "react";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState(false);
  const [val, setVal] = useState("");
  useEffect(() => {
    const k = localStorage.getItem("sc_api_key");
    if (k) setOk(true);
  }, []);
  if (ok) return <>{children}</>;
  return (
    <div className="max-w-sm mx-auto mt-20 panel p-6">
      <h2 className="text-lg font-semibold mb-3">Sign in</h2>
      <p className="muted text-sm mb-4">Enter SIGNALCLAW_API_KEY from your backend .env</p>
      <input value={val} onChange={e=>setVal(e.target.value)} type="password" placeholder="api key"
        className="w-full bg-black/40 border border-[var(--border)] rounded px-3 py-2 mb-3" />
      <button onClick={()=>{localStorage.setItem("sc_api_key", val); setOk(true);}}
        className="w-full bg-[var(--accent)] text-black font-medium rounded py-2">Unlock</button>
    </div>
  );
}

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
    <div className="max-w-sm mx-auto mt-20 panel p-5">
      <div className="muted text-[10px] uppercase tracking-widest mb-3">Sign in</div>
      <h2 className="text-base font-semibold mb-3 mono">
        SIGNAL<span style={{ color: "var(--amber)" }}>CLAW</span> terminal
      </h2>
      <p className="muted text-[11px] mb-4">
        Paste SIGNALCLAW_API_KEY from backend .env.
      </p>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        type="password"
        placeholder="api key"
        className="w-full bg-black/40 border border-[var(--border-strong)] rounded-sm px-2.5 py-1.5 mb-3 text-[12px] mono focus:outline-none focus:border-[var(--amber)]"
      />
      <button
        onClick={() => {
          localStorage.setItem("sc_api_key", val);
          setOk(true);
        }}
        className="w-full bg-[var(--amber)] text-black font-semibold rounded-sm py-2 text-[11px] uppercase tracking-widest"
      >
        Unlock
      </button>
    </div>
  );
}

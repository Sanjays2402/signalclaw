"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { Card, Button, Input, Field } from "@/components/ui";
import { Crosshair } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <Index />
    </AuthGate>
  );
}

function Index() {
  const router = useRouter();
  const [symbol, setSymbol] = useState("SPY");

  function go(e: React.FormEvent) {
    e.preventDefault();
    const s = symbol.trim().toUpperCase();
    if (s) router.push(`/optimize/${s}`);
  }

  const presets = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "BTC-USD"];

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Walk-forward optimizer</h1>
        <p className="muted text-xs">Out-of-sample parameter search with rolling train and test windows.</p>
      </header>

      <Card title="Pick a ticker">
        <form onSubmit={go} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Symbol">
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="e.g. SPY"
                autoFocus
              />
            </Field>
          </div>
          <Button type="submit" className="inline-flex items-center gap-1.5">
            <Crosshair weight="duotone" size={14} /> Optimize
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => router.push(`/optimize/${p}`)}
              className="mono text-xs px-2 py-1 rounded border border-[var(--border)] hover:bg-white/5"
            >
              {p}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

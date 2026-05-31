"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Button, Input, Loading, ErrorBox } from "@/components/ui";
import {
  CheckCircle,
  Circle,
  Key,
  ChartLine,
  FloppyDisk,
  ArrowRight,
  Sparkle,
} from "@phosphor-icons/react/dist/ssr";

const STORAGE_KEY = "sc_onboarded_v1";

type Step = 0 | 1 | 2 | 3;

export default function WelcomePage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [apiKey, setApiKey] = useState("");
  const [ticker, setTicker] = useState("ACME");
  const [seedId, setSeedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  // Hydrate state from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("sc_api_key");
      if (stored) {
        setApiKey(stored);
        setStep((s) => (s < 1 ? 1 : s));
      }
      const done = localStorage.getItem(STORAGE_KEY);
      if (done === "1") setStep(3);
    } catch {
      /* localStorage unavailable, ignore */
    }
  }, []);

  const steps = useMemo(
    () => [
      { n: 1, title: "Unlock the terminal", icon: Key },
      { n: 2, title: "Run your first classification", icon: ChartLine },
      { n: 3, title: "Save and share the result", icon: FloppyDisk },
    ],
    [],
  );

  function unlock() {
    const v = apiKey.trim();
    if (!v) {
      setErr(new Error("Paste a key from your backend .env (SIGNALCLAW_API_KEY)."));
      return;
    }
    setErr(null);
    try {
      localStorage.setItem("sc_api_key", v);
    } catch {
      /* ignore */
    }
    setStep(1);
  }

  async function runSample() {
    setBusy(true);
    setErr(null);
    try {
      const t = (ticker || "ACME").trim().toUpperCase().slice(0, 8) || "ACME";
      const res = await fetch("/api/welcome/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: t }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `seed failed (${res.status})`);
      }
      const data = (await res.json()) as { id: string };
      setSeedId(data.id);
      setStep(2);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setStep(3);
  }

  function restart() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setSeedId(null);
    setStep(apiKey ? 1 : 0);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header className="panel p-5 md:p-6">
        <div className="flex items-center gap-2 muted text-[10px] uppercase tracking-widest mb-2">
          <Sparkle weight="duotone" size={14} />
          Welcome
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-1">
          Get to your first regime call in 90 seconds.
        </h1>
        <p className="muted text-[12px] max-w-xl">
          Three small steps. Unlock the terminal, run a real classification on a
          seeded sample, then save it so you can find it again. You can replay
          this guide any time from Settings.
        </p>
      </header>

      <ol className="grid gap-2 md:grid-cols-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const done = step > i;
          const active = step === i;
          return (
            <li
              key={s.n}
              aria-current={active ? "step" : undefined}
              className={`panel p-3 flex items-start gap-2 text-[12px] ${
                active ? "border-[var(--amber)]" : ""
              }`}
            >
              {done ? (
                <CheckCircle
                  weight="duotone"
                  size={18}
                  style={{ color: "var(--green, #4ade80)" }}
                />
              ) : (
                <Circle weight="duotone" size={18} className="muted" />
              )}
              <div className="space-y-0.5">
                <div className="mono text-[10px] muted uppercase tracking-widest">
                  Step {s.n}
                </div>
                <div className="flex items-center gap-1.5">
                  <Icon weight="duotone" size={14} />
                  <span className={active ? "text-white" : ""}>{s.title}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {step === 0 && (
        <Card title="Step 1 of 3 · Unlock the terminal">
          <p className="muted text-[12px] mb-3">
            SignalClaw uses a single shared API key for the local terminal. Copy
            the value of <span className="mono">SIGNALCLAW_API_KEY</span> from
            your backend <span className="mono">.env</span> and paste it below.
            We store it in your browser only.
          </p>
          <label className="block text-[10px] muted uppercase tracking-widest mb-1">
            API key
          </label>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="paste SIGNALCLAW_API_KEY"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") unlock();
            }}
          />
          {err ? <div className="mt-2"><ErrorBox err={err} /></div> : null}
          <div className="flex justify-end mt-3">
            <Button onClick={unlock}>
              Unlock <ArrowRight weight="duotone" size={12} className="inline" />
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="Step 2 of 3 · Run your first classification">
          <p className="muted text-[12px] mb-3">
            We will generate a 120 bar synthetic series for the ticker you pick
            and run regime classification end to end. No external data calls,
            so this works offline.
          </p>
          <label className="block text-[10px] muted uppercase tracking-widest mb-1">
            Ticker
          </label>
          <Input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase().slice(0, 8))}
            placeholder="ACME"
          />
          {err ? <div className="mt-2"><ErrorBox err={err} /></div> : null}
          <div className="flex items-center justify-between mt-3">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={runSample} disabled={busy}>
              {busy ? "Running" : "Run sample"}{" "}
              <ArrowRight weight="duotone" size={12} className="inline" />
            </Button>
          </div>
          {busy ? (
            <div className="mt-3">
              <Loading label="Classifying" />
            </div>
          ) : null}
        </Card>
      )}

      {step === 2 && (
        <Card title="Step 3 of 3 · Saved to your history">
          <p className="muted text-[12px] mb-3">
            Done. Your run is in the local store, tagged{" "}
            <span className="mono">#onboarding</span> and{" "}
            <span className="mono">#sample</span>. Open it to see the chart,
            copy the share link, or jump straight to history.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {seedId ? (
              <>
                <Button onClick={() => router.push(`/r/${seedId}`)}>
                  View shared run
                </Button>
                <Link
                  href="/history"
                  className="text-[11px] mono uppercase tracking-widest muted hover:text-white"
                >
                  Open history
                </Link>
              </>
            ) : null}
            <div className="ml-auto">
              <Button onClick={finish}>Finish onboarding</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title="Onboarding complete">
          <p className="muted text-[12px] mb-3">
            Nice work. Try the live demo, build a watchlist, or wire up a
            webhook. The seeded run stays in history with the{" "}
            <span className="mono">#onboarding</span> tag until you delete it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/demo"
              className="text-[11px] mono uppercase tracking-widest border border-[var(--border-strong)] rounded-sm px-2.5 py-1 hover:bg-white/[0.04]"
            >
              Live demo
            </Link>
            <Link
              href="/history"
              className="text-[11px] mono uppercase tracking-widest border border-[var(--border-strong)] rounded-sm px-2.5 py-1 hover:bg-white/[0.04]"
            >
              History
            </Link>
            <Link
              href="/watchlist"
              className="text-[11px] mono uppercase tracking-widest border border-[var(--border-strong)] rounded-sm px-2.5 py-1 hover:bg-white/[0.04]"
            >
              Watchlist
            </Link>
            <Link
              href="/webhooks"
              className="text-[11px] mono uppercase tracking-widest border border-[var(--border-strong)] rounded-sm px-2.5 py-1 hover:bg-white/[0.04]"
            >
              Webhooks
            </Link>
            <button
              onClick={restart}
              className="ml-auto text-[11px] mono uppercase tracking-widest muted hover:text-white"
            >
              Replay guide
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

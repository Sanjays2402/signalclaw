"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";
import AuthGate from "@/components/AuthGate";
import { Card, Button, Input, Field } from "@/components/ui";
import { Vault, ArrowRight } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export default function LedgerIndex() {
  return (
    <AuthGate>
      <Pick />
    </AuthGate>
  );
}

const SUGGESTED = ["main", "ira", "paper"];

function Pick() {
  const router = useRouter();
  const sp = useSearchParams();
  const [acct, setAcct] = useState(sp.get("account") || "main");

  useEffect(() => {
    const a = sp.get("account");
    if (a) setAcct(a);
  }, [sp]);

  function go(e: React.FormEvent) {
    e.preventDefault();
    const a = acct.trim();
    if (!a) return;
    router.push(`/ledger/${encodeURIComponent(a)}`);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Vault weight="duotone" />
          Ledger
        </h1>
        <p className="muted text-xs">Pick an account to view entries, snapshot, and margin state.</p>
      </header>

      <Card title="Open account">
        <form onSubmit={go} className="flex items-end gap-3">
          <Field label="Account name">
            <Input value={acct} onChange={(e) => setAcct(e.target.value)} placeholder="main" required />
          </Field>
          <Button type="submit">
            Open
            <ArrowRight weight="duotone" className="inline ml-1" />
          </Button>
        </form>
      </Card>

      <Card title="Common accounts">
        <div className="flex flex-wrap gap-2">
          {SUGGESTED.map((a) => (
            <Link key={a} href={`/ledger/${a}`}
              className="panel px-3 py-2 text-sm hover:border-[var(--accent)]">
              <span className="mono">{a}</span>
            </Link>
          ))}
        </div>
        <p className="muted text-xs mt-3">Accounts are created on first append. Names are free-form.</p>
      </Card>
    </div>
  );
}

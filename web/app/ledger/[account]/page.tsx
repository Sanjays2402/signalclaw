"use client";
import { use, useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd } from "@/components/ui";
import { api, swrFetcher, type LedgerList, type LedgerEntry, type AccountSnapshot } from "@/lib/api";
import { Vault, Plus, ArrowLeft, ShieldWarning } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

const KINDS = ["deposit", "withdraw", "buy", "sell", "dividend", "interest", "fee"];

function kindTone(k: string): "up" | "down" | "warn" | "neutral" {
  if (k === "deposit" || k === "dividend") return "up";
  if (k === "withdraw" || k === "fee") return "down";
  if (k === "buy" || k === "sell") return "neutral";
  if (k === "interest") return "warn";
  return "neutral";
}

export default function AccountPage({ params }: { params: Promise<{ account: string }> }) {
  const { account } = use(params);
  return (
    <AuthGate>
      <AccountView account={decodeURIComponent(account)} />
    </AuthGate>
  );
}

function AccountView({ account }: { account: string }) {
  const listKey = `/ledger/${encodeURIComponent(account)}`;
  const snapKey = `/ledger/${encodeURIComponent(account)}/snapshot`;

  const list = useSWR<LedgerList>(listKey, swrFetcher);
  const snap = useSWR<AccountSnapshot>(snapKey, swrFetcher, { refreshInterval: 30000 });

  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function onCreate(entry: LedgerEntry) {
    setFormErr(null);
    setBusy(true);
    try {
      await api(listKey, { method: "POST", body: JSON.stringify(entry) });
      await Promise.all([mutate(listKey), mutate(snapKey)]);
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Vault weight="duotone" />
            Account <span className="mono text-[var(--accent)]">{account}</span>
          </h1>
          <p className="muted text-xs">Cash, position, and margin state for this ledger.</p>
        </div>
        <Link href="/ledger" className="text-xs muted hover:text-white inline-flex items-center gap-1">
          <ArrowLeft weight="duotone" /> All accounts
        </Link>
      </header>

      <SnapshotCard data={snap.data} error={snap.error} loading={snap.isLoading} />

      <NewEntryForm onSubmit={onCreate} busy={busy} err={formErr} />

      <Card title="Entries">
        {list.error ? <ErrorBox err={list.error} /> :
          list.isLoading || !list.data ? <Loading /> :
            list.data.entries.length === 0 ? (
              <Empty title="No entries yet" hint="Add a deposit above to seed this account." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                      <th className="py-2 pr-3">When</th>
                      <th className="pr-3">Kind</th>
                      <th className="text-right pr-3">Amount</th>
                      <th className="pr-3">Ticker</th>
                      <th className="text-right pr-3">Shares</th>
                      <th className="text-right pr-3">Price</th>
                      <th className="pr-3">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...list.data.entries].reverse().map((e, i) => (
                      <tr key={i} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                        <td className="py-2 pr-3 text-xs muted">{e.ts}</td>
                        <td className="pr-3"><Badge tone={kindTone(e.kind)}>{e.kind}</Badge></td>
                        <td className={"num text-right pr-3 " + (e.amount >= 0 ? "up" : "down")}>{fmtUsd(e.amount)}</td>
                        <td className="pr-3 mono">{e.ticker || ""}</td>
                        <td className="num text-right pr-3">{e.shares || ""}</td>
                        <td className="num text-right pr-3">{e.price ? fmtUsd(e.price) : ""}</td>
                        <td className="pr-3 text-xs muted">{e.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>
    </div>
  );
}

function SnapshotCard({
  data, error, loading,
}: { data?: AccountSnapshot; error: unknown; loading: boolean }) {
  return (
    <Card title="Snapshot" right={data?.margin_call ? <Badge tone="down">margin call</Badge> : null}>
      {error ? <ErrorBox err={error} /> :
        loading || !data ? <Loading /> : (
          <>
            {data.margin_call && (
              <div className="panel p-3 mb-3 border-[var(--red)]/40 text-xs flex items-start gap-2">
                <ShieldWarning weight="duotone" className="text-[var(--red)] shrink-0 mt-0.5" />
                <span>Margin call: deposit {fmtUsd(data.margin_call_amount)} to restore maintenance.</span>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Cash" value={fmtUsd(data.cash)} />
              <Metric label="Equity" value={fmtUsd(data.equity)} />
              <Metric label="Long MV" value={fmtUsd(data.long_market_value)} />
              <Metric label="Short MV" value={fmtUsd(data.short_market_value)} />
              <Metric label="Buying power" value={fmtUsd(data.buying_power)} />
              <Metric label="Excess liquidity" value={fmtUsd(data.excess_liquidity)} />
              <Metric label="Margin used" value={fmtUsd(data.margin_used)} />
              <Metric label="Maint. requirement" value={fmtUsd(data.maintenance_requirement)} />
            </div>
          </>
        )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="panel p-3">
      <div className="muted text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-lg num">{value}</div>
    </div>
  );
}

function NewEntryForm({
  onSubmit, busy, err,
}: {
  onSubmit: (e: LedgerEntry) => void;
  busy: boolean;
  err: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [ts, setTs] = useState(today);
  const [kind, setKind] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (Number.isNaN(amt)) return;
    onSubmit({
      ts,
      kind,
      amount: amt,
      ticker: ticker.trim() ? ticker.toUpperCase().trim() : null,
      shares: parseInt(shares || "0", 10) || 0,
      price: parseFloat(price || "0") || 0,
      note: note.trim(),
    });
    setAmount(""); setShares(""); setPrice(""); setNote("");
  }

  const needsTicker = kind === "buy" || kind === "sell" || kind === "dividend";

  return (
    <Card title="New entry">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end">
        <Field label="Date">
          <Input type="date" value={ts} onChange={(e) => setTs(e.target.value)} required />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </Field>
        <Field label="Amount ($, signed)">
          <Input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)}
            placeholder={needsTicker ? "AAPL" : "optional"} required={needsTicker} />
        </Field>
        <Field label="Shares (signed)">
          <Input type="number" step="1" value={shares} onChange={(e) => setShares(e.target.value)} />
        </Field>
        <Field label="Price">
          <Input type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="duotone" className="inline mr-1" />
          {busy ? "Saving" : "Append"}
        </Button>
        <div className="md:col-span-7">
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
          </Field>
        </div>
        {err && <div className="md:col-span-7 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}

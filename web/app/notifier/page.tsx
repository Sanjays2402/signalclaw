"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field } from "@/components/ui";
import { api, swrFetcher, type DeadLetterList, type DlqReplay } from "@/lib/api";
import { Envelope, ArrowsClockwise, Trash, PaperPlaneTilt } from "@phosphor-icons/react/dist/ssr";

export default function DlqPage() {
  return (
    <AuthGate>
      <Dlq />
    </AuthGate>
  );
}

function Dlq() {
  const { data, error, isLoading } = useSWR<DeadLetterList>("/notifier/dlq", swrFetcher, { refreshInterval: 30000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [lastReplay, setLastReplay] = useState<DlqReplay | null>(null);
  const [testChannel, setTestChannel] = useState("telegram");
  const [testText, setTestText] = useState("");
  const [testErr, setTestErr] = useState<string | null>(null);

  async function onDelete(id: string) {
    if (!confirm("Delete this dead letter?")) return;
    setBusy(id);
    try {
      await api(`/notifier/dlq/${id}`, { method: "DELETE" });
      await mutate("/notifier/dlq");
    } finally {
      setBusy(null);
    }
  }

  async function onReplay() {
    setBusy("replay");
    try {
      const r = await api<DlqReplay>("/notifier/dlq/replay", { method: "POST", body: "{}" });
      setLastReplay(r);
      await mutate("/notifier/dlq");
    } catch (e: any) {
      alert(`Replay failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  async function onTest(e: React.FormEvent) {
    e.preventDefault();
    setTestErr(null);
    setBusy("test");
    try {
      await api("/notifier/test", {
        method: "POST",
        body: JSON.stringify({ channel: testChannel, text: testText || "SignalClaw test" }),
      });
      setTestText("");
    } catch (e: any) {
      setTestErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Envelope weight="duotone" />
            Notifier
          </h1>
          <p className="muted text-xs">Dead letter queue for failed deliveries, plus a test sender.</p>
        </div>
        <Button variant="ghost" onClick={onReplay} disabled={busy === "replay"}>
          <ArrowsClockwise weight="duotone" className="inline mr-1" />
          {busy === "replay" ? "Replaying" : "Replay all"}
        </Button>
      </header>

      {lastReplay && (
        <Card title="Last replay">
          <div className="flex gap-4 text-sm">
            <span><Badge tone="up">{lastReplay.sent} sent</Badge></span>
            <span><Badge tone="warn">{lastReplay.kept} kept</Badge></span>
            <span><Badge>{lastReplay.skipped} skipped</Badge></span>
          </div>
        </Card>
      )}

      <Card title="Send test">
        <form onSubmit={onTest} className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <Field label="Channel">
            <Select value={testChannel} onChange={(e) => setTestChannel(e.target.value)}>
              <option value="telegram">telegram</option>
              <option value="email">email</option>
              <option value="webhook">webhook</option>
              <option value="console">console</option>
            </Select>
          </Field>
          <div className="md:col-span-3">
            <Field label="Message">
              <Input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="SignalClaw test" />
            </Field>
          </div>
          <Button type="submit" disabled={busy === "test"}>
            <PaperPlaneTilt weight="duotone" className="inline mr-1" />
            {busy === "test" ? "Sending" : "Send"}
          </Button>
          {testErr && <div className="md:col-span-5 text-xs down">{testErr}</div>}
        </form>
      </Card>

      <Card title="Dead letters">
        {error ? <ErrorBox err={error} /> :
          isLoading || !data ? <Loading /> :
            data.items.length === 0 ? (
              <Empty title="Queue empty" hint="All recent deliveries succeeded." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                      <th className="py-2 pr-3">Channel</th>
                      <th className="pr-3">Enqueued</th>
                      <th className="text-right pr-3">Attempts</th>
                      <th className="pr-3">Last error</th>
                      <th className="pr-3">Text</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((d) => (
                      <tr key={d.id} className="border-b border-[var(--border)] hover:bg-white/[0.02] align-top">
                        <td className="py-2 pr-3"><Badge>{d.channel}</Badge></td>
                        <td className="pr-3 text-xs muted">{d.enqueued_at}</td>
                        <td className="num text-right pr-3">{d.attempts}</td>
                        <td className="pr-3 text-xs down max-w-[200px] truncate" title={d.last_error}>{d.last_error || ""}</td>
                        <td className="pr-3 text-xs max-w-[280px] truncate" title={d.text}>{d.text}</td>
                        <td>
                          <Button variant="danger" className="text-xs"
                            onClick={() => onDelete(d.id)} disabled={busy === d.id}>
                            <Trash weight="duotone" className="inline" />
                          </Button>
                        </td>
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

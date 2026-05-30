"use client";
import { use } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, fmtPct } from "@/components/ui";
import { swrFetcher, type DailyReport, type ReportDiff, type Pick } from "@/lib/api";
import {
  ArrowLeft,
  TrendUp,
  Eye,
  Prohibit,
  PlusCircle,
  MinusCircle,
  ArrowUp,
  ArrowDown,
} from "@phosphor-icons/react/dist/ssr";

function labelTone(label: string): "up" | "info" | "down" {
  if (label === "watch") return "up";
  if (label === "skip") return "down";
  return "info";
}

function LabelIcon({ label }: { label: string }) {
  if (label === "watch") return <TrendUp weight="duotone" size={14} />;
  if (label === "skip") return <Prohibit weight="duotone" size={14} />;
  return <Eye weight="duotone" size={14} />;
}

export default function Page({ params }: { params: Promise<{ as_of: string }> }) {
  const { as_of } = use(params);
  return (
    <AuthGate>
      <ReportDetail asOf={as_of} />
    </AuthGate>
  );
}

function ReportDetail({ asOf }: { asOf: string }) {
  const rep = useSWR<DailyReport>(`/reports/${encodeURIComponent(asOf)}`, swrFetcher);
  const diff = useSWR<ReportDiff>(`/reports/diff/${encodeURIComponent(asOf)}`, swrFetcher);

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/reports"
          className="muted text-xs hover:text-white inline-flex items-center gap-1"
        >
          <ArrowLeft weight="duotone" size={14} /> All reports
        </Link>
        <span className="muted text-xs">/</span>
        <span className="num text-sm">{asOf}</span>
      </div>

      <DiffBlock diff={diff.data} loading={diff.isLoading} error={diff.error} />

      {rep.isLoading && <Loading label="Loading report" />}
      {rep.error && <ErrorBox err={rep.error} />}
      {rep.data && rep.data.picks.length === 0 && (
        <Empty title="No picks in this report" />
      )}
      {rep.data && rep.data.picks.length > 0 && (
        <Card title={`${rep.data.picks.length} picks`}>
          <ul className="space-y-2">
            {rep.data.picks.map((p) => (
              <PickRow key={p.ticker} p={p} />
            ))}
          </ul>
        </Card>
      )}

      {rep.data && (
        <p className="muted text-xs">{rep.data.disclaimer}</p>
      )}
    </div>
  );
}

function PickRow({ p }: { p: Pick }) {
  const tone = labelTone(p.label);
  return (
    <li className="panel p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href={`/ticker/${p.ticker}`} className="num font-semibold hover:text-[var(--accent)]">
            {p.ticker}
          </Link>
          <Badge tone={tone}>
            <LabelIcon label={p.label} />
            {p.label}
          </Badge>
          <span className="muted text-xs">score</span>
          <span className="num text-sm">{p.score.toFixed(3)}</span>
          <span className="muted text-xs">er</span>
          <span className={`num text-sm ${p.expected_return >= 0 ? "up" : "down"}`}>
            {fmtPct(p.expected_return)}
          </span>
        </div>
        {p.risk_flags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {p.risk_flags.map((f) => (
              <Badge key={f} tone="warn">
                {f}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {p.rationale && (
        <p className="muted text-xs mt-2 leading-relaxed">{p.rationale}</p>
      )}
    </li>
  );
}

function DiffBlock({
  diff,
  loading,
  error,
}: {
  diff: ReportDiff | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (loading) return <Loading label="Loading diff" />;
  if (error) return null; // diff can be absent for the very first archived report
  if (!diff) return null;
  if (!diff.prior_as_of) {
    return (
      <Card title="Diff">
        <p className="muted text-xs">No prior snapshot to diff against.</p>
      </Card>
    );
  }
  const empty =
    diff.new_picks.length === 0 &&
    diff.dropped_picks.length === 0 &&
    diff.upgraded.length === 0 &&
    diff.downgraded.length === 0;
  return (
    <Card
      title={`Diff vs ${diff.prior_as_of}`}
      right={
        empty ? (
          <span className="muted text-xs">no changes</span>
        ) : (
          <span className="muted text-xs">
            +{diff.new_picks.length} / -{diff.dropped_picks.length}
          </span>
        )
      }
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <DiffList
          title="New"
          icon={<PlusCircle weight="duotone" size={14} className="up" />}
          items={diff.new_picks}
        />
        <DiffList
          title="Dropped"
          icon={<MinusCircle weight="duotone" size={14} className="down" />}
          items={diff.dropped_picks}
        />
        <DiffList
          title="Upgraded"
          icon={<ArrowUp weight="duotone" size={14} className="up" />}
          items={diff.upgraded.map((u) => `${u.ticker} ${u.from} -> ${u.to}`)}
        />
        <DiffList
          title="Downgraded"
          icon={<ArrowDown weight="duotone" size={14} className="down" />}
          items={diff.downgraded.map((u) => `${u.ticker} ${u.from} -> ${u.to}`)}
        />
      </div>
    </Card>
  );
}

function DiffList({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: string[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs muted uppercase tracking-wide mb-1.5">
        {icon}
        {title}
      </div>
      {items.length === 0 ? (
        <div className="muted text-xs">none</div>
      ) : (
        <ul className="space-y-1">
          {items.map((s, i) => (
            <li key={i} className="num text-sm">
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

from __future__ import annotations
from .daily import DailyReport


DISCLAIMER = ("> **NOT FINANCIAL ADVICE.** SignalClaw is a personal research tool. "
              "See FINANCIAL_DISCLAIMER.md.")


def render_markdown(report: DailyReport) -> str:
    lines = [f"# SignalClaw daily report  {report.as_of}", "", DISCLAIMER, ""]
    if not report.picks:
        lines.append("_No picks generated._")
        return "\n".join(lines)
    lines.append("| Ticker | Label | Score | E[5d ret] | Risk flags |")
    lines.append("|--------|-------|------:|----------:|------------|")
    for p in report.picks:
        flags = ", ".join(p.risk_flags) or "none"
        lines.append(f"| {p.ticker} | **{p.label}** | {p.score:+.2f} | {p.expected_return*100:+.2f}% | {flags} |")
    lines.append("")
    lines.append("## Rationale")
    for p in report.picks:
        lines.append(f"- {p.rationale}")
    lines.append("")
    lines.append(DISCLAIMER)
    return "\n".join(lines)

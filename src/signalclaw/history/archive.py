"""Daily report persistence and diff vs prior day.

Reports are persisted as JSON files named YYYY-MM-DD.json under data/reports/.
Diff highlights pick churn so the user can see signal stability day over day.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ..engine.daily import DailyReport, DailyPick


LABEL_RANK = {"skip": 0, "hold": 1, "watch": 2}


@dataclass
class ReportSummary:
    as_of: str
    n_picks: int
    n_watch: int
    n_hold: int
    n_skip: int
    top_pick: Optional[str]

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReportDiff:
    prior_as_of: Optional[str]
    current_as_of: str
    new_picks: List[str] = field(default_factory=list)
    dropped_picks: List[str] = field(default_factory=list)
    upgraded: List[Dict] = field(default_factory=list)   # {ticker, from, to}
    downgraded: List[Dict] = field(default_factory=list)
    score_changes: List[Dict] = field(default_factory=list)  # top movers
    unchanged: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _summary(report: DailyReport) -> ReportSummary:
    labels = [p.label.lower() for p in report.picks]
    n_watch = sum(1 for x in labels if x == "watch")
    n_hold = sum(1 for x in labels if x == "hold")
    n_skip = sum(1 for x in labels if x == "skip")
    top = report.picks[0].ticker if report.picks else None
    return ReportSummary(
        as_of=report.as_of,
        n_picks=len(report.picks),
        n_watch=n_watch,
        n_hold=n_hold,
        n_skip=n_skip,
        top_pick=top,
    )


def diff_reports(prior: Optional[DailyReport], current: DailyReport,
                 top_n_movers: int = 5) -> ReportDiff:
    cur_by_t: Dict[str, DailyPick] = {p.ticker: p for p in current.picks}
    if prior is None:
        return ReportDiff(
            prior_as_of=None,
            current_as_of=current.as_of,
            new_picks=sorted(cur_by_t),
        )
    prior_by_t: Dict[str, DailyPick] = {p.ticker: p for p in prior.picks}

    new_picks = sorted(set(cur_by_t) - set(prior_by_t))
    dropped = sorted(set(prior_by_t) - set(cur_by_t))
    upgraded: List[Dict] = []
    downgraded: List[Dict] = []
    unchanged: List[str] = []
    movers: List[Tuple[str, float, float]] = []
    for t in sorted(set(cur_by_t) & set(prior_by_t)):
        before = prior_by_t[t]
        after = cur_by_t[t]
        rb = LABEL_RANK.get(before.label.lower(), 0)
        ra = LABEL_RANK.get(after.label.lower(), 0)
        if ra > rb:
            upgraded.append({"ticker": t, "from": before.label, "to": after.label})
        elif ra < rb:
            downgraded.append({"ticker": t, "from": before.label, "to": after.label})
        else:
            unchanged.append(t)
        movers.append((t, before.score, after.score))

    movers.sort(key=lambda x: abs(x[2] - x[1]), reverse=True)
    score_changes = [
        {"ticker": t, "from": round(b, 4), "to": round(a, 4),
         "delta": round(a - b, 4)}
        for (t, b, a) in movers[:top_n_movers] if (a - b) != 0
    ]
    return ReportDiff(
        prior_as_of=prior.as_of,
        current_as_of=current.as_of,
        new_picks=new_picks,
        dropped_picks=dropped,
        upgraded=upgraded,
        downgraded=downgraded,
        score_changes=score_changes,
        unchanged=unchanged,
    )


class ReportArchive:
    """Filesystem-backed archive of DailyReport snapshots."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, as_of: str) -> Path:
        return self.root / f"{as_of}.json"

    def save(self, report: DailyReport) -> Path:
        p = self._path(report.as_of)
        p.write_text(json.dumps(report.to_dict(), indent=2, sort_keys=True))
        return p

    def load(self, as_of: str) -> Optional[DailyReport]:
        p = self._path(as_of)
        if not p.exists():
            return None
        data = json.loads(p.read_text())
        picks = [DailyPick(**pp) for pp in data.get("picks", [])]
        return DailyReport(as_of=data["as_of"], picks=picks)

    def list_dates(self) -> List[str]:
        return sorted(p.stem for p in self.root.glob("*.json"))

    def summaries(self, limit: Optional[int] = None) -> List[ReportSummary]:
        dates = self.list_dates()
        if limit:
            dates = dates[-limit:]
        out: List[ReportSummary] = []
        for d in dates:
            r = self.load(d)
            if r is not None:
                out.append(_summary(r))
        return out

    def latest(self) -> Optional[DailyReport]:
        dates = self.list_dates()
        if not dates:
            return None
        return self.load(dates[-1])

    def prior_of(self, as_of: str) -> Optional[DailyReport]:
        dates = [d for d in self.list_dates() if d < as_of]
        if not dates:
            return None
        return self.load(dates[-1])

    def diff_latest(self) -> Optional[ReportDiff]:
        latest = self.latest()
        if latest is None:
            return None
        prior = self.prior_of(latest.as_of)
        return diff_reports(prior, latest)

    def diff_between(self, current_as_of: str, prior_as_of: Optional[str] = None) -> Optional[ReportDiff]:
        cur = self.load(current_as_of)
        if cur is None:
            return None
        if prior_as_of is None:
            prior = self.prior_of(current_as_of)
        else:
            prior = self.load(prior_as_of)
        return diff_reports(prior, cur)

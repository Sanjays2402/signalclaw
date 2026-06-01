"""Audit-log anomaly detection.

Layered on top of the existing append-only audit log. We never store
a side database here so the detector remains a pure function of what
an auditor can already replay from disk. The four detectors target
the most common SOC2/ISO-A.9 talking points:

* ``auth_burst``: a single source IP racks up many ``401``/``403``
  rows in a short window. Classic brute-force or credential-stuffing.
* ``key_burst``: same as above but pivoted by API key hash, so a
  leaked credential gets flagged even if the attacker rotates IPs.
* ``key_ip_fanout``: one API key shows up from many distinct source
  IPs inside the window. Usually means a credential is being shared
  (against policy) or has been exfiltrated.
* ``offhours_admin``: a mutating admin call (``/admin/...`` with
  ``PUT``/``POST``/``DELETE`` and a 2xx response) lands outside the
  configured business-hours window in UTC.

All detectors take the same shape: read recent rows via
``AuditLog.iter_search`` (newest-first), aggregate, and emit a small,
JSON-serialisable list of findings. Every finding includes the
``request_id``s of the contributing rows so an operator can pivot
straight into the existing audit search UI for evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from .log import AuditLog


# Defaults are deliberately conservative so the panel is not noisy on
# a healthy install. They are exposed as function arguments so an
# operator can tune per-tenant without code changes.
DEFAULT_WINDOW_MIN = 60
DEFAULT_BURST_THRESHOLD = 10
DEFAULT_FANOUT_THRESHOLD = 3
DEFAULT_OFFHOURS_START_UTC = 13   # business hours START at 13:00 UTC (06:00 PT)
DEFAULT_OFFHOURS_END_UTC = 2      # business hours END at 02:00 UTC next day (19:00 PT)


@dataclass
class Finding:
    kind: str            # one of: auth_burst, key_burst, key_ip_fanout, offhours_admin
    severity: str        # low | medium | high
    summary: str         # human readable one-liner for the UI
    subject: str         # the dimension that triggered (ip, key hash, label)
    count: int           # number of contributing events
    first_ts: str        # earliest event ts in the window
    last_ts: str         # most recent event ts
    request_ids: List[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)


def _parse_ts(ts: str) -> Optional[datetime]:
    # The audit log always writes ``...Z`` ISO8601 with microseconds;
    # we still guard against malformed rows so a single bad line never
    # blows up the whole report.
    if not ts:
        return None
    try:
        # ``fromisoformat`` accepts the trailing ``+00:00`` style; we
        # normalise ``Z`` to that so the parser is happy.
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _within_window(ts: datetime, now: datetime, window_min: int) -> bool:
    delta = (now - ts).total_seconds()
    return 0 <= delta <= window_min * 60


def _severity(count: int, threshold: int) -> str:
    if count >= threshold * 3:
        return "high"
    if count >= threshold * 2:
        return "medium"
    return "low"


def detect(
    log: AuditLog,
    *,
    window_min: int = DEFAULT_WINDOW_MIN,
    burst_threshold: int = DEFAULT_BURST_THRESHOLD,
    fanout_threshold: int = DEFAULT_FANOUT_THRESHOLD,
    offhours_start_utc: int = DEFAULT_OFFHOURS_START_UTC,
    offhours_end_utc: int = DEFAULT_OFFHOURS_END_UTC,
    now: Optional[datetime] = None,
    max_scan: int = 50_000,
) -> Dict[str, object]:
    """Run all detectors over the recent audit log.

    ``now`` defaults to ``datetime.now(timezone.utc)`` but is injectable
    so unit tests can pin time deterministically. The function returns
    a dict shaped for direct JSON serialisation by FastAPI.
    """
    if window_min <= 0:
        raise ValueError("window_min must be positive")
    if burst_threshold <= 0 or fanout_threshold <= 0:
        raise ValueError("thresholds must be positive")
    if not (0 <= offhours_start_utc <= 23 and 0 <= offhours_end_utc <= 23):
        raise ValueError("offhours hours must be in 0..23")

    now = now or datetime.now(timezone.utc)

    # We always need to look at "today" plus a small lookback so a
    # 60 minute window across midnight UTC still works. 2 days back is
    # the smallest safe value; we cap iter_search well above the
    # expected volume in the window.
    rows: List[dict] = []
    for row in log.iter_search(filters=None, days_back=2, max_rows=max_scan):
        ts = _parse_ts(str(row.get("ts", "")))
        if ts is None:
            continue
        delta = (now - ts).total_seconds()
        if delta < 0:
            # Future-dated row (clock skew or test fixture). Skip
            # without breaking the scan; subsequent rows may still
            # be in window.
            continue
        if delta > window_min * 60:
            # iter_search is newest-first within each file, so once
            # we cross the trailing window edge we can stop scanning.
            break
        rows.append(row)

    # --- auth_burst: bucket failed-auth rows by source ip --------------
    auth_by_ip: Dict[str, List[dict]] = {}
    for r in rows:
        status = int(r.get("status") or 0)
        if status in (401, 403):
            ip = str(r.get("source_ip") or "")
            if ip:
                auth_by_ip.setdefault(ip, []).append(r)

    findings: List[Finding] = []
    for ip, group in auth_by_ip.items():
        if len(group) >= burst_threshold:
            ts_vals = sorted(str(g.get("ts", "")) for g in group)
            findings.append(Finding(
                kind="auth_burst",
                severity=_severity(len(group), burst_threshold),
                summary=f"{len(group)} auth failures from {ip} in last {window_min}m",
                subject=ip,
                count=len(group),
                first_ts=ts_vals[0],
                last_ts=ts_vals[-1],
                request_ids=[str(g.get("request_id", "")) for g in group[:25]],
                extra={"window_min": window_min, "threshold": burst_threshold},
            ))

    # --- key_burst: failed-auth rows pivoted by key hash ---------------
    auth_by_key: Dict[str, List[dict]] = {}
    for r in rows:
        status = int(r.get("status") or 0)
        if status in (401, 403):
            kh = str(r.get("actor_key_hash") or "")
            if kh:
                auth_by_key.setdefault(kh, []).append(r)
    for kh, group in auth_by_key.items():
        if len(group) >= burst_threshold:
            ts_vals = sorted(str(g.get("ts", "")) for g in group)
            label = str(group[0].get("actor_label") or "")
            findings.append(Finding(
                kind="key_burst",
                severity=_severity(len(group), burst_threshold),
                summary=(
                    f"{len(group)} denied calls on key {kh[:8]}"
                    f" ({label or 'unlabeled'}) in last {window_min}m"
                ),
                subject=kh,
                count=len(group),
                first_ts=ts_vals[0],
                last_ts=ts_vals[-1],
                request_ids=[str(g.get("request_id", "")) for g in group[:25]],
                extra={"actor_label": label},
            ))

    # --- key_ip_fanout: one key hit from many distinct IPs -------------
    key_ips: Dict[str, Dict[str, List[dict]]] = {}
    for r in rows:
        kh = str(r.get("actor_key_hash") or "")
        ip = str(r.get("source_ip") or "")
        if not kh or not ip:
            continue
        key_ips.setdefault(kh, {}).setdefault(ip, []).append(r)
    for kh, ip_map in key_ips.items():
        # Localhost-only traffic does not move the needle for credential
        # sharing; require at least one non-loopback IP to be in the mix.
        non_loopback = [ip for ip in ip_map if ip not in ("127.0.0.1", "::1", "")]
        if len(ip_map) >= fanout_threshold and non_loopback:
            all_rows = [r for grp in ip_map.values() for r in grp]
            ts_vals = sorted(str(r.get("ts", "")) for r in all_rows)
            label = str(all_rows[0].get("actor_label") or "")
            findings.append(Finding(
                kind="key_ip_fanout",
                severity=_severity(len(ip_map), fanout_threshold),
                summary=(
                    f"Key {kh[:8]} ({label or 'unlabeled'}) used from "
                    f"{len(ip_map)} distinct IPs in last {window_min}m"
                ),
                subject=kh,
                count=len(ip_map),
                first_ts=ts_vals[0],
                last_ts=ts_vals[-1],
                request_ids=[str(r.get("request_id", "")) for r in all_rows[:25]],
                extra={"ips": sorted(ip_map.keys())[:25], "actor_label": label},
            ))

    # --- offhours_admin: admin mutations outside business hours --------
    # Business hours are inclusive of start, exclusive of end on a
    # 24-hour UTC clock. When start <= end this is the simple band;
    # when start > end (wrap around midnight) we invert the test.
    def _in_business(h: int) -> bool:
        if offhours_start_utc <= offhours_end_utc:
            return offhours_start_utc <= h < offhours_end_utc
        return h >= offhours_start_utc or h < offhours_end_utc

    for r in rows:
        method = str(r.get("method") or "").upper()
        path = str(r.get("path") or "")
        status = int(r.get("status") or 0)
        if method not in ("PUT", "POST", "DELETE", "PATCH"):
            continue
        if not path.startswith("/admin/"):
            continue
        if not (200 <= status < 300):
            continue
        ts = _parse_ts(str(r.get("ts", "")))
        if ts is None:
            continue
        if _in_business(ts.hour):
            continue
        label = str(r.get("actor_label") or "")
        kh = str(r.get("actor_key_hash") or "")
        findings.append(Finding(
            kind="offhours_admin",
            severity="medium",
            summary=(
                f"Admin mutation {method} {path} at {ts.strftime('%H:%M UTC')} "
                f"by {label or kh[:8] or 'unknown'}"
            ),
            subject=path,
            count=1,
            first_ts=str(r.get("ts", "")),
            last_ts=str(r.get("ts", "")),
            request_ids=[str(r.get("request_id", ""))],
            extra={
                "actor_label": label,
                "actor_key_hash": kh,
                "source_ip": str(r.get("source_ip") or ""),
                "method": method,
            },
        ))

    # Sort: severity then recency. High first, then medium, then low.
    sev_rank = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (sev_rank.get(f.severity, 9), f.last_ts), reverse=False)
    # Recency within same severity should be newest-first.
    findings.sort(key=lambda f: f.last_ts, reverse=True)
    findings.sort(key=lambda f: sev_rank.get(f.severity, 9))

    return {
        "window_min": window_min,
        "scanned": len(rows),
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "thresholds": {
            "auth_burst": burst_threshold,
            "key_burst": burst_threshold,
            "key_ip_fanout": fanout_threshold,
            "offhours_window_utc": [offhours_start_utc, offhours_end_utc],
        },
        "findings": [f.__dict__ for f in findings],
    }

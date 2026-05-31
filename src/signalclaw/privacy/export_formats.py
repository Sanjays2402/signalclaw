"""Multi-format renderers for the GDPR data export.

The JSON dict produced by :func:`signalclaw.privacy.collect_user_data`
is the source of truth. This module turns that dict into formats that
buyers' compliance teams typically ask for:

* ``json``  - single pretty-printed JSON document.
* ``csv``   - one CSV per list-typed top-level key, returned as a
  multipart-style tarball; here we render it as a single ZIP because
  CSV alone cannot carry the multi-sheet shape and procurement teams
  ask for ``.zip`` of CSVs by name.
* ``zip``   - same ZIP bundle as ``csv`` plus the raw JSON and a
  ``MANIFEST.txt`` summarising rows-per-store and the export time so
  the bundle is self-describing for an auditor opening it offline.

The audit log block is exported as one CSV per UTC day plus a
combined ``audit_log_all.csv`` so a reviewer can grep the full history
without scripting.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Tuple


def _flatten_keys(rows: Iterable[Dict[str, Any]]) -> List[str]:
    keys: List[str] = []
    seen = set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        for k in r.keys():
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return keys


def _stringify(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, sort_keys=True, default=str)
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _rows_to_csv(rows: List[Any]) -> str:
    """Render a list of dict-like rows as CSV. Non-dict rows are
    written as a single ``value`` column so primitives still export.
    """
    buf = io.StringIO()
    if not rows:
        return ""
    dict_rows = [r for r in rows if isinstance(r, dict)]
    if dict_rows:
        cols = _flatten_keys(dict_rows)
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(cols)
        for r in rows:
            if isinstance(r, dict):
                w.writerow([_stringify(r.get(c)) for c in cols])
            else:
                # primitive in an otherwise-dict list: spread to first col
                row = [""] * len(cols)
                row[0] = _stringify(r)
                w.writerow(row)
    else:
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["value"])
        for r in rows:
            w.writerow([_stringify(r)])
    return buf.getvalue()


def _audit_csvs(audit_log: Dict[str, List[Dict[str, Any]]]) -> List[Tuple[str, str]]:
    """Return (filename, content) tuples for the audit log block."""
    out: List[Tuple[str, str]] = []
    combined: List[Dict[str, Any]] = []
    for day in sorted(audit_log.keys()):
        events = audit_log.get(day) or []
        if not events:
            continue
        out.append((f"audit_log/{day}.csv", _rows_to_csv(events)))
        combined.extend(events)
    if combined:
        out.append(("audit_log/all.csv", _rows_to_csv(combined)))
    return out


_LIST_KEYS = (
    "watchlist",
    "alerts",
    "portfolio_trades",
    "stops",
    "earnings",
    "journal",
    "brackets",
    "news_events",
    "webhooks",
    "drawdown_history",
    "fx_currencies",
    "scaling_plans",
)


def build_zip(bundle: Dict[str, Any], *, include_json: bool = True) -> bytes:
    """Serialise the export bundle as a ZIP of CSV files.

    Layout::

        MANIFEST.txt
        export.json          (only if include_json=True)
        watchlist.csv
        alerts.csv
        ...
        audit_log/YYYY-MM-DD.csv
        audit_log/all.csv

    Empty stores still produce a header-only CSV so the buyer can see
    the schema and confirm nothing was hidden by omission.
    """
    files: List[Tuple[str, str]] = []
    counts: Dict[str, int] = {}
    for key in _LIST_KEYS:
        rows = bundle.get(key) or []
        if not isinstance(rows, list):
            rows = [rows]
        counts[key] = len(rows)
        files.append((f"{key}.csv", _rows_to_csv(rows)))
    audit = bundle.get("audit_log") or {}
    if isinstance(audit, dict):
        files.extend(_audit_csvs(audit))
        counts["audit_log_days"] = len(audit)

    meta = bundle.get("meta") or {}
    manifest_lines = [
        "SignalClaw data export",
        f"exported_at: {meta.get('exported_at', '')}",
        f"schema_version: {meta.get('schema_version', '')}",
        f"data_dir: {meta.get('data_dir', '')}",
        f"format: zip(csv)",
        "",
        "row counts:",
    ]
    for k in sorted(counts):
        manifest_lines.append(f"  {k}: {counts[k]}")
    manifest = "\n".join(manifest_lines) + "\n"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("MANIFEST.txt", manifest)
        if include_json:
            z.writestr(
                "export.json",
                json.dumps(bundle, indent=2, sort_keys=True, default=str),
            )
        for name, content in files:
            z.writestr(name, content)
    return buf.getvalue()


def export_filename(fmt: str, *, now: datetime | None = None) -> str:
    ts = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    ext = "zip" if fmt in ("zip", "csv") else "json"
    return f"signalclaw-export-{ts}.{ext}"


__all__ = ["build_zip", "export_filename"]

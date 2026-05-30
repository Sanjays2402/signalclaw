"""JSON-backed alert persistence."""
from __future__ import annotations
import json
import threading
from pathlib import Path
from typing import List, Optional

from .rules import Alert


class AlertStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"alerts": []}, indent=2))

    def _read(self) -> List[Alert]:
        raw = json.loads(self.path.read_text() or '{"alerts":[]}')
        return [Alert.from_dict(a) for a in raw.get("alerts", [])]

    def _write(self, alerts: List[Alert]) -> None:
        self.path.write_text(
            json.dumps({"alerts": [a.to_dict() for a in alerts]}, indent=2, sort_keys=True)
        )

    def list(self, ticker: Optional[str] = None) -> List[Alert]:
        alerts = self._read()
        if ticker:
            t = ticker.upper()
            alerts = [a for a in alerts if a.ticker == t]
        return alerts

    def get(self, alert_id: str) -> Optional[Alert]:
        for a in self._read():
            if a.id == alert_id:
                return a
        return None

    def add(self, alert: Alert) -> Alert:
        with self._lock:
            alerts = self._read()
            alert.ticker = alert.ticker.upper()
            alerts.append(alert)
            self._write(alerts)
        return alert

    def remove(self, alert_id: str) -> bool:
        with self._lock:
            alerts = self._read()
            new = [a for a in alerts if a.id != alert_id]
            if len(new) == len(alerts):
                return False
            self._write(new)
        return True

    def update(self, alert: Alert) -> Alert:
        with self._lock:
            alerts = self._read()
            for i, a in enumerate(alerts):
                if a.id == alert.id:
                    alerts[i] = alert
                    break
            else:
                alerts.append(alert)
            self._write(alerts)
        return alert

    def clear(self) -> None:
        with self._lock:
            self._write([])

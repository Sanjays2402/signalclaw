"""Portfolio persistence: trades JSON + CSV import."""
from __future__ import annotations
import csv
import io
import json
import threading
from pathlib import Path
from typing import Dict, List

from .position import Trade, TradeSide, Position, apply_trades


class PortfolioStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"trades": []}, indent=2))

    def _read_trades(self) -> List[Trade]:
        raw = json.loads(self.path.read_text() or '{"trades":[]}')
        return [Trade.from_dict(t) for t in raw.get("trades", [])]

    def _write_trades(self, trades: List[Trade]) -> None:
        self.path.write_text(
            json.dumps({"trades": [t.to_dict() for t in trades]}, indent=2, sort_keys=True)
        )

    def trades(self) -> List[Trade]:
        return self._read_trades()

    def add_trade(self, trade: Trade) -> Trade:
        with self._lock:
            trades = self._read_trades()
            trades.append(trade)
            # recompute realized_pnl across all trades for consistency
            apply_trades(trades)
            self._write_trades(trades)
        return trade

    def remove_trade(self, trade_id: str) -> bool:
        with self._lock:
            trades = self._read_trades()
            new = [t for t in trades if t.id != trade_id]
            if len(new) == len(trades):
                return False
            apply_trades(new)
            self._write_trades(new)
        return True

    def positions(self) -> Dict[str, Position]:
        return apply_trades(self._read_trades())

    def clear(self) -> None:
        with self._lock:
            self._write_trades([])

    def import_csv(self, csv_text: str) -> int:
        """Import trades from CSV with header: ticker,side,quantity,price,date[,fees,note].

        Returns count of trades added. Existing trades preserved.
        """
        reader = csv.DictReader(io.StringIO(csv_text))
        added: List[Trade] = []
        for row in reader:
            try:
                tr = Trade(
                    ticker=row["ticker"].upper().strip(),
                    side=TradeSide(row["side"].lower().strip()),
                    quantity=float(row["quantity"]),
                    price=float(row["price"]),
                    date=str(row["date"]).strip(),
                    fees=float(row.get("fees") or 0.0),
                    note=(row.get("note") or "").strip(),
                )
                added.append(tr)
            except (KeyError, ValueError) as e:
                raise ValueError(f"bad CSV row {row}: {e}")
        with self._lock:
            trades = self._read_trades()
            trades.extend(added)
            apply_trades(trades)
            self._write_trades(trades)
        return len(added)

    def export_csv(self) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "ticker", "side", "quantity", "price", "date",
                    "fees", "realized_pnl", "note"])
        for t in self._read_trades():
            w.writerow([t.id, t.ticker, t.side.value, t.quantity, t.price,
                        t.date, t.fees, t.realized_pnl, t.note])
        return buf.getvalue()

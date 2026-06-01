from __future__ import annotations
import json
from pathlib import Path
from typing import Dict, List, Optional

# Default watchlist seeded from Sanjay's known holdings (memory/MEMORY.md):
# BTC, SOXX, MSFT, FXAIX, TSLA, SPY.
# yfinance uses BTC-USD for spot bitcoin; FXAIX is the Fidelity 500 mutual fund.
DEFAULT_WATCHLIST: List[str] = ["BTC-USD", "SOXX", "MSFT", "FXAIX", "TSLA", "SPY"]

# Internal sentinel for the legacy / operator-default tenant. The on-disk
# JSON shape kept its top-level ``tickers`` array for backwards compat with
# pre-multitenant deployments; new per-tenant lists live under
# ``tenants[owner_key_id]``. Calls without an owner_id continue to operate
# against the legacy bucket so single-tenant installs keep working.
_LEGACY_TENANT = "__default__"


def default_watchlist() -> List[str]:
    return list(DEFAULT_WATCHLIST)


class WatchlistStore:
    """JSON-backed watchlist store with per-API-key tenant scoping.

    On-disk shape::

        {
            "tickers": [...],          # legacy / operator-default tenant
            "tenants": {
                "<owner_key_id>": [...],
                ...
            }
        }

    Each user-managed API key (``StoredKey.id``) gets its own isolated
    list. The legacy ``tickers`` field is preserved so old single-tenant
    installs upgrade in-place: callers that pass ``owner_id=None`` (admin
    aggregate / env operator key) continue to read and write that bucket.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(json.dumps(
                {"tickers": default_watchlist(), "tenants": {}}, indent=2))

    # ----- raw persistence -------------------------------------------------
    def _read(self) -> Dict[str, object]:
        try:
            data = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("tickers", default_watchlist())
        data.setdefault("tenants", {})
        if not isinstance(data["tenants"], dict):
            data["tenants"] = {}
        return data

    def _write(self, data: Dict[str, object]) -> None:
        self.path.write_text(json.dumps(data, indent=2))

    # ----- legacy single-tenant surface (kept for back-compat) ------------
    def list(self) -> List[str]:
        return list(self._read().get("tickers", []))

    def add(self, ticker: str) -> List[str]:
        data = self._read()
        ts = list(data.get("tickers", []))
        t = (ticker or "").upper().strip()
        if t and t not in ts:
            ts.append(t)
            data["tickers"] = ts
            self._write(data)
        return ts

    def remove(self, ticker: str) -> List[str]:
        data = self._read()
        ts = [t for t in data.get("tickers", []) if t.upper() != ticker.upper()]
        data["tickers"] = ts
        self._write(data)
        return ts

    # ----- per-tenant surface ---------------------------------------------
    def _bucket_key(self, owner_id: Optional[str]) -> str:
        return owner_id if owner_id else _LEGACY_TENANT

    def list_for(self, owner_id: Optional[str], *, is_admin: bool = False) -> List[str]:
        """List a tenant's tickers.

        - ``owner_id`` set: return that tenant's list (seeded from the default
          watchlist on first read so new orgs get a usable starting point).
        - ``owner_id`` is ``None`` and ``is_admin`` true: legacy/operator bucket.
        """
        data = self._read()
        if owner_id is None:
            return list(data.get("tickers", []))
        tenants = data.get("tenants", {})
        if owner_id in tenants and isinstance(tenants[owner_id], list):
            return list(tenants[owner_id])
        # First touch for this tenant: seed and persist defaults so the UI
        # has something to render instead of an empty state.
        seeded = default_watchlist()
        tenants[owner_id] = list(seeded)
        data["tenants"] = tenants
        self._write(data)
        return seeded

    def add_for(self, owner_id: Optional[str], ticker: str) -> List[str]:
        if owner_id is None:
            return self.add(ticker)
        data = self._read()
        tenants = data.get("tenants", {})
        current = tenants.get(owner_id)
        if not isinstance(current, list):
            current = list(default_watchlist())
        t = (ticker or "").upper().strip()
        if t and t not in current:
            current.append(t)
        tenants[owner_id] = current
        data["tenants"] = tenants
        self._write(data)
        return list(current)

    def remove_for(self, owner_id: Optional[str], ticker: str) -> List[str]:
        if owner_id is None:
            return self.remove(ticker)
        data = self._read()
        tenants = data.get("tenants", {})
        current = tenants.get(owner_id)
        if not isinstance(current, list):
            current = list(default_watchlist())
        kept = [t for t in current if t.upper() != ticker.upper()]
        tenants[owner_id] = kept
        data["tenants"] = tenants
        self._write(data)
        return kept

    def all_tenants(self) -> Dict[str, List[str]]:
        """Admin aggregate view: ``{owner_key_id: [tickers...]}``.

        Includes the legacy/operator bucket under ``__default__`` so admins
        can audit what an unscoped operator key is using.
        """
        data = self._read()
        out: Dict[str, List[str]] = {
            _LEGACY_TENANT: list(data.get("tickers", []))
        }
        tenants = data.get("tenants", {})
        if isinstance(tenants, dict):
            for k, v in tenants.items():
                if isinstance(v, list):
                    out[str(k)] = list(v)
        return out

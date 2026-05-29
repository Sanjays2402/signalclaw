from __future__ import annotations
from pathlib import Path
import pandas as pd


class ParquetStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def write(self, name: str, df: pd.DataFrame) -> Path:
        p = self.root / f"{name}.parquet"
        df.to_parquet(p)
        return p

    def read(self, name: str) -> pd.DataFrame:
        p = self.root / f"{name}.parquet"
        return pd.read_parquet(p) if p.exists() else pd.DataFrame()

    def exists(self, name: str) -> bool:
        return (self.root / f"{name}.parquet").exists()

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class TransactionCostModel:
    commission_bps: float = 1.0  # 0.01%
    slippage_bps: float = 5.0  # 0.05%

    def cost(self, turnover: float) -> float:
        return turnover * (self.commission_bps + self.slippage_bps) / 10_000.0

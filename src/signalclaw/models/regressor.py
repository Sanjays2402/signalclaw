from __future__ import annotations
from pathlib import Path
import joblib
import numpy as np
import pandas as pd


class ReturnRegressor:
    """XGBoost regressor for next-N-day forward return."""

    def __init__(self, **params):
        import xgboost as xgb
        defaults = dict(
            objective="reg:squarederror", n_estimators=400, learning_rate=0.05,
            max_depth=6, subsample=0.8, colsample_bytree=0.8,
            reg_lambda=1.0, verbosity=0,
        )
        defaults.update(params)
        self.model = xgb.XGBRegressor(**defaults)
        self.feature_names_: list[str] = []

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "ReturnRegressor":
        self.feature_names_ = list(X.columns)
        self.model.fit(X.values, y.values)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict(X[self.feature_names_].values)

    def save(self, path: Path) -> None:
        joblib.dump({"model": self.model, "features": self.feature_names_}, path)

    @classmethod
    def load(cls, path: Path) -> "ReturnRegressor":
        obj = cls()
        d = joblib.load(path)
        obj.model = d["model"]
        obj.feature_names_ = d["features"]
        return obj

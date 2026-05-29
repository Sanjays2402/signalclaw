from __future__ import annotations
from pathlib import Path
import joblib
import numpy as np
import pandas as pd


class WatchHoldSkipClassifier:
    """LightGBM 3-class classifier: 0=skip, 1=hold, 2=watch."""

    def __init__(self, **params):
        import lightgbm as lgb
        defaults = dict(
            objective="multiclass", num_class=3, n_estimators=300,
            learning_rate=0.05, num_leaves=31, min_child_samples=20,
            feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=5,
            verbose=-1,
        )
        defaults.update(params)
        self.model = lgb.LGBMClassifier(**defaults)
        self.feature_names_: list[str] = []

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "WatchHoldSkipClassifier":
        self.feature_names_ = list(X.columns)
        self.model.fit(X.values, y.values)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict_proba(X[self.feature_names_].values)

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict(X[self.feature_names_].values)

    def feature_importance(self) -> pd.Series:
        return pd.Series(self.model.feature_importances_, index=self.feature_names_).sort_values(ascending=False)

    def save(self, path: Path) -> None:
        joblib.dump({"model": self.model, "features": self.feature_names_}, path)

    @classmethod
    def load(cls, path: Path) -> "WatchHoldSkipClassifier":
        obj = cls()
        d = joblib.load(path)
        obj.model = d["model"]
        obj.feature_names_ = d["features"]
        return obj

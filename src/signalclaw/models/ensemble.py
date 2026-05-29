from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd


@dataclass
class EnsemblePrediction:
    label: str  # watch / hold / skip
    score: float  # composite [-1, 1]
    proba: dict
    expected_return: float
    lstm_up_prob: float


class Ensemble:
    LABELS = {0: "skip", 1: "hold", 2: "watch"}

    def __init__(self, clf, reg, lstm=None, weights=(0.5, 0.3, 0.2)):
        self.clf = clf
        self.reg = reg
        self.lstm = lstm
        self.weights = weights

    def predict_row(self, X: pd.DataFrame) -> EnsemblePrediction:
        proba = self.clf.predict_proba(X)[-1]
        cls_score = float(proba[2] - proba[0])
        exp_ret = float(self.reg.predict(X)[-1])
        lstm_p = 0.5
        if self.lstm is not None:
            lstm_p = float(self.lstm.predict_proba_up(X)[-1])
        composite = (self.weights[0] * cls_score
                     + self.weights[1] * np.tanh(exp_ret * 10)
                     + self.weights[2] * (lstm_p - 0.5) * 2)
        if composite >= 0.25:
            label = "watch"
        elif composite <= -0.15:
            label = "skip"
        else:
            label = "hold"
        return EnsemblePrediction(
            label=label,
            score=float(np.clip(composite, -1, 1)),
            proba={"skip": float(proba[0]), "hold": float(proba[1]), "watch": float(proba[2])},
            expected_return=exp_ret,
            lstm_up_prob=lstm_p,
        )

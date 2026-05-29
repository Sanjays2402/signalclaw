import numpy as np, pandas as pd
from signalclaw.models.labels import make_labels


def test_labels_three_classes():
    rng = np.random.default_rng(0)
    close = pd.Series(100 + np.cumsum(rng.normal(0, 1, 500)))
    lab = make_labels(close, 5).dropna()
    assert set(lab["label"].unique()).issubset({0, 1, 2})

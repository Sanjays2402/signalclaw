from __future__ import annotations
import numpy as np
import pandas as pd


class LSTMBaseline:
    """Tiny PyTorch LSTM baseline that predicts next-period direction.
    Kept simple so CPU training is feasible."""

    def __init__(self, seq_len: int = 20, hidden: int = 16, epochs: int = 3, lr: float = 1e-3):
        import torch
        import torch.nn as nn
        self.torch = torch
        self.nn = nn
        self.seq_len = seq_len
        self.hidden = hidden
        self.epochs = epochs
        self.lr = lr
        self.model = None
        self.feat_dim = 0

    def _build(self, feat_dim: int):
        nn = self.nn
        torch = self.torch

        class Net(nn.Module):
            def __init__(self, d, h):
                super().__init__()
                self.lstm = nn.LSTM(d, h, batch_first=True)
                self.head = nn.Linear(h, 1)

            def forward(self, x):
                out, _ = self.lstm(x)
                return torch.sigmoid(self.head(out[:, -1, :])).squeeze(-1)

        return Net(feat_dim, self.hidden)

    def _windows(self, X: np.ndarray, y: np.ndarray | None):
        xs, ys = [], []
        for i in range(self.seq_len, len(X)):
            xs.append(X[i - self.seq_len:i])
            if y is not None:
                ys.append(y[i])
        return np.array(xs, dtype=np.float32), (np.array(ys, dtype=np.float32) if y is not None else None)

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "LSTMBaseline":
        torch = self.torch
        self.feat_dim = X.shape[1]
        self.model = self._build(self.feat_dim)
        opt = torch.optim.Adam(self.model.parameters(), lr=self.lr)
        loss_fn = self.nn.BCELoss()
        Xw, yw = self._windows(X.values, (y.values > 0).astype(np.float32))
        if len(Xw) == 0:
            return self
        Xt = torch.tensor(Xw); yt = torch.tensor(yw)
        for _ in range(self.epochs):
            opt.zero_grad()
            pred = self.model(Xt)
            loss = loss_fn(pred, yt)
            loss.backward()
            opt.step()
        return self

    def predict_proba_up(self, X: pd.DataFrame) -> np.ndarray:
        if self.model is None:
            return np.zeros(len(X))
        torch = self.torch
        Xw, _ = self._windows(X.values, None)
        if len(Xw) == 0:
            return np.zeros(len(X))
        with torch.no_grad():
            p = self.model(torch.tensor(Xw)).numpy()
        out = np.full(len(X), 0.5)
        out[self.seq_len:] = p
        return out

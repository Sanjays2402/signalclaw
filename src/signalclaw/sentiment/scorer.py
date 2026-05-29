from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

from ..config import get_settings
from ..logging_ import get_logger

log = get_logger(__name__)


@dataclass
class SentimentResult:
    text: str
    label: str  # positive / neutral / negative
    score: float  # signed in [-1, 1]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class SentimentScorer:
    """FinBERT-backed scorer with disk cache. Falls back to lexicon if transformers unavailable."""

    def __init__(self, model_name: str = "ProsusAI/finbert", cache_dir: Path | None = None) -> None:
        self.model_name = model_name
        self.cache_dir = cache_dir or get_settings().cache_dir / "sentiment"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._pipe = None

    def _load(self):
        if self._pipe is not None:
            return self._pipe
        try:
            from transformers import pipeline
            self._pipe = pipeline("sentiment-analysis", model=self.model_name, top_k=None)
        except Exception as e:  # noqa
            log.warning("sentiment.model.unavailable", err=str(e))
            self._pipe = "lexicon"
        return self._pipe

    def _lexicon(self, text: str) -> SentimentResult:
        pos = {"beat", "surge", "rally", "upgrade", "growth", "record", "outperform", "bullish", "strong"}
        neg = {"miss", "drop", "plunge", "downgrade", "loss", "weak", "bearish", "lawsuit", "probe", "decline"}
        t = text.lower()
        p = sum(1 for w in pos if w in t)
        n = sum(1 for w in neg if w in t)
        if p == n:
            return SentimentResult(text, "neutral", 0.0)
        score = (p - n) / max(p + n, 1)
        label = "positive" if score > 0 else "negative"
        return SentimentResult(text, label, score)

    def score(self, text: str) -> SentimentResult:
        if not text:
            return SentimentResult("", "neutral", 0.0)
        cache_path = self.cache_dir / f"{_hash(text)}.json"
        if cache_path.exists():
            d = json.loads(cache_path.read_text())
            return SentimentResult(d["text"], d["label"], d["score"])
        pipe = self._load()
        if pipe == "lexicon":
            res = self._lexicon(text)
        else:
            try:
                preds = pipe(text[:512])[0]
                preds = sorted(preds, key=lambda x: x["score"], reverse=True)
                top = preds[0]
                signed = top["score"] if top["label"].lower() == "positive" else (
                    -top["score"] if top["label"].lower() == "negative" else 0.0)
                res = SentimentResult(text, top["label"].lower(), float(signed))
            except Exception as e:  # noqa
                log.warning("sentiment.infer.fail", err=str(e))
                res = self._lexicon(text)
        cache_path.write_text(json.dumps({"text": res.text[:1000], "label": res.label, "score": res.score}))
        return res


def score_items(texts: Iterable[str]) -> List[SentimentResult]:
    scorer = SentimentScorer()
    return [scorer.score(t) for t in texts]

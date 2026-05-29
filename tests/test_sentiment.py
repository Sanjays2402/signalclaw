from signalclaw.sentiment.scorer import SentimentScorer


def test_lexicon_fallback_neutral_for_empty():
    s = SentimentScorer(model_name="__nonexistent__")
    s._pipe = "lexicon"
    r = s.score("")
    assert r.label == "neutral"


def test_lexicon_positive():
    s = SentimentScorer(model_name="__nonexistent__")
    s._pipe = "lexicon"
    r = s.score("Stock surged on record bullish growth")
    assert r.score > 0

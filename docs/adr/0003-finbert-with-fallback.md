# ADR 0003: FinBERT sentiment with lexicon fallback

Context: model download may fail in restricted environments. Decision: try transformers pipeline; on failure, fall back to a small finance lexicon. Cache results to disk by SHA256.

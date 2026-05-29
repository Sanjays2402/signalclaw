# ADR 0002: yfinance + parquet store

Context: need free, reliable OHLCV for personal use. Decision: yfinance with parquet cache under data/parquet. Consequences: rate limited, occasional gaps; acceptable for a personal tool.

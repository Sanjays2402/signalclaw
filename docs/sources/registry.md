# News source registry

| source | url template | type |
|--------|--------------|------|
| yahoo | https://finance.yahoo.com/rss/headline?s={ticker} | RSS |
| seekingalpha | https://seekingalpha.com/api/sa/combined/{ticker}.xml | RSS |
| newsapi | https://newsapi.org/v2/everything | HTTP (key required) |

All sources are best-effort; failures are logged and skipped, never blocking the pipeline.

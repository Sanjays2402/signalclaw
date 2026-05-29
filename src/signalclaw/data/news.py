from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List
import feedparser
import httpx

from ..logging_ import get_logger

log = get_logger(__name__)


@dataclass
class NewsItem:
    ticker: str
    title: str
    url: str
    source: str
    published: str
    summary: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


RSS_FEEDS = {
    "yahoo": "https://finance.yahoo.com/rss/headline?s={ticker}",
    "seekingalpha": "https://seekingalpha.com/api/sa/combined/{ticker}.xml",
}


def fetch_rss(ticker: str, limit: int = 20) -> List[NewsItem]:
    items: List[NewsItem] = []
    for source, tmpl in RSS_FEEDS.items():
        url = tmpl.format(ticker=ticker.replace("-USD", ""))
        try:
            feed = feedparser.parse(url)
            for e in feed.entries[:limit]:
                items.append(NewsItem(
                    ticker=ticker,
                    title=getattr(e, "title", ""),
                    url=getattr(e, "link", ""),
                    source=source,
                    published=getattr(e, "published", datetime.utcnow().isoformat()),
                    summary=getattr(e, "summary", "")[:500],
                ))
        except Exception as ex:  # noqa
            log.warning("news.rss.fail", source=source, ticker=ticker, err=str(ex))
    return items


def fetch_newsapi(ticker: str, api_key: str, limit: int = 20) -> List[NewsItem]:
    if not api_key:
        return []
    try:
        r = httpx.get(
            "https://newsapi.org/v2/everything",
            params={"q": ticker, "pageSize": limit, "sortBy": "publishedAt", "language": "en"},
            headers={"X-Api-Key": api_key}, timeout=10.0,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as ex:  # noqa
        log.warning("news.newsapi.fail", ticker=ticker, err=str(ex))
        return []
    out = []
    for a in data.get("articles", [])[:limit]:
        out.append(NewsItem(
            ticker=ticker,
            title=a.get("title", ""),
            url=a.get("url", ""),
            source=a.get("source", {}).get("name", "newsapi"),
            published=a.get("publishedAt", ""),
            summary=(a.get("description") or "")[:500],
        ))
    return out

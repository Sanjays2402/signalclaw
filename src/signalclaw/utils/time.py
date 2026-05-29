from datetime import datetime, timezone, date


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_date_str(d: date | datetime) -> str:
    if isinstance(d, datetime):
        d = d.date()
    return d.isoformat()

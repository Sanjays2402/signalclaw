import os
import tempfile
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="sc_test_"))
# Webhook SSRF guard refuses unresolvable / private destinations by
# default. Tests use RFC 6761 reserved names (*.test) and "http://x"
# fixtures that intentionally do not resolve, so we opt out here.
# Production callers leave this unset and get the strict default.
os.environ.setdefault("SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE", "1")

#!/usr/bin/env bash
exec uvicorn signalclaw.api:app --host 0.0.0.0 --port 7431

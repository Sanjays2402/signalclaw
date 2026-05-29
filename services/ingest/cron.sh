#!/usr/bin/env bash
# Crontab entry suggestion:
# 5 6 * * 1-5 /path/to/services/ingest/cron.sh >> /var/log/signalclaw-ingest.log 2>&1
cd "$(dirname "$0")/../.." && signalclaw ingest --period 3y

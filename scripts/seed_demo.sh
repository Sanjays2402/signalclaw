#!/usr/bin/env bash
set -e
signalclaw watchlist list
signalclaw ingest --period 3y
signalclaw run --today

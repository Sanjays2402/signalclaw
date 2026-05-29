#!/usr/bin/env bash
cd "$(dirname "$0")/../.." && signalclaw run --today --notify --out data/reports/$(date +%F).md

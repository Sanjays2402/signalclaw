#!/usr/bin/env bash
set -e
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
echo "Activate with: source .venv/bin/activate"

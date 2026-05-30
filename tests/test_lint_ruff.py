"""Repo-wide lint gate.

The CI ``lint`` job runs ``ruff check .`` directly, but we also exercise
it from the test suite so local ``pytest`` runs and the cron-driven
issue-fixer agents catch regressions before push.

The test is a no-op (skipped) when ruff is not installed in the active
environment so it never blocks contributors who only installed runtime
deps.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_ruff_check_passes() -> None:
    ruff = shutil.which("ruff")
    if ruff is None:
        pytest.skip("ruff is not installed in this environment")

    result = subprocess.run(
        [ruff, "check", "."],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        "ruff check failed:\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )

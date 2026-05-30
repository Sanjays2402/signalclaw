"""Static checks on the production API container build.

These tests do not invoke `docker build`; they parse the Dockerfile so
they run in any CI environment (including ones without Docker) and catch
regressions in the hardening shape of the image: multi-stage, pinned base,
non-root runtime user, real wheel install (not editable), a HEALTHCHECK,
and tini as PID 1.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DOCKERFILE = Path(__file__).resolve().parent.parent / "infra" / "docker" / "Dockerfile.api"


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    assert DOCKERFILE.is_file(), f"missing {DOCKERFILE}"
    return DOCKERFILE.read_text(encoding="utf-8")


def test_dockerfile_is_multi_stage(dockerfile_text: str) -> None:
    stages = re.findall(r"^FROM\s+\S+\s+AS\s+(\w+)", dockerfile_text, flags=re.MULTILINE)
    assert "builder" in stages, "expected a builder stage"
    assert "runtime" in stages, "expected a runtime stage"
    assert len(stages) >= 2, f"expected >=2 named stages, got {stages}"


def test_dockerfile_runs_as_non_root(dockerfile_text: str) -> None:
    # USER must be set, and must not be root / uid 0.
    users = re.findall(r"^USER\s+(\S+)", dockerfile_text, flags=re.MULTILINE)
    assert users, "Dockerfile must declare a USER"
    last = users[-1]
    assert "root" not in last.lower(), f"runtime USER must not be root, got {last!r}"
    assert "0" not in last.split(":"), f"runtime USER must not be uid 0, got {last!r}"
    # And a system account should be provisioned explicitly.
    assert "useradd" in dockerfile_text, "expected an explicit useradd for the runtime account"


def test_dockerfile_has_healthcheck(dockerfile_text: str) -> None:
    assert "HEALTHCHECK" in dockerfile_text, "expected a HEALTHCHECK directive"
    assert "/health" in dockerfile_text, "healthcheck should probe /health"


def test_dockerfile_does_not_install_editable(dockerfile_text: str) -> None:
    # Editable installs in a prod image leak source layout and skip wheel
    # build hygiene. Verify we install the project, not `-e .`.
    assert not re.search(r"pip\s+install[^\n]*\s-e\s", dockerfile_text), (
        "production image must not use `pip install -e`"
    )
    assert re.search(r"pip\s+install\s+\.", dockerfile_text), (
        "expected a non-editable `pip install .` in the builder stage"
    )


def test_dockerfile_uses_tini_entrypoint(dockerfile_text: str) -> None:
    # tini gives uvicorn proper SIGTERM handling under k8s/docker.
    assert "tini" in dockerfile_text, "expected tini as PID 1"
    assert re.search(r'ENTRYPOINT\s*\[\s*"/usr/bin/tini"', dockerfile_text), (
        "ENTRYPOINT should invoke tini"
    )


def test_dockerignore_excludes_heavy_paths() -> None:
    di = DOCKERFILE.parent.parent.parent / ".dockerignore"
    assert di.is_file(), "missing .dockerignore at repo root"
    text = di.read_text(encoding="utf-8")
    for needed in (".venv/", "data/", ".git/", "__pycache__/"):
        assert needed in text, f".dockerignore missing {needed!r}"

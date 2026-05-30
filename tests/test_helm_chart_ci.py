"""Guard rails so the Helm chart hardening is actually gated in CI.

`tests/test_helm_chart.py` self-skips when the `helm` binary or PyYAML are
missing. That made the chart hardening checks effectively advisory on any
runner that did not happen to ship helm. The fix is a dedicated CI job
that installs both and runs the chart tests; these assertions make sure
that job stays wired so a future workflow edit cannot silently regress
the chart back to "lints clean in author's laptop, never gated".

The asserts here are intentionally structural (parse the workflow YAML
and look for the steps) instead of behavioural (running helm again),
because the chart tests in `test_helm_chart.py` already cover the
rendered manifests. This file's job is to fail loudly if someone deletes
the helm job from CI.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

try:
    import yaml
except Exception:  # pragma: no cover - yaml missing is environment-only
    yaml = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
CHART = ROOT / "infra" / "helm" / "signalclaw"


def _load_workflow() -> dict:
    assert WORKFLOW.is_file(), f"missing workflow at {WORKFLOW}"
    if yaml is None:  # pragma: no cover - exercised only in minimal envs
        pytest.skip("PyYAML not installed")
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_ci_defines_helm_job() -> None:
    wf = _load_workflow()
    jobs = wf.get("jobs", {})
    assert "helm" in jobs, "ci.yml must define a 'helm' job that gates the chart"


def test_helm_job_installs_helm_and_runs_chart_tests() -> None:
    wf = _load_workflow()
    steps = wf["jobs"]["helm"]["steps"]
    flat = "\n".join(
        " ".join(filter(None, [str(s.get("uses", "")), str(s.get("run", "")), str(s.get("name", ""))]))
        for s in steps
    )
    # Helm must actually be installed in the runner; otherwise the chart
    # tests will self-skip and silently let regressions through.
    assert "azure/setup-helm" in flat, "helm job must install Helm via azure/setup-helm"
    assert "helm lint" in flat, "helm job must run `helm lint` on the chart"
    assert "helm template" in flat, "helm job must render the chart"
    assert "test_helm_chart.py" in flat, "helm job must execute tests/test_helm_chart.py"
    # PyYAML is required by the chart tests; the test_helm_chart.py skip
    # branch must not be the only thing standing between us and a broken
    # chart in production.
    assert "pyyaml" in flat.lower(), "helm job must install PyYAML for chart tests"


def test_helm_job_checks_out_source() -> None:
    wf = _load_workflow()
    steps = wf["jobs"]["helm"]["steps"]
    assert any(s.get("uses", "").startswith("actions/checkout@") for s in steps), (
        "helm job must check out the repo before running helm against the chart"
    )


@pytest.mark.skipif(shutil.which("helm") is None, reason="helm not installed")
def test_helm_lint_passes_locally() -> None:
    # Mirror what the CI job runs so a contributor with helm on PATH
    # catches a chart regression before pushing.
    proc = subprocess.run(
        ["helm", "lint", str(CHART)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, f"helm lint failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"

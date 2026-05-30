"""Helm chart hardening checks for infra/helm/signalclaw.

These tests render the chart with `helm template` and assert that the
enterprise hardening invariants we promise in README "Operations" are
actually present: resource limits on every container, non-root pod
security context, dropped capabilities, read-only root filesystem,
HPAs / PDB / NetworkPolicy / PVC wired correctly when toggled, and
Sentry env vars threaded through to the api Deployment.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

try:  # PyYAML is a transitive dep, but guard for clean skips.
    import yaml
except Exception:  # pragma: no cover - yaml missing is environment-only
    yaml = None  # type: ignore[assignment]


CHART = Path(__file__).resolve().parents[1] / "infra" / "helm" / "signalclaw"

pytestmark = [
    pytest.mark.skipif(shutil.which("helm") is None, reason="helm not installed"),
    pytest.mark.skipif(yaml is None, reason="PyYAML not installed"),
]


def _render(*sets: str) -> list[dict]:
    cmd = ["helm", "template", "t", str(CHART)]
    for s in sets:
        cmd.extend(["--set", s])
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def _kinds(docs: list[dict]) -> list[str]:
    return [d.get("kind") for d in docs]


def _by(docs: list[dict], kind: str, name_contains: str = "") -> list[dict]:
    return [
        d
        for d in docs
        if d.get("kind") == kind
        and name_contains in (d.get("metadata", {}).get("name") or "")
    ]


def test_default_render_has_expected_kinds() -> None:
    docs = _render()
    kinds = _kinds(docs)
    assert "ServiceAccount" in kinds
    assert kinds.count("Deployment") == 2
    assert kinds.count("Service") == 2
    assert "Secret" in kinds
    # Toggled-off resources must not render by default.
    assert "HorizontalPodAutoscaler" not in kinds
    assert "PodDisruptionBudget" not in kinds
    assert "NetworkPolicy" not in kinds
    assert "Ingress" not in kinds
    assert "PersistentVolumeClaim" not in kinds


@pytest.mark.parametrize("component", ["api", "web"])
def test_every_container_has_resource_limits_and_hardening(component: str) -> None:
    docs = _render()
    dep = _by(docs, "Deployment", f"-{component}")[0]
    pod = dep["spec"]["template"]["spec"]

    psc = pod["securityContext"]
    assert psc["runAsNonRoot"] is True
    assert psc["runAsUser"] >= 1000
    assert psc["seccompProfile"]["type"] == "RuntimeDefault"

    assert pod["serviceAccountName"].endswith("-sa")

    for c in pod["containers"]:
        sc = c["securityContext"]
        assert sc["allowPrivilegeEscalation"] is False
        assert sc["readOnlyRootFilesystem"] is True
        assert sc["capabilities"]["drop"] == ["ALL"]

        res = c["resources"]
        assert "requests" in res and "cpu" in res["requests"] and "memory" in res["requests"]
        assert "limits" in res and "cpu" in res["limits"] and "memory" in res["limits"]


def test_api_deployment_has_probes_and_prometheus_scrape_annotation() -> None:
    docs = _render()
    dep = _by(docs, "Deployment", "-api")[0]
    container = dep["spec"]["template"]["spec"]["containers"][0]
    assert container["readinessProbe"]["httpGet"]["path"] == "/ready"
    assert container["livenessProbe"]["httpGet"]["path"] == "/health"

    ann = dep["spec"]["template"]["metadata"]["annotations"]
    assert ann["prometheus.io/scrape"] == "true"
    assert ann["prometheus.io/path"] == "/metrics"


def test_api_readonly_root_requires_writable_data_and_tmp_mounts() -> None:
    # readOnlyRootFilesystem=true would break the app without these volumes.
    docs = _render()
    dep = _by(docs, "Deployment", "-api")[0]
    container = dep["spec"]["template"]["spec"]["containers"][0]
    mount_paths = {m["mountPath"] for m in container.get("volumeMounts", [])}
    assert "/tmp" in mount_paths
    assert "/data" in mount_paths


def test_hpa_renders_with_cpu_and_memory_targets_when_enabled() -> None:
    docs = _render("api.autoscaling.enabled=true", "web.autoscaling.enabled=true")
    hpas = _by(docs, "HorizontalPodAutoscaler")
    assert len(hpas) == 2
    api_hpa = [h for h in hpas if h["metadata"]["name"].endswith("-api")][0]
    metric_types = {m["resource"]["name"] for m in api_hpa["spec"]["metrics"]}
    assert metric_types == {"cpu", "memory"}
    assert api_hpa["spec"]["minReplicas"] >= 1
    assert api_hpa["spec"]["maxReplicas"] >= api_hpa["spec"]["minReplicas"]


def test_pdb_renders_when_enabled() -> None:
    docs = _render("api.podDisruptionBudget.enabled=true")
    pdbs = _by(docs, "PodDisruptionBudget")
    assert len(pdbs) == 1
    assert pdbs[0]["spec"]["minAvailable"] == 1


def test_networkpolicy_locks_down_api_ingress_to_web_only() -> None:
    docs = _render("networkPolicy.enabled=true")
    nps = _by(docs, "NetworkPolicy", "-api")
    assert len(nps) == 1
    rule = nps[0]["spec"]["ingress"][0]
    web_selectors = [
        f for f in rule["from"]
        if f.get("podSelector", {}).get("matchLabels", {}).get("app", "").endswith("-web")
    ]
    assert web_selectors, "api ingress NetworkPolicy must allow only the web pod"
    assert "Egress" in nps[0]["spec"]["policyTypes"]


def test_sentry_env_vars_wired_to_api_container() -> None:
    docs = _render(
        "api.sentry.dsnSecret=sc-sentry",
        "api.sentry.environment=staging",
        "api.sentry.tracesSampleRate=0.25",
    )
    dep = _by(docs, "Deployment", "-api")[0]
    env = {e["name"]: e for e in dep["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["SENTRY_DSN"]["valueFrom"]["secretKeyRef"] == {
        "name": "sc-sentry",
        "key": "dsn",
    }
    assert env["SENTRY_ENVIRONMENT"]["value"] == "staging"
    assert env["SENTRY_TRACES_SAMPLE_RATE"]["value"] == "0.25"


def test_pvc_renders_and_is_referenced_when_persistence_enabled() -> None:
    docs = _render("api.persistence.enabled=true", "api.persistence.size=5Gi")
    pvcs = _by(docs, "PersistentVolumeClaim")
    assert len(pvcs) == 1
    assert pvcs[0]["spec"]["resources"]["requests"]["storage"] == "5Gi"

    dep = _by(docs, "Deployment", "-api")[0]
    data_vol = [
        v for v in dep["spec"]["template"]["spec"]["volumes"] if v["name"] == "data"
    ][0]
    assert data_vol["persistentVolumeClaim"]["claimName"].endswith("-api-data")

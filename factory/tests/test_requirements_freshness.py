from __future__ import annotations

import ast
import hashlib
import inspect
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "factory" / "scripts"))

import factory_lib
from forge_cli import phase, plans


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def head(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True,
        capture_output=True, text=True,
    ).stdout.strip()


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    files = {
        ".factory/state.json": "{}\n",
        "plans/roadmap.json": "{}\n",
        "docs/context/ledger.json": "{}\n",
        "docs/decisions/0001-test.md": "# Decision\n",
        "docs/specs/confirmed.md": "---\nstatus: confirmed\n---\n# Capability\n",
        "src/product.py": "VALUE = 1\n",
    }
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    git(root, "add", "-A")
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit",
        "-qm", "fixture")
    return root


def spec(repo: Path) -> Path:
    return repo / "docs" / "specs" / "confirmed.md"


def change_indexed(repo: Path, name: str, content: str) -> None:
    (repo / name).write_text(content, encoding="utf-8")
    git(repo, "add", name)


def legacy_requirements_digest(repo: Path) -> str:
    raw = spec(repo).read_bytes()
    body = raw.split(b"---\n", 2)[-1]
    tree = factory_lib.product_tree_digest(repo)
    return hashlib.sha256(body + b"\x00" + tree.encode("ascii")).hexdigest()


def test_requirements_digest_uses_the_shared_exclusion_definition(repo, monkeypatch):
    seen = {}

    def product_digest(_root, treeish="", exclude=(".factory/", "plans/")):
        seen["exclude"] = exclude
        return "a" * 64

    monkeypatch.setattr(factory_lib, "product_tree_digest", product_digest)
    factory_lib.requirements_digest(repo, spec(repo))

    assert set(seen["exclude"]) == set(factory_lib.product_excluded_prefixes(repo))


def test_a_decision_record_does_not_stale_the_requirements_gate(repo):
    recorded = factory_lib.requirements_digest(repo, spec(repo))
    change_indexed(repo, "docs/decisions/0002-new.md", "# Accepted decision\n")

    assert factory_lib.requirements_digest_matches(
        repo, spec(repo), recorded, head(repo),
    )


def test_the_context_ledger_does_not_stale_the_requirements_gate(repo):
    recorded = factory_lib.requirements_digest(repo, spec(repo))
    change_indexed(repo, "docs/context/ledger.json", '{"new": true}\n')

    assert factory_lib.requirements_digest_matches(
        repo, spec(repo), recorded, head(repo),
    )


def test_editing_the_confirmed_spec_still_stales_it(repo):
    recorded = factory_lib.requirements_digest(repo, spec(repo))
    spec(repo).write_text("---\nstatus: confirmed\n---\n# Changed capability\n")

    assert not factory_lib.requirements_digest_matches(
        repo, spec(repo), recorded, head(repo),
    )


def test_a_real_product_change_still_stales_it(repo):
    recorded = factory_lib.requirements_digest(repo, spec(repo))
    change_indexed(repo, "src/product.py", "VALUE = 2\n")

    assert not factory_lib.requirements_digest_matches(
        repo, spec(repo), recorded, head(repo),
    )


def test_a_pass_recorded_under_the_old_exclusions_is_still_accepted(repo):
    recorded = legacy_requirements_digest(repo)
    recorded_commit = head(repo)
    change_indexed(repo, "docs/decisions/0002-new.md", "# Accepted decision\n")
    change_indexed(repo, "docs/context/ledger.json", '{"new": true}\n')

    assert recorded != factory_lib.requirements_digest(repo, spec(repo))
    assert factory_lib.requirements_digest_matches(
        repo, spec(repo), recorded, recorded_commit,
    )


def test_both_consumers_resolve_freshness_through_the_helper():
    plan_gate = inspect.getsource(plans._require_matching_requirements_grill)
    phase_gate = inspect.getsource(phase.cmd_next)

    assert "requirements_digest_matches(" in plan_gate
    assert "requirements_digest_matches(" in phase_gate
    assert "requirements_digest(" not in plan_gate
    assert "requirements_digest(" not in phase_gate


def _grill_prefixes(path: Path) -> dict[str, tuple[str, ...]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    calls = {}
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "require_grill" and len(node.args) >= 3
                and isinstance(node.args[1], ast.Constant)):
            calls[node.args[1].value] = ast.literal_eval(node.args[2])
    return calls


def test_the_prefix_gates_and_pre_stage_task_grill_are_unchanged(
        repo, monkeypatch):
    prefixes = {}
    for relative in (
        "factory/scripts/record_signoff.py",
        "factory/scripts/forge_cli/specs.py",
        "factory/scripts/forge_cli/roadmap.py",
        "factory/scripts/forge_cli/plans.py",
    ):
        prefixes.update(_grill_prefixes(ROOT / relative))
    assert prefixes == {
        "signoff": ("docs/product/", "docs/decisions/", "docs/specs/",
                    "plans/roadmap.json", "prototype/"),
        "spec": ("docs/product/", "docs/decisions/", "docs/architecture/",
                 "prototype/"),
        "epics": ("docs/product/", "docs/decisions/"),
        "plan": ("docs/product/", "docs/decisions/", "docs/architecture/"),
    }

    (repo / "plan.md").write_text("# Approved plan\n", encoding="utf-8")
    monkeypatch.setattr(factory_lib, "load_json",
                        lambda *_args, **_kwargs: {"plan_file": "plan.md"})
    seen = {}

    def product_digest(_root, treeish="", exclude=(".factory/", "plans/")):
        seen["exclude"] = exclude
        return "b" * 64

    monkeypatch.setattr(factory_lib, "product_tree_digest", product_digest)
    factory_lib.grounding_digest(repo, {"id": "T1"})
    assert seen["exclude"] == factory_lib.harness_owned_prefixes()

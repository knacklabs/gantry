from __future__ import annotations

import json
import sys
from pathlib import Path

from test_gates import HARNESS, git, load_factory_lib, repo  # noqa: F401

sys.path.insert(0, str(HARNESS / "factory" / "scripts"))


def _seed(repo: Path) -> None:
    lib = load_factory_lib(repo)
    control = Path(git(repo, "rev-parse", "--absolute-git-dir")) / "forge"
    control.mkdir(parents=True, exist_ok=True)
    lib.dump_json(control / "run.json", {"issue_key": "ENG-1"})


def _lifecycle(repo: Path, launch_id: str, statuses: tuple[str, ...]) -> Path:
    from forge_cli.delegate import delegations_path  # noqa: E402

    path = delegations_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for index, status in enumerate(statuses):
            fh.write(json.dumps({
                "launch_id": launch_id,
                "task": "grill-plan",
                "at": f"2026-09-07T10:00:0{index}+00:00",
                "launch_status": status,
                "write": False,
            }) + "\n")
    return path


def _rounds(repo: Path) -> int:
    from forge_cli.grill import _rounds_since_last_pass  # noqa: E402

    return _rounds_since_last_pass(repo, "grill-plan", "plan", "")


def _repeat_read_is_refused(repo: Path) -> bool:
    from forge_cli.grill import _refuse_a_second_cold_read  # noqa: E402

    try:
        _refuse_a_second_cold_read(repo, "grill-plan", "plan", "", "")
    except SystemExit:
        return True
    return False


def test_a_failed_lifecycle_does_not_count_toward_the_cap(repo: Path):
    _seed(repo)
    _lifecycle(repo, "failed", ("starting", "running", "failed"))

    assert _rounds(repo) == 0


def test_a_failed_lifecycle_does_not_block_the_repeat_read_guard(repo: Path):
    _seed(repo)
    _lifecycle(repo, "failed", ("starting", "running", "failed"))

    assert not _repeat_read_is_refused(repo)


def test_a_succeeded_lifecycle_still_counts(repo: Path):
    _seed(repo)
    _lifecycle(repo, "succeeded", ("starting", "running", "succeeded"))

    assert _rounds(repo) == 1


def test_a_launch_still_in_flight_counts(repo: Path):
    _seed(repo)
    _lifecycle(repo, "starting", ("starting",))
    _lifecycle(repo, "running", ("running",))

    assert _rounds(repo) == 2


def test_both_guards_agree_on_the_same_collapsed_view(repo: Path, monkeypatch):
    _seed(repo)
    _lifecycle(repo, "failed", ("starting", "running", "failed"))
    _lifecycle(repo, "succeeded", ("starting", "running", "succeeded"))
    _lifecycle(repo, "starting", ("starting",))
    _lifecycle(repo, "running", ("running",))

    from forge_cli import grill  # noqa: E402

    original = grill._latest_launch_rows
    calls: list[tuple[Path, str, str]] = []

    def tracked(base: Path, ledger_id: str, since: str) -> list[dict]:
        calls.append((base, ledger_id, since))
        return original(base, ledger_id, since)

    monkeypatch.setattr(grill, "_latest_launch_rows", tracked)
    assert _rounds(repo) == 3
    assert _repeat_read_is_refused(repo)
    assert calls == [(repo, "grill-plan", ""), (repo, "grill-plan", "")]


def test_no_new_ledger_field_is_written(repo: Path):
    _seed(repo)
    path = _lifecycle(repo, "failed", ("starting", "running", "failed"))
    before = path.read_text(encoding="utf-8")

    assert _rounds(repo) == 0
    assert not _repeat_read_is_refused(repo)
    assert path.read_text(encoding="utf-8") == before
    assert all(set(json.loads(line)) == {
        "launch_id", "task", "at", "launch_status", "write",
    } for line in before.splitlines())
